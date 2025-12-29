// src/bot/cashDiffAlerts.js
const pool = require("../db/pool");

/**
 * kind в responsible_assignments
 * если у тебя другое значение — поменяй тут
 */
const KIND = "cash_diff";

async function getThresholds() {
  // ожидаем 1 строку с настройками
  // (если у тебя хранится по-другому — поменяем запрос)
  const r = await pool.query(`
    SELECT
      shortage_threshold::numeric AS shortage_threshold,
      surplus_threshold::numeric  AS surplus_threshold
    FROM cash_diff_settings
    ORDER BY id DESC
    LIMIT 1
  `);

  const row = r.rows[0] || {};
  const shortage = Number(row.shortage_threshold ?? 0);
  const surplus = Number(row.surplus_threshold ?? 0);

  return { shortage, surplus };
}

async function getCashDiffResponsibles(tradePointId) {
  // trade_point_id может быть NULL для "все точки"
  const r = await pool.query(
    `
    SELECT u.id, u.full_name, u.username, u.work_phone
    FROM responsible_assignments ra
    JOIN users u ON u.id = ra.user_id
    WHERE ra.is_active = TRUE
      AND ra.kind = $1
      AND (ra.trade_point_id = $2 OR ra.trade_point_id IS NULL)
    ORDER BY u.full_name NULLS LAST, u.id ASC
    `,
    [KIND, tradePointId]
  );
  return r.rows || [];
}

function fmtMoney(v) {
  if (v === null || v === undefined) return "—";
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return n.toLocaleString("ru-RU");
}

function buildPerson(u) {
  const name = u.full_name || "—";
  const at = u.username ? `@${u.username}` : null;
  const phone = u.work_phone || null;
  return `${name}${at ? ` (${at})` : phone ? ` (${phone})` : ""}`;
}

async function insertNotificationForUsers(userIds, text, createdBy) {
  if (!userIds.length) return;

  const n = await pool.query(
    `INSERT INTO notifications (text, created_by) VALUES ($1,$2) RETURNING id`,
    [text, createdBy || null]
  );
  const nid = n.rows[0].id;

  // fanout
  const values = userIds.map((_, i) => `($1, $${i + 2})`).join(",");
  await pool.query(
    `INSERT INTO user_notifications (notification_id, user_id) VALUES ${values}`,
    [nid, ...userIds]
  );
}

/**
 * stage:
 *  - "open"  => сравниваем shifts.cash_amount vs предыдущий конец смены по точке
 *  - "close" => сравниваем cash_in_drawer vs expected_end_cash (opening + cash_sales - cash_collection)
 */
