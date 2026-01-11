// src/bot/tasks/responsibleRemindersWatcher.js
const pool = require("../../db/pool");
const { insertNotificationAndFanout } = require("../notifications");

function isoFromDate(d) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function fmtRuDate(iso) {
  const d = new Date(iso + "T00:00:00");
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  return `${dd}.${mm}.${yy}`;
}

// weekday mask bits: mon..sun
function weekdayBit(iso) {
  const d = new Date(iso + "T00:00:00");
  const js = d.getDay(); // 0=sun
  const map = {
    1: 1 << 0, // mon
    2: 1 << 1,
    3: 1 << 2,
    4: 1 << 3,
    5: 1 << 4,
    6: 1 << 5,
    0: 1 << 6, // sun
  };
  return map[js] ?? 0;
}

function daysBetween(isoA, isoB) {
  const a = new Date(isoA + "T00:00:00").getTime();
  const b = new Date(isoB + "T00:00:00").getTime();
  return Math.round((b - a) / 86400000);
}

function isOccurrenceOnDate(sched, iso) {
  const t = String(sched.schedule_type || "");
  if (t === "single") {
    return String(sched.single_date || "") === iso;
  }
  if (t === "weekly") {
    const mask = Number(sched.weekdays_mask || 0);
    return (mask & weekdayBit(iso)) !== 0;
  }
  if (t === "every_x_days") {
    const x = Number(sched.every_x_days || 0);
    const start = String(sched.start_date || "");
    if (!x || !start) return false;
    const diff = daysBetween(start, iso);
    return diff >= 0 && diff % x === 0;
  }
  return false;
}

