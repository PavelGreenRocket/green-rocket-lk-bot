// src/bot/uncompletedAlerts.js
const { Markup } = require("telegraf");
const pool = require("../db/pool");
const { insertNotificationAndFanout } = require("./notifications");

const CAT_UNCOMPLETED = "[[uncompleted_tasks]]";

function formatIsoDateRu(iso) {
  // iso: 'YYYY-MM-DD'
  if (!iso || typeof iso !== "string" || iso.length < 10)
    return String(iso || "—");
  const [y, m, d] = iso.slice(0, 10).split("-");
  return `${d}.${m}.${y}`;
}

async function getResponsibles(tradePointId) {
  const r = await pool.query(
    `
  SELECT DISTINCT u.id, u.telegram_id
  FROM responsible_assignments r
  JOIN users u ON u.id = r.user_id
  WHERE r.kind = 'uncompleted_tasks'
    AND r.is_active = true
    AND (
      r.trade_point_id = $1
      OR r.trade_point_id IS NULL
    )
  `,
    [tradePointId]
  );

  return r.rows.map((x) => ({
    id: Number(x.id),
    telegram_id: Number(x.telegram_id),
  }));
}

async function getOpenTasksForShift(shiftId) {
  const r = await pool.query(
    `
    SELECT
      ti.id,
      ti.assignment_id,
      ti.template_id,
      ti.user_id,
      ti.trade_point_id,
      ti.for_date,
      ti.status,
      tt.title,
      ts.schedule_type
    FROM shifts s
    JOIN task_instances ti
      ON ti.user_id = s.user_id
     AND ti.trade_point_id = s.trade_point_id
     AND ti.for_date = CURRENT_DATE
    JOIN task_templates tt ON tt.id = ti.template_id
    LEFT JOIN task_schedules ts ON ts.assignment_id = ti.assignment_id
    WHERE s.id = $1
      AND ti.status = 'open'
    ORDER BY ti.id
    `,
    [shiftId]
  );

  const items = r.rows.map((x) => ({
    id: Number(x.id),
    title: x.title,
    schedule_type: x.schedule_type || null,
  }));

  const singleIds = items
    .filter((x) => x.schedule_type === "single")
    .map((x) => x.id);

  return { items, singleIds };
}

async function createAlert(bot, { shiftId }) {
  // 1) load shift info
  const s = await pool.query(
    `
    SELECT
      s.id,
      s.user_id,
      s.trade_point_id,
      to_char((s.opened_at AT TIME ZONE 'UTC')::date, 'YYYY-MM-DD') AS for_date_iso,
      u.full_name AS worker_name,
      u.work_phone AS worker_phone,
      u.username AS worker_username,
      tp.title AS point_title
    FROM shifts s
    JOIN users u ON u.id = s.user_id
    JOIN trade_points tp ON tp.id = s.trade_point_id
    WHERE s.id = $1
    `,
    [shiftId]
  );
  const shift = s.rows[0];
  if (!shift) return;

  const { items, singleIds } = await getOpenTasksForShift(shiftId);
  if (!items.length) return;

  const responsibles = await getResponsibles(Number(shift.trade_point_id));
  if (!responsibles.length) return;

  // дата в RU
  const d = new Date(`${shift.for_date_iso}T00:00:00Z`);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yyyy = String(d.getFullYear());
  const dateRu = `${dd}.${mm}.${yyyy}`;

  // красивый текст для сообщения
  let msgText =
    `⚠️ *Смена закрыта с невыполненными задачами*\n\n` +
    `Точка: *${shift.point_title}*\n` +
    `Дата: *${dateRu}*\n\n` +
    `Сотрудник: *${shift.worker_name || "—"}*\n` +
    `Тел: ${shift.worker_phone || "—"}\n` +
    `Username: ${
      shift.worker_username ? `@${shift.worker_username}` : "—"
    }\n\n` +
    `Невыполнено:\n`;

  items.forEach((t, i) => {
    const tag = t.schedule_type === "single" ? "разовая" : "по расписанию";
    msgText += `${i + 1}. ${t.title} (${tag})\n`;
  });

  // текст для БД (с тегом категории)
  const dbText = `${CAT_UNCOMPLETED}\n${msgText}`;

  // store notification (для истории в "Пользовательские → Невыполненные задачи")
  await insertNotificationAndFanout({
    createdBy: Number(shift.user_id),
    text: dbText,
    recipientUserIds: responsibles.map((r) => r.id),
  });

  // keyboard for Telegram push
  const kb = [];
  if (singleIds.length) {
    kb.push([
      Markup.button.callback("📅 Перенести", `lk_uncompl_move_${shiftId}`),
      Markup.button.callback(
        "🧩 Удалить часть",
        `lk_uncompl_delpart_${shiftId}`
      ),
    ]);
    kb.push([
      Markup.button.callback("🗑 Удалить все", `lk_uncompl_del_${shiftId}`),
    ]);
  }

  const extra = kb.length
    ? { ...Markup.inlineKeyboard(kb), parse_mode: "Markdown" }
    : { parse_mode: "Markdown" };

  // send once
  for (const r of responsibles) {
    await bot.telegram
      .sendMessage(r.telegram_id, msgText, extra)

      .catch(() => {});
  }
}

