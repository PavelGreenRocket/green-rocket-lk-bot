// src/bot/uncompletedAlerts.js
const { Markup } = require("telegraf");
const pool = require("../db/pool");
const { insertNotificationAndFanout } = require("./notifications");

const CAT_UNCOMPLETED = "[[uncompleted_tasks]]";

async function getResponsibles(tradePointId) {
  const r = await pool.query(
    `
    SELECT u.id, u.telegram_id, u.full_name
    FROM  responsible_assignments r
    JOIN users u ON u.id = r.user_id
    WHERE r.trade_point_id = $1
      AND r.kind = 'uncompleted_tasks'
      AND r.is_active = true
      AND u.telegram_id IS NOT NULL
    ORDER BY u.full_name
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
     AND ti.for_date = (s.opened_at AT TIME ZONE 'UTC')::date
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
      (s.opened_at AT TIME ZONE 'UTC')::date AS for_date,
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

  // 2) text
  let text =
    `⚠️ ${CAT_UNCOMPLETED}\n` +
    `*Смена закрыта с невыполненными задачами*\n\n` +
    `Точка: *${shift.point_title}*\n` +
    `Дата: *${String(shift.for_date)}*\n\n` +
    `Сотрудник: *${shift.worker_name || "—"}*\n` +
    `Тел: ${shift.worker_phone || "—"}\n` +
    `Username: ${
      shift.worker_username ? `@${shift.worker_username}` : "—"
    }\n\n` +
    `Невыполнено:\n`;

  items.forEach((t, i) => {
    const tag = t.schedule_type === "single" ? "разовая" : "по расписанию";
    text += `${i + 1}. ${t.title} (${tag})\n`;
  });

  // 3) store as notification (for "Пользовательские → Невыполненные задачи")
  await insertNotificationAndFanout({
    createdBy: null, // "system-like", but still in Пользовательские мы фильтруем по тексту; оставляем NULL? нельзя — тогда уйдёт в "system".
    // поэтому делаем createdBy = 1? нет. Правильнее: createdBy = some admin? нет.
    // здесь делаем "user-kind": created_by НЕ NULL. Используем отправителя = сотрудник, закрывший смену.
    createdBy: Number(shift.user_id),
    text,
    recipientUserIds: responsibles.map((r) => r.id),
  });

  // 4) push message with buttons (optional, но у тебя это просили)
  const kb = [];
  if (singleIds.length) {
    kb.push([
      Markup.button.callback("📅 Перенести", `lk_uncompl_move_${shiftId}`),
      Markup.button.callback("🗑 Удалить", `lk_uncompl_del_${shiftId}`),
    ]);
  }
  const extra = kb.length
    ? { ...Markup.inlineKeyboard(kb), parse_mode: "Markdown" }
    : { parse_mode: "Markdown" };

  for (const r of responsibles) {
    await bot.telegram.sendMessage(r.telegram_id, text, extra).catch(() => {});
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

    // load rows to clone
    const rows = await client.query(
      `
      SELECT assignment_id, template_id, user_id, trade_point_id, time_mode, deadline_at, status
      FROM task_instances
      WHERE id = ANY($1::bigint[])
      `,
      [singleIds]
    );

    for (const t of rows.rows) {
      await client.query(
        `
        INSERT INTO task_instances
          (assignment_id, template_id, user_id, trade_point_id, for_date, time_mode, deadline_at, status, created_at, done_at)
        VALUES
          ($1,$2,$3,$4,$5,$6,$7,'open',NOW(),NULL)
        ON CONFLICT (assignment_id, user_id, for_date) DO NOTHING
        `,
        [
          t.assignment_id,
          t.template_id,
          t.user_id,
          t.trade_point_id,
          targetDate,
          t.time_mode,
          t.deadline_at,
        ]
      );
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