async function ensureReminderSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS task_responsible_reminder_sends (
      assignment_id bigint NOT NULL REFERENCES task_assignments(id) ON DELETE CASCADE,
      for_date date NOT NULL,
      responsible_user_id bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      sent_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (assignment_id, for_date, responsible_user_id)
    )
  `);
}

async function loadOverridesMap(assignmentIds, fromISO, toISO) {
  if (!assignmentIds.length) return new Map();

  const r = await pool.query(
    `
    SELECT assignment_id, trade_point_id, from_date::text AS from_date, to_date::text AS to_date
    FROM task_schedule_overrides
    WHERE assignment_id = ANY($1::bigint[])
      AND (
        (from_date >= $2::date AND from_date <= $3::date)
        OR (to_date >= $2::date AND to_date <= $3::date)
      )
    `,
    [assignmentIds, fromISO, toISO]
  );

  // key: assignmentId|pointId -> { skip:Set, include:Set }
  const mp = new Map();
  for (const row of r.rows) {
    const key = `${row.assignment_id}|${row.trade_point_id}`;
    if (!mp.has(key)) mp.set(key, { skip: new Set(), include: new Set() });
    const obj = mp.get(key);
    obj.skip.add(String(row.from_date));
    obj.include.add(String(row.to_date));
  }
  return mp;
}

function applyOverrides(occursBySchedule, overrides, iso) {
  if (!overrides) return occursBySchedule;
  // if schedule says occurs but date is moved away => skip
  if (occursBySchedule && overrides.skip.has(iso)) return false;
  // if schedule doesn't occur but moved into this date => include
  if (!occursBySchedule && overrides.include.has(iso)) return true;
  return occursBySchedule;
}

async function runOnce({ logError } = {}) {
  try {
    await ensureReminderSchema();

    // берем только те задания по расписанию, где включены напоминания и days_before > 0
    const a = await pool.query(
      `
      SELECT
        a.id AS assignment_id,
        a.point_scope,
        a.trade_point_id,
        tp.title AS point_title,
        t.title,
        s.schedule_type,
        s.weekdays_mask,
        s.every_x_days,
        s.start_date::text AS start_date,
        s.single_date::text AS single_date,
        rs.days_before::int AS days_before
      FROM task_assignments a
      JOIN task_schedules s ON s.assignment_id = a.id
      JOIN task_templates t ON t.id = a.template_id
      LEFT JOIN trade_points tp ON tp.id = a.trade_point_id
      JOIN task_assignment_responsible_settings rs ON rs.assignment_id = a.id
      WHERE a.task_type IN ('global','individual')
        AND rs.notifications_enabled = TRUE
        AND rs.days_before IS NOT NULL
        AND rs.days_before::int > 0
      `
    );

    if (!a.rows.length) return;

    // ответственные (кому слать)
    const ids = a.rows.map((x) => Number(x.assignment_id));
    const respR = await pool.query(
      `
      SELECT r.assignment_id, r.user_id
      FROM task_assignment_responsibles r
      WHERE r.assignment_id = ANY($1::bigint[])
      `,
      [ids]
    );

    const respByA = new Map();
    for (const row of respR.rows) {
      const k = Number(row.assignment_id);
      if (!respByA.has(k)) respByA.set(k, []);
      respByA.get(k).push(Number(row.user_id));
    }

    // горизонт: max days_before, чтобы одним запросом подтянуть overrides
    const maxN = Math.max(...a.rows.map((x) => Number(x.days_before || 0)));
    const today = new Date();
    const todayISO = isoFromDate(today);
    const end = new Date(today.getTime() + maxN * 86400000);
    const endISO = isoFromDate(end);

    const overridesMap = await loadOverridesMap(ids, todayISO, endISO);

    // теперь считаем напоминания
    for (const row of a.rows) {
      const assignmentId = Number(row.assignment_id);
      const daysBefore = Number(row.days_before || 0);
      const recipients = respByA.get(assignmentId) || [];
      if (!recipients.length || daysBefore <= 0) continue;

      const horizonEnd = new Date(today.getTime() + daysBefore * 86400000);

      // в режиме all_points не используем overrides (иначе может быть спам по точкам)
      const hasPoint = row.point_scope === "one_point" && row.trade_point_id;
      const overrideKey = hasPoint ? `${assignmentId}|${row.trade_point_id}` : null;
      const ov = overrideKey ? overridesMap.get(overrideKey) : null;

      for (let i = 0; i <= daysBefore; i++) {
        const d = new Date(today.getTime() + i * 86400000);
        const forISO = isoFromDate(d);

        let occurs = isOccurrenceOnDate(row, forISO);
        occurs = applyOverrides(occurs, ov, forISO);

        if (!occurs) continue;

        // антиспам: пытаемся вставить маркер отправки, если уже есть — пропускаем
        for (const uid of recipients) {
          const ins = await pool.query(
            `
            INSERT INTO task_responsible_reminder_sends (assignment_id, for_date, responsible_user_id)
            VALUES ($1, $2::date, $3)
            ON CONFLICT DO NOTHING
            RETURNING assignment_id
            `,
            [assignmentId, forISO, uid]
          );
          if (!ins.rowCount) continue;

          const pointLine = hasPoint ? `\nТочка: <b>${String(row.point_title || row.trade_point_id)}</b>` : "";
          const text =
            `⏰ <b>Напоминание</b>\n` +
            `Задача: <b>${String(row.title)}</b>\n` +
            `Дата выполнения: <b>${fmtRuDate(forISO)}</b>` +
            pointLine;

          await insertNotificationAndFanout({
            createdBy: null,
            text,
            recipientUserIds: [uid],
          });
        }
      }
    }
  } catch (e) {
    if (logError) logError("responsibleRemindersWatcher", e);
  }
}

function startResponsibleRemindersWatcher({ intervalMs = 300_000, logError } = {}) {
  // первый запуск чуть позже старта, чтобы бот успел подняться
  setTimeout(() => {
    runOnce({ logError });
  }, 5_000);

  setInterval(() => {
    runOnce({ logError });
  }, intervalMs);
}

module.exports = { startResponsibleRemindersWatcher };