async function checkCashDiffAndNotify({ shiftId, stage, actorUserId }) {
  // берем базовые данные смены
  const s = await pool.query(
    `
    SELECT
      s.id,
      s.user_id,
      s.trade_point_id,
      s.opened_at,
      s.cash_amount AS opening_cash,
      tp.title AS point_title,
      u.full_name AS worker_name,
      u.username AS worker_username,
      u.work_phone AS worker_phone
    FROM shifts s
    JOIN trade_points tp ON tp.id = s.trade_point_id
    JOIN users u ON u.id = s.user_id
    WHERE s.id = $1
    LIMIT 1
    `,
    [shiftId]
  );
  const shift = s.rows[0];
  if (!shift || !shift.trade_point_id) return;

  const { shortage, surplus } = await getThresholds();
  if (!shortage && !surplus) return; // пороги не заданы

  const responsibles = await getCashDiffResponsibles(shift.trade_point_id);
  const respIds = responsibles.map((x) => Number(x.id)).filter(Boolean);
  if (!respIds.length) return;

  // ===== stage OPEN =====
  if (stage === "open") {
    // предыдущая закрытая смена на этой точке (берем последнюю по finished_at/closed_at)
    const prev = await pool.query(
      `
      SELECT sc.cash_in_drawer
      FROM shifts ps
      JOIN shift_closings sc ON sc.shift_id = ps.id AND sc.deleted_at IS NULL
      WHERE ps.trade_point_id = $1
        AND ps.status = 'closed'
        AND ps.id <> $2
      ORDER BY ps.closed_at DESC NULLS LAST, ps.finished_at DESC NULLS LAST, ps.id DESC
      LIMIT 1
      `,
      [shift.trade_point_id, shiftId]
    );

    const prevEnd = prev.rows[0]?.cash_in_drawer;
    const opening = shift.opening_cash;

    if (opening == null || prevEnd == null) return; // нечего сравнивать

    const diff = Number(opening) - Number(prevEnd);

    const isShortage = diff < 0 && Math.abs(diff) > shortage;
    const isSurplus = diff > 0 && diff > surplus;

    if (!isShortage && !isSurplus) return;

    const sign = diff > 0 ? "➕" : "❗";
    const diffStr =
      diff > 0 ? `+${fmtMoney(diff)}` : `-${fmtMoney(Math.abs(diff))}`;

    const text =
      `${sign} *Отклонение кассы при открытии смены*\n\n` +
      `Точка: *${shift.point_title}*\n` +
      `Смена: *${shift.id}*\n` +
      `Сотрудник: *${shift.worker_name || "—"}*` +
      `${shift.worker_username ? ` (@${shift.worker_username})` : ""}\n\n` +
      `Касса на конец прошлой смены: *${fmtMoney(prevEnd)} ₽*\n` +
      `Касса на открытии: *${fmtMoney(opening)} ₽*\n` +
      `Разница: *${diffStr} ₽*`;

    await insertNotificationForUsers(
      respIds,
      text,
      actorUserId || shift.user_id
    );
    return;
  }

  // ===== stage CLOSE =====
  if (stage === "close") {
    const c = await pool.query(
      `
      SELECT
        sc.sales_cash,
        sc.cash_in_drawer,
        sc.was_cash_collection,
        sc.cash_collection_amount,
        sc.cash_collection_by_user_id,
        u2.full_name AS collector_name,
        u2.username  AS collector_username
      FROM shift_closings sc
      LEFT JOIN users u2 ON u2.id = sc.cash_collection_by_user_id
      WHERE sc.shift_id = $1
        AND sc.deleted_at IS NULL
      LIMIT 1
      `,
      [shiftId]
    );
    const cl = c.rows[0];
    if (!cl) return;

    const opening = shift.opening_cash;
    const salesCash = cl.sales_cash;
    const inDrawer = cl.cash_in_drawer;

    if (opening == null || salesCash == null || inDrawer == null) return;

    const cashCollection = cl.was_cash_collection
      ? Number(cl.cash_collection_amount || 0)
      : 0;

    const expected =
      Number(opening) + Number(salesCash) - Number(cashCollection);
    const diff = Number(inDrawer) - Number(expected); // >0 излишек, <0 недостача

    const isShortage = diff < 0 && Math.abs(diff) > shortage;
    const isSurplus = diff > 0 && diff > surplus;

    if (!isShortage && !isSurplus) return;

    const sign = diff > 0 ? "➕" : "❗";
    const diffStr =
      diff > 0 ? `+${fmtMoney(diff)}` : `-${fmtMoney(Math.abs(diff))}`;

    const collector =
      cl.collector_name ||
      (cl.collector_username ? `@${cl.collector_username}` : null);

    const text =
      `${sign} *Отклонение кассы при закрытии смены*\n\n` +
      `Точка: *${shift.point_title}*\n` +
      `Смена: *${shift.id}*\n` +
      `Сотрудник: *${shift.worker_name || "—"}*` +
      `${shift.worker_username ? ` (@${shift.worker_username})` : ""}\n\n` +
      `Открытие (в кассе): *${fmtMoney(opening)} ₽*\n` +
      `Наличные продажи: *${fmtMoney(salesCash)} ₽*\n` +
      `Инкассация: *${
        cl.was_cash_collection ? fmtMoney(cashCollection) : "Нет"
      }*${collector ? ` (${collector})` : ""}\n` +
      `Ожидалось в кассе: *${fmtMoney(expected)} ₽*\n` +
      `Факт в кассе: *${fmtMoney(inDrawer)} ₽*\n` +
      `Разница: *${diffStr} ₽*`;

    await insertNotificationForUsers(
      respIds,
      text,
      actorUserId || shift.user_id
    );
    return;
  }
}

module.exports = { checkCashDiffAndNotify };
module.exports.default = { checkCashDiffAndNotify };
