// src/bot/admin/shiftTasks.schema.js
const pool = require("../../db/pool");

// -----------------------------
// SCHEMA / OVERRIDES (idempotent)
// -----------------------------
let __schemaEnsured = false;

async function ensureShiftTasksSchema() {
  if (__schemaEnsured) return;
  __schemaEnsured = true;

  // completion notifications toggle for responsibles
  try {
    await pool.query(`
      ALTER TABLE task_assignment_responsible_settings
      ADD COLUMN IF NOT EXISTS completion_notifications_enabled boolean DEFAULT TRUE
    `);
    await pool.query(`
      UPDATE task_assignment_responsible_settings
      SET completion_notifications_enabled = TRUE
      WHERE completion_notifications_enabled IS NULL
    `);
  } catch (_) {}

  // per-day overrides for scheduled tasks (move one occurrence without changing schedule)
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS task_schedule_overrides (
        assignment_id bigint NOT NULL REFERENCES task_assignments(id) ON DELETE CASCADE,
        trade_point_id bigint NOT NULL REFERENCES trade_points(id) ON DELETE CASCADE,
        from_date date NOT NULL,
        to_date date NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        PRIMARY KEY (assignment_id, trade_point_id, from_date)
      )
    `);
  } catch (_) {}
}


async function loadOverridesForDate(tradePointId, dateISO) {
  await ensureShiftTasksSchema();
  try {
    const r = await pool.query(
      `
      SELECT assignment_id, from_date::text AS from_date, to_date::text AS to_date
      FROM task_schedule_overrides
      WHERE trade_point_id = $1
        AND (from_date = $2::date OR to_date = $2::date)
      `,
      [tradePointId, dateISO]
    );

    const skip = new Set();
    const include = new Set();
    for (const row of r.rows) {
      const aid = Number(row.assignment_id);
      if (!aid) continue;
      if (row.from_date === dateISO) skip.add(aid);
      if (row.to_date === dateISO) include.add(aid);
    }
    return { skip, include };
  } catch (_) {
    return { skip: new Set(), include: new Set() };
  }
}


async function dbTodayISO() {
  const r = await pool.query(`SELECT CURRENT_DATE::text AS d`);
  return r.rows[0].d; // 'YYYY-MM-DD' в таймзоне БД
}


function fmtRuDate(iso) {
  const d = new Date(iso + "T00:00:00");
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}`;
}


function parseAnyDateToISO(input) {
  const s = String(input || "").trim();
  if (!s) return null;

  // YYYY-MM-DD
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;

  // DD.MM.YYYY
  const ru = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})$/);
  if (ru) {
    const dd = ru[1].padStart(2, "0");
    const mm = ru[2].padStart(2, "0");
    return `${ru[3]}-${mm}-${dd}`;
  }

  // DD.MM (текущий год)
  const ruShort = s.match(/^(\d{1,2})\.(\d{1,2})$/);
  if (ruShort) {
    const year = new Date().getFullYear();
    const dd = ruShort[1].padStart(2, "0");
    const mm = ruShort[2].padStart(2, "0");
    return `${year}-${mm}-${dd}`;
  }

  return null;
}


function fmtShortDate(v) {
  if (!v) return "";
  const d = v instanceof Date ? v : new Date(v);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}`;
}


function fmtShortDateYY(v) {
  if (!v) return "";
  const d = v instanceof Date ? v : new Date(v);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  return `${dd}.${mm}.${yy}`;
}


function nextScheduleDate(r, from = new Date()) {
  // считаем "следующий день" строго ПОСЛЕ сегодняшнего
  const base = new Date(from);
  base.setHours(0, 0, 0, 0);
  base.setDate(base.getDate() + 1);

  if (r.schedule_type === "single") {
    if (!r.single_date) return null;
    const d = new Date(r.single_date);
    d.setHours(0, 0, 0, 0);
    return d >= base ? d : null;
  }

  if (r.schedule_type === "every_x_days") {
    if (!r.start_date || !r.every_x_days) return null;
    const start = new Date(r.start_date);
    start.setHours(0, 0, 0, 0);
    const step = Number(r.every_x_days) || 1;

    // если start уже после base
    if (start >= base) return start;

    const diffDays = Math.floor((base - start) / (24 * 3600 * 1000));
    const k = Math.ceil(diffDays / step);
    const next = new Date(start);
    next.setDate(start.getDate() + k * step);
    return next;
  }

  if (r.schedule_type === "weekly") {
    const mask = Number(r.weekdays_mask) || 0;

    // маппинг как в scheduleLabel: пн=1, вт=2, ср=4, чт=8, пт=16, сб=32, вс=64
    const jsDayToBit = (jsDay) => {
      // JS: 0 вс ... 6 сб
      if (jsDay === 1) return 1; // пн
      if (jsDay === 2) return 2; // вт
      if (jsDay === 3) return 4; // ср
      if (jsDay === 4) return 8; // чт
      if (jsDay === 5) return 16; // пт
      if (jsDay === 6) return 32; // сб
      return 64; // вс (0)
    };

    for (let i = 0; i < 21; i++) {
      const d = new Date(base);
      d.setDate(base.getDate() + i);
      const bit = jsDayToBit(d.getDay());
      if (mask & bit) return d;
    }
    return null;
  }

  return null;
}


function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}


function weekdayBit(dateObj) {
  const js = dateObj.getDay(); // 0=Sun..6=Sat
  if (js === 0) return 1 << 6;
  return 1 << (js - 1);
}


function toISODate(v) {
  if (!v) return null;

  // pg DATE может прийти строкой "YYYY-MM-DD"
  if (typeof v === "string") return v.slice(0, 10);

  // иногда pg парсит DATE как Date (в зависимости от настроек типов)
  // ВАЖНО: нельзя использовать toISOString(), потому что это UTC и может сместить день назад.
  if (v instanceof Date) {
    const y = v.getFullYear();
    const m = String(v.getMonth() + 1).padStart(2, "0");
    const d = String(v.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  return String(v).slice(0, 10);
}


function scheduleMatchesDate(row, dateISO) {
  const dateObj = new Date(dateISO + "T00:00:00");

  if (row.schedule_type === "single") {
    return toISODate(row.single_date) === dateISO;
  }

  if (row.schedule_type === "weekly") {
    const bit = weekdayBit(dateObj);
    const mask = Number(row.weekdays_mask || 0);
    return (mask & bit) !== 0;
  }

  if (row.schedule_type === "every_x_days") {
    const x = Number(row.every_x_days || 0);
    if (!x || !row.start_date) return false;

    const startISO = toISODate(row.start_date);
    if (!startISO) return false;

    const start = new Date(startISO + "T00:00:00");
    const diffMs = dateObj.getTime() - start.getTime();
    const diffDays = Math.floor(diffMs / (24 * 3600 * 1000));
    return diffDays >= 0 && diffDays % x === 0;
  }

  return false;
}


function normalizeTime(s) {
  const t = String(s || "").trim();
  const m = t.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = Number(m[1]);
  const mm = Number(m[2]);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}


module.exports = {
  ensureShiftTasksSchema,
  loadOverridesForDate,

  dbTodayISO,
  fmtRuDate,
  parseAnyDateToISO,
  fmtShortDate,
  fmtShortDateYY,

  nextScheduleDate,
  escHtml,
  weekdayBit,
  toISODate,
  scheduleMatchesDate,
  normalizeTime,
};