async function moveSingleTasksToDate(shiftId, targetDate) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { singleIds } = await getOpenTasksForShift(shiftId);
    if (!singleIds.length) {
      await client.query("COMMIT");
      return 0;
    }

    // исходная дата (на которой сейчас висят эти разовые задачи)
    const info = await client.query(
      `
      SELECT DISTINCT for_date::text AS for_date_iso
      FROM task_instances
      WHERE id = ANY($1::bigint[])
      `,
      [singleIds]
    );
    const fromDate = info.rows?.[0]?.for_date_iso;
    if (!fromDate) {
      await client.query("COMMIT");
      return 0;
    }

    // 1) удаляем те инстансы, которые при переносе конфликтуют с уже существующими на targetDate
    await client.query(
      `
      DELETE FROM task_instances ti
      USING task_instances existing
      WHERE ti.id = ANY($1::bigint[])
        AND existing.assignment_id = ti.assignment_id
        AND existing.user_id = ti.user_id
        AND existing.for_date = $2::date
      `,
      [singleIds, targetDate]
    );

    // 2) переносим оставшиеся (которые не конфликтуют)
    const upd = await client.query(
      `
      UPDATE task_instances
      SET for_date = $2::date
      WHERE id = ANY($1::bigint[])
      `,
      [singleIds, targetDate]
    );

    // 3) переносим single schedule, чтобы генератор НЕ создавал их снова на старую дату
    const asg = await client.query(
      `
      SELECT DISTINCT assignment_id
      FROM task_instances
      WHERE for_date = $1::date
        AND id = ANY($2::bigint[])
      `,
      [targetDate, singleIds]
    );
    const assignmentIds = asg.rows.map((r) => r.assignment_id);

    // ⚠️ assignmentIds может быть пустым, если все перенесённые были удалены из-за конфликтов.
    // В этом случае всё равно переносим schedule по "исходным assignment_id" с исходных инстансов:
    const asgAll = await client.query(
      `
      SELECT DISTINCT assignment_id
      FROM task_instances
      WHERE id = ANY($1::bigint[])
      `,
      [singleIds]
    );
    const assignmentIdsAll = asgAll.rows.map((r) => r.assignment_id);

    const idsToMove = assignmentIdsAll.length
      ? assignmentIdsAll
      : assignmentIds;

    if (idsToMove.length) {
      await client.query(
        `
        UPDATE task_schedules
        SET single_date = $2::date
        WHERE assignment_id = ANY($1::bigint[])
          AND schedule_type = 'single'
          AND single_date = $3::date
        `,
        [idsToMove, targetDate, fromDate]
      );
    }

    await client.query("COMMIT");

    // сколько реально уехало = rowCount UPDATE (удалённые из-за конфликтов считаем как “перенос не нужен”)
    return Number(upd.rowCount || 0);
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function deleteSingleTasks(shiftId) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { singleIds } = await getOpenTasksForShift(shiftId);
    if (!singleIds.length) {
      await client.query("COMMIT");
      return 0;
    }

    await client.query(
      `DELETE FROM task_instances WHERE id = ANY($1::bigint[])`,
      [singleIds]
    );

    await client.query("COMMIT");
    return singleIds.length;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

module.exports = {
  createAlert,
  moveSingleTasksToDate,
  deleteSingleTasks,
};
