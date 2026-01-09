// src/bot/admin/shiftTasks.js
const { Markup } = require("telegraf");
const pool = require("../../db/pool");
const { deliver } = require("../../utils/renderHelpers");

// локальное состояние (не FSM в БД, а in-memory как в других админ-модулях)
const stByTg = new Map();

const WD = [
  { key: "mon", label: "Пн", bit: 1 << 0 },
  { key: "tue", label: "Вт", bit: 1 << 1 },
  { key: "wed", label: "Ср", bit: 1 << 2 },
  { key: "thu", label: "Чт", bit: 1 << 3 },
  { key: "fri", label: "Пт", bit: 1 << 4 },
  { key: "sat", label: "Сб", bit: 1 << 5 },
  { key: "sun", label: "Вс", bit: 1 << 6 },
];

function isAdmin(user) {
  return user && (user.role === "admin" || user.role === "super_admin");
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

async function searchUsersForWho(query, forwardFromTgId = null) {
  if (forwardFromTgId) {
    const r = await pool.query(
      `SELECT id, full_name, username, work_phone FROM users WHERE telegram_id = $1 LIMIT 10`,
      [forwardFromTgId]
    );
    return r.rows;
  }

  const q = String(query || "").trim();
  if (!q) return [];

  // @username
  const u = q.startsWith("@") ? q.slice(1) : null;
  if (u) {
    const r = await pool.query(
      `
        SELECT id, full_name, username, work_phone
        FROM users
        WHERE lower(username) = lower($1)
        ORDER BY id DESC
        LIMIT 10
      `,
      [u]
    );
    return r.rows;
  }

  // phone (digits >= 5)
  const digits = q.replace(/\D/g, "");
  if (digits.length >= 5) {
    const r = await pool.query(
      `
        SELECT id, full_name, username, work_phone
        FROM users
        WHERE regexp_replace(coalesce(work_phone, ''), '\\D', '', 'g') LIKE '%' || $1 || '%'
        ORDER BY id DESC
        LIMIT 10
      `,
      [digits]
    );
    return r.rows;
  }

  // name search
  const r = await pool.query(
    `
      SELECT id, full_name, username, work_phone
      FROM users
      WHERE full_name ILIKE '%' || $1 || '%'
         OR username ILIKE '%' || $1 || '%'
      ORDER BY full_name NULLS LAST, id DESC
      LIMIT 10
    `,
    [q]
  );
  return r.rows;
}

function formatUserLabel(u) {
  const name = u.full_name || u.username || String(u.id);
  const uname = u.username ? `@${u.username}` : "";
  return `${name}${uname ? " (" + uname + ")" : ""}`;
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

// weekday bit: Mon=1<<0 ... Sun=1<<6
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

function getSt(tgId) {
  return stByTg.get(tgId) || null;
}
function setSt(tgId, patch) {
  const prev = getSt(tgId) || {
    step: "pick_point",
    pointId: null,
    dateISO: null, // установим при входе из dbTodayISO()

    filter: "all", // all | scheduled
    mode: "view", // view | add | delete | edit_period
    add: {
      answerType: "button", // button|photo|video|number|text
      scheduleType: "single", // single|weekly|every_x_days
      weekdaysMask: 0,
      everyXDays: null,
      timeMode: "all_day", // all_day|deadline
      deadlineTime: null,
    },
    deleteSelected: [],
    editPickId: null,
  };
  stByTg.set(tgId, { ...prev, ...patch });
}
function clearSt(tgId) {
  stByTg.delete(tgId);
}

async function loadPoints() {
  const r = await pool.query(
    `
    SELECT id, title
    FROM trade_points
    WHERE is_active = TRUE
    ORDER BY id
    `
  );
  return r.rows;
}

async function getPointActiveShiftInfo(pointId) {
  const r = await pool.query(
    `
    SELECT s.id, u.full_name AS opener_name
    FROM shifts s
    LEFT JOIN users u ON u.id = s.user_id
    WHERE s.trade_point_id = $1
      AND s.opened_at::date = CURRENT_DATE
      AND s.status IN ('opening_in_progress','opened')
    ORDER BY s.opened_at DESC
    LIMIT 1
    `,
    [pointId]
  );

  if (!r.rows.length) return { isActive: false, openerName: null };
  return { isActive: true, openerName: r.rows[0].opener_name || null };
}

async function loadAssignmentsForPoint(pointId) {
  const r = await pool.query(
    `
    SELECT
      a.id AS assignment_id,
      a.task_type,
      a.point_scope,
      a.trade_point_id,
      a.is_active,
      a.created_by_user_id,
      u.full_name AS creator_name,
      s.schedule_type,
      s.start_date,
      s.single_date,
      s.weekdays_mask,
      s.every_x_days,
      s.time_mode,
      s.deadline_time,
      t.title,
      t.answer_type
    FROM task_assignments a
    JOIN task_schedules s ON s.assignment_id = a.id
    JOIN task_templates t ON t.id = a.template_id
    LEFT JOIN users u ON u.id = a.created_by_user_id
   WHERE a.task_type = 'global'

      AND (
        a.point_scope = 'all_points'
        OR (a.point_scope = 'one_point' AND a.trade_point_id = $1)
      )
    ORDER BY a.id ASC
    `,
    [pointId]
  );
  return r.rows;
}

async function loadDoneInfoMap(pointId, dateISO, assignmentIds) {
  if (!assignmentIds.length) return new Map();

  const r = await pool.query(
    `
    SELECT DISTINCT ON (ti.assignment_id)
      ti.assignment_id,
      ti.id AS task_instance_id,
      ti.user_id AS done_by_user_id,
      ti.done_at,
      u.full_name AS done_by_name,
      u.username AS done_by_username,
      u.work_phone AS done_by_phone,
      ans.answer_text,
      ans.answer_number,
      ans.file_id,
      ans.file_type
    FROM task_instances ti
    LEFT JOIN users u ON u.id = ti.user_id
    LEFT JOIN LATERAL (
      SELECT answer_text, answer_number, file_id, file_type
      FROM task_instance_answers
      WHERE task_instance_id = ti.id
      ORDER BY created_at DESC
      LIMIT 1
    ) ans ON TRUE
    WHERE ti.trade_point_id = $1
      AND ti.for_date = $2
      AND ti.status = 'done'
      AND ti.assignment_id = ANY($3::bigint[])
    ORDER BY ti.assignment_id, ti.done_at DESC NULLS LAST
    `,
    [pointId, dateISO, assignmentIds]
  );

  const map = new Map();
  for (const row of r.rows) {
    map.set(Number(row.assignment_id), row);
  }
  return map;
}

function typeEmoji(answerType) {
  if (answerType === "photo") return "📷";
  if (answerType === "video") return "🎥";
  if (answerType === "number") return "🔢";
  if (answerType === "text") return "📝";
  return "✅"; // button / обычный
}

function scheduleMark(scheduleType) {
  return scheduleType === "single" ? "①" : "⏰";
}

function scheduleLabel(r) {
  if (!r) return "";

  if (r.schedule_type === "single") {
    return "разовая";
  }

  if (r.schedule_type === "weekly") {
    const days = [];
    const map = [
      ["пн", 1],
      ["вт", 2],
      ["ср", 4],
      ["чт", 8],
      ["пт", 16],
      ["сб", 32],
      ["вс", 64],
    ];
    for (const [label, bit] of map) {
      if (r.weekdays_mask & bit) days.push(label);
    }
    return days.join(", ");
  }

  if (r.schedule_type === "every_x_days") {
    const start = fmtShortDate(r.start_date);
    return `каждые ${r.every_x_days} дн.${start ? ` (с ${start})` : ""}`;
  }

  return "";
}

function timeLabel(r) {
  if ((r.time_mode || "all_day") === "deadline")
    return `до ${r.deadline_time || "??:??"}`;
  return "в течение дня";
}

async function buildDatePicker(dateISO) {
  // 61 день: 30 дней назад .. сегодня .. 30 дней вперёд (в таймзоне БД)
  const r = await pool.query(`
    SELECT (CURRENT_DATE + offs)::text AS d
    FROM generate_series(-30, 30) AS offs
  `);

  const btns = r.rows.map(({ d }) => {
    const label = (d === dateISO ? "✅ " : "") + fmtRuDate(d);
    return Markup.button.callback(label, `admin_shift_tasks_date_${d}`);
  });

  const rows = [];
  for (let i = 0; i < btns.length; i += 2) {
    rows.push(btns.slice(i, i + 2));
  }

  rows.push([
    Markup.button.callback("✍️ Ввести дату", "admin_shift_tasks_date_input"),
  ]);
  rows.push([
    Markup.button.callback("⬅️ Назад", "admin_shift_tasks_point_back"),
  ]);

  return Markup.inlineKeyboard(rows);
}

function buildTasksText(
  pointTitle,
  dateISO,
  shiftInfo,
  items,
  mode,
  deleteSelectedIds,
  doneMap
) {
  let text = `📋 <b>Задачи смены</b>\n\n`;
  text += `• Точка: <b>${escHtml(pointTitle)}</b>\n`;

  if (shiftInfo?.isActive) {
    const who = shiftInfo.openerName
      ? ` (${escHtml(shiftInfo.openerName)})`
      : "";
    text += `• Смена: <b>активна${who}</b> ✅\n\n`;
  } else {
    text += `• Смена: <b>не активна</b> ⚪️\n\n`;
  }

  // Режим удаления — отдельная плашка
  if (mode === "delete") {
    text += `🗑 <b>РЕЖИМ УДАЛЕНИЯ!</b>\n\n`;
  }

  // Дата теперь в заголовке списка
  text += `<u><b>Список задач на ${escHtml(fmtRuDate(dateISO))}:</b></u>\n`;

  if (!items.length) {
    text += `На эту дату задач нет.\n`;
    return text;
  }

  const selectedSet = new Set((deleteSelectedIds || []).map(Number));

  items.forEach((r, idx) => {
    const n = idx + 1;
    const mark = scheduleMark(r.schedule_type);

    const doneInfo = doneMap?.get(Number(r.assignment_id));
    const isDone = !!doneInfo;

    const statusMark = isDone ? "✅" : "▫️";
    const who =
      isDone && doneInfo.done_by_name
        ? ` (${escHtml(doneInfo.done_by_name)})`
        : "";
    const op = ` /t${n}`;

    const printableTitle = selectedSet.has(Number(r.assignment_id))
      ? `<s>${escHtml(r.title)}</s>`
      : escHtml(r.title);

    if (mode === "delete") {
      text += `${n}. ${mark} ${printableTitle}\n`;
    } else {
      text += `${statusMark} ${mark} ${printableTitle}${who}${op}\n`;
    }
  });

  // Подсказка в режиме удаления
  if (mode === "delete") {
    text += `\nНажимайте номера задач (❌), затем «Удалить».\n`;
  }

  return text;
}

function trunc(s, n = 28) {
  const t = String(s || "");
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

function buildMainKeyboard(st, items) {
  const rows = [];

  rows.push([
    Markup.button.callback(
      `➕ Добавить задачу на ${fmtRuDate(st.dateISO)}`,
      "admin_shift_tasks_add"
    ),
  ]);
  rows.push([
    Markup.button.callback(
      "📅 Выбрать другую дату",
      "admin_shift_tasks_pick_date"
    ),
  ]);
  rows.push([
    Markup.button.callback("🗑 Удалить задачу", "admin_shift_tasks_delete"),
  ]);

  // ⚙️ теперь не фильтр даты, а отдельный режим управления расписанием
  rows.push([
    Markup.button.callback(
      "⚙️ Задачи по расписанию",
      "admin_shift_tasks_sched_root"
    ),
  ]);

  rows.push([
    Markup.button.callback(
      "⬅️ К выбору точки",
      "admin_shift_tasks_back_to_points"
    ),
  ]);

  return Markup.inlineKeyboard(rows);
}

function buildAddKeyboard(st) {
  const a = st.add;

  const typeLabel =
    a.answerType === "photo"
      ? "фото"
      : a.answerType === "video"
      ? "видео"
      : a.answerType === "number"
      ? "число"
      : a.answerType === "text"
      ? "текст"
      : "обычный";

  const periodLabel =
    a.scheduleType === "single"
      ? "разовая"
      : a.scheduleType === "weekly"
      ? `по дням (${maskToWeekdays(a.weekdaysMask) || "не выбрано"})`
      : a.scheduleType === "every_x_days"
      ? `каждые ${a.everyXDays || "?"} дней`
      : a.scheduleType;

  const timeLabel =
    a.timeMode === "deadline" ? `до ${a.deadlineTime || "??:??"}` : "нет";

  const whoLabel = a.forUserId
    ? `👤 Для кого? (${a.forUserName || "выбран"})`
    : "👥 Для кого? (все)";

  const rows = [
    [
      Markup.button.callback(
        `▾ Тип ответа (${typeLabel})`,
        "admin_shift_tasks_add_type"
      ),
    ],
    [
      Markup.button.callback(
        `▾ Периодичность (${periodLabel})`,
        "admin_shift_tasks_add_period"
      ),
    ],
    [Markup.button.callback(whoLabel, "admin_shift_tasks_add_forwho")],
    [
      Markup.button.callback(
        `⏱ Ограничение по времени (${timeLabel})`,
        "admin_shift_tasks_add_time"
      ),
    ],
    [Markup.button.callback("✅ Готово", "admin_shift_tasks_add_done")],
    [Markup.button.callback("❌ Отмена", "admin_shift_tasks_add_cancel")],
  ];

  return Markup.inlineKeyboard(rows);
}

async function renderScheduledList(ctx, user) {
  const st = getSt(ctx.from.id);
  if (!st?.pointId) return renderPickPoint(ctx);

  const pRes = await pool.query(
    `SELECT id, title FROM trade_points WHERE id=$1 LIMIT 1`,
    [st.pointId]
  );
  const point = pRes.rows[0];
  if (!point) return;

  const all = await loadAssignmentsForPoint(st.pointId);
  const scheduled = all.filter((r) => r.schedule_type !== "single");

  let text = `⚙️ <b>Задачи по расписанию</b>\n\n`;
  text += `• Точка: <b>${escHtml(point.title)}</b>\n\n`;

  if (!scheduled.length) {
    text += `Пока нет задач по расписанию.\n`;
  } else {
    text += `<b>Список задач:</b>\n`;
    scheduled.forEach((r, idx) => {
      const n = idx + 1;
      const creator = r.creator_name ? ` (${r.creator_name})` : "";
      const on = r.is_active ? "" : " (выключена)";
      text += `${n}. ⏰ ${escHtml(r.title)}${escHtml(creator)}${on}\n`;
    });
  }

  const rows = [];

  if (scheduled.length) {
    const btns = scheduled.map((r, idx) =>
      Markup.button.callback(
        `${idx + 1}`,
        `admin_shift_tasks_sched_card_${r.assignment_id}`
      )
    );
    for (let i = 0; i < btns.length; i += 5) rows.push(btns.slice(i, i + 5));
  }

  rows.push([
    Markup.button.callback("⬅️ Назад", "admin_shift_tasks_point_redraw"),
  ]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(rows) },
    { edit: true }
  );
}

function maskToWeekdays(mask) {
  const on = WD.filter((d) => (mask & d.bit) !== 0).map((d) => d.label);
  return on.join(", ");
}

function buildAnswerTypePicker(st) {
  const a = st.add;
  const rows = [
    [
      Markup.button.callback(
        "▴ Тип ответа (свернуть)",
        "admin_shift_tasks_add_type_close"
      ),
    ],
    [
      Markup.button.callback(
        `${a.answerType === "photo" ? "✅ " : ""}фото`,
        "admin_shift_tasks_add_type_set_photo"
      ),
      Markup.button.callback(
        `${a.answerType === "video" ? "✅ " : ""}видео`,
        "admin_shift_tasks_add_type_set_video"
      ),
    ],
    [
      Markup.button.callback(
        `${a.answerType === "number" ? "✅ " : ""}число`,
        "admin_shift_tasks_add_type_set_number"
      ),
      Markup.button.callback(
        `${a.answerType === "text" ? "✅ " : ""}текст`,
        "admin_shift_tasks_add_type_set_text"
      ),
    ],
    [
      Markup.button.callback(
        `${a.answerType === "button" ? "✅ " : ""}обычный`,
        "admin_shift_tasks_add_type_set_button"
      ),
    ],
  ];
  return Markup.inlineKeyboard(rows);
}

function buildPeriodPicker(st) {
  const rows = [
    [
      Markup.button.callback(
        "▴ Периодичность (свернуть)",
        "admin_shift_tasks_add_period_close"
      ),
    ],
    [
      Markup.button.callback(
        "по дням недели",
        "admin_shift_tasks_add_period_weekly"
      ),
    ],
    [
      Markup.button.callback(
        "каждые x дней",
        "admin_shift_tasks_add_period_everyx"
      ),
    ],
    [Markup.button.callback("разовая", "admin_shift_tasks_add_period_single")],
  ];
  return Markup.inlineKeyboard(rows);
}

function buildWeekdaysPicker(mask, backCb = "admin_shift_tasks_add_period") {
  const rows = [
    [
      Markup.button.callback(
        "▴ Дни недели (свернуть)",
        "admin_shift_tasks_add_weekdays_close"
      ),
    ],
  ];

  for (const d of WD) {
    const on = (mask & d.bit) !== 0;
    rows.push([
      Markup.button.callback(
        `${on ? "✅ " : ""}${d.label}`,
        `admin_shift_tasks_add_weekdays_toggle_${d.key}`
      ),
    ]);
  }
  rows.push([Markup.button.callback("⬅️ Назад", backCb)]);
  return Markup.inlineKeyboard(rows);
}

function buildDeleteKeyboard(items, selectedIds) {
  const rows = [];

  if (items.length) {
    const btns = items.map((r, idx) => {
      const sel = selectedIds.includes(Number(r.assignment_id));
      return Markup.button.callback(
        `${sel ? "❌" : ""}${idx + 1}`,
        `admin_shift_tasks_del_toggle_${r.assignment_id}`
      );
    });
    for (let i = 0; i < btns.length; i += 5) rows.push(btns.slice(i, i + 5));
  }

  rows.push([
    Markup.button.callback("🗑 Удалить", "admin_shift_tasks_del_apply"),
  ]);
  rows.push([
    Markup.button.callback("⬅️ Назад", "admin_shift_tasks_point_redraw"),
  ]);
  return Markup.inlineKeyboard(rows);
}

function buildSchedFilterKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "Поменять периодичность",
        "admin_shift_tasks_sched_edit_period"
      ),
    ],
    [Markup.button.callback("Назад", "admin_shift_tasks_sched_back")],
  ]);
}

function buildEditPeriodPickKeyboard(items) {
  const rows = [];

  if (items.length) {
    const btns = items.map((r, idx) =>
      Markup.button.callback(
        `${idx + 1}`,
        `admin_shift_tasks_edit_pick_${r.assignment_id}`
      )
    );
    for (let i = 0; i < btns.length; i += 5) rows.push(btns.slice(i, i + 5));
  }

  rows.push([
    Markup.button.callback("⬅️ Назад", "admin_shift_tasks_sched_back"),
  ]);
  return Markup.inlineKeyboard(rows);
}

function buildEditPeriodOptionsKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "по дням недели",
        "admin_shift_tasks_edit_set_weekly"
      ),
    ],
    [
      Markup.button.callback(
        "каждые x дней",
        "admin_shift_tasks_edit_set_everyx"
      ),
    ],
    [
      Markup.button.callback(
        "разовая (на выбранную дату)",
        "admin_shift_tasks_edit_set_single"
      ),
    ],
    [Markup.button.callback("⬅️ Назад", "admin_shift_tasks_sched_back")],
  ]);
}

async function sendNewTasksNotification(
  pointId,
  dateISO,
  createdTitles,
  adminUserId
) {
  // уведомляем только если дата=сегодня
  const today = await dbTodayISO();
  if (dateISO !== today) return;

  // кому: все у кого активная смена сегодня на этой точке
  const uRes = await pool.query(
    `
    SELECT DISTINCT user_id
    FROM shifts
    WHERE trade_point_id = $1
      AND opened_at::date = CURRENT_DATE
      AND status IN ('opening_in_progress','opened')
    `,
    [pointId]
  );
  const userIds = uRes.rows.map((r) => Number(r.user_id)).filter(Boolean);
  if (!userIds.length) return;

  const list = createdTitles.map((t, i) => `${i + 1}. ${t}`).join("\n");
  const text = `📋 <b>Новые задачи на смену</b>\n\n${escHtml(list)}`;

  const nRes = await pool.query(
    `
    INSERT INTO notifications (text, created_by)
    VALUES ($1, $2)
    RETURNING id
    `,
    [text, adminUserId]
  );
  const nid = nRes.rows[0]?.id;
  if (!nid) return;

  for (const uid of userIds) {
    await pool.query(
      `
      INSERT INTO user_notifications (user_id, notification_id, is_read)
      VALUES ($1, $2, false)
      `,
      [uid, nid]
    );
  }
}

async function renderPointScreen(ctx, adminUser) {
  const st = getSt(ctx.from.id);
  if (!st.dateISO) {
    const today = await dbTodayISO();
    setSt(ctx.from.id, { dateISO: today });
  }

  if (!st?.pointId) return;

  const pRes = await pool.query(
    `SELECT id, title FROM trade_points WHERE id = $1 LIMIT 1`,
    [st.pointId]
  );
  const point = pRes.rows[0];
  if (!point) {
    await ctx
      .answerCbQuery("Точка не найдена", { show_alert: true })
      .catch(() => {});
    return;
  }

  const shiftInfo = await getPointActiveShiftInfo(st.pointId).catch(() => ({
    isActive: false,
    openerName: null,
  }));

  const all = await loadAssignmentsForPoint(st.pointId);

  // в основном экране показываем только активные (удалённые/выключенные скрываем)
  const allActive = all.filter((r) => r.is_active === true);

  // матчим на дату
  const matched = allActive.filter((r) => scheduleMatchesDate(r, st.dateISO));

  // сортировка: сначала разовые, потом расписание
  const singles = matched.filter((r) => r.schedule_type === "single");
  const sched = matched.filter((r) => r.schedule_type !== "single");
  let items = [...singles, ...sched];

  // фильтр
  if (st.filter === "scheduled")
    items = items.filter((r) => r.schedule_type !== "single");

  // запоминаем порядок для /tN
  setSt(ctx.from.id, {
    opAssignments: items.map((x) => Number(x.assignment_id)),
  });
  const assignmentIds = items.map((x) => Number(x.assignment_id));
  const doneMap = await loadDoneInfoMap(st.pointId, st.dateISO, assignmentIds);

  const text = buildTasksText(
    point.title,
    st.dateISO,
    shiftInfo,
    items,
    st.mode,
    st.deleteSelected,
    doneMap
  );

  let keyboard;
  if (st.mode === "add") {
    keyboard = buildAddKeyboard(st);
  } else if (st.mode === "delete") {
    keyboard = buildDeleteKeyboard(items, st.deleteSelected || []);
  } else if (st.mode === "edit_period") {
    keyboard = buildEditPeriodPickKeyboard(items);
  } else if (st.filter === "scheduled") {
    keyboard = buildSchedFilterKeyboard();
  } else {
    keyboard = buildMainKeyboard(st, items);
  }

  await deliver(ctx, { text, extra: keyboard }, { edit: true });
}

async function renderPickPoint(ctx) {
  const points = await loadPoints();
  const rows = points.map((p) => [
    Markup.button.callback(`🏬 ${p.title}`, `admin_shift_tasks_point_${p.id}`),
  ]);
  rows.push([Markup.button.callback("⬅️ В админ-меню", "lk_admin_menu")]);

  await deliver(
    ctx,
    {
      text: "📋 <b>Задачи смены</b>\n\nВыберите торговую точку:",
      extra: Markup.inlineKeyboard(rows),
    },
    { edit: true }
  );
}

async function renderScheduledCard(ctx, user, assignmentId) {
  const r = await pool.query(
    `
    SELECT
      a.id AS assignment_id,
      a.is_active,
      a.created_by_user_id,
      u.full_name AS creator_name,
      u.username AS creator_username,
u.work_phone AS creator_phone,
      s.schedule_type,
      s.start_date,
      s.weekdays_mask,
      s.every_x_days,
      s.time_mode,
      s.deadline_time,
        s.single_date,
      t.title,
      t.answer_type
    FROM task_assignments a
    JOIN task_schedules s ON s.assignment_id = a.id
    JOIN task_templates t ON t.id = a.template_id
    LEFT JOIN users u ON u.id = a.created_by_user_id
    WHERE a.id = $1
    LIMIT 1
    `,
    [assignmentId]
  );

  const row = r.rows[0];
  if (!row) {
    await ctx.answerCbQuery("Не найдено", { show_alert: true }).catch(() => {});
    return renderScheduledList(ctx, user);
  }

  const creator = row.creator_name ? ` (${row.creator_name})` : "";
  const status = row.is_active ? "включена ✅" : "выключена ⚪️";

  let text = `⚙️ <b>Задача по расписанию</b>\n\n`;
  text += `Задача: <b>${escHtml(row.title)}</b>\n`;

  // создатель отдельной строкой
  const creatorParts = [];
  if (row.creator_name) creatorParts.push(escHtml(row.creator_name));
  if (row.creator_username)
    creatorParts.push(`@${escHtml(row.creator_username)}`);
  if (row.creator_phone) creatorParts.push(escHtml(row.creator_phone));
  text += `Создал задачу: <b>${
    creatorParts.length ? creatorParts.join(" / ") : "—"
  }</b>\n`;

  text += `Статус: <b>${status}</b>\n`;
  text += `Периодичность: <b>${escHtml(scheduleLabel(row))}</b>\n`;

  // следующий день выполнения
  const nextD = nextScheduleDate(row);
  text += `Следующий день выполнения: <b>${
    nextD ? fmtShortDateYY(nextD) : "—"
  }</b>\n`;

  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "🔁 Поменять периодичность",
        `admin_shift_tasks_sched_period_${row.assignment_id}`
      ),
    ],
    [
      Markup.button.callback(
        "👥/👤 Пользователи задачи",
        `admin_shift_tasks_sched_users_${row.assignment_id}`
      ),
    ],
    [
      Markup.button.callback(
        row.is_active ? "⛔ Выключить" : "✅ Включить",
        `admin_shift_tasks_sched_toggle_${row.assignment_id}`
      ),
    ],
    [
      Markup.button.callback(
        "🗑 Удалить",
        `admin_shift_tasks_sched_delete_${row.assignment_id}`
      ),
    ],
    [Markup.button.callback("⬅️ Назад", "admin_shift_tasks_sched_root")],
  ]);

  await deliver(ctx, { text, extra: kb }, { edit: true });
}

async function renderSchedUsersScreenA(ctx, assignmentId) {
  const rr = await pool.query(
    `
    SELECT u.id, u.full_name, u.username, u.work_phone
    FROM task_assignment_targets tat
    JOIN users u ON u.id = tat.user_id
    WHERE tat.assignment_id = $1
    ORDER BY u.full_name NULLS LAST, u.username NULLS LAST, u.id
    `,
    [assignmentId]
  );

  const selected = rr.rows; // если пусто -> "для всех"

  let text = `👥/👤 <b>Пользователи задачи</b>\n\n`;
  const rows = [];

  if (!selected.length) {
    text += `Сейчас: <b>для всех</b>\n`;
  } else {
    text += `Выбраны пользователи (нажмите чтобы удалить):\n`;
    selected.forEach((u, idx) => {
      const parts = [];
      if (u.full_name) parts.push(u.full_name);
      if (u.username) parts.push(`@${u.username}`);
      if (u.work_phone) parts.push(u.work_phone);
      rows.push([
        Markup.button.callback(
          `✅ ${idx + 1}. ${parts.join(" / ")}`,
          `admin_shift_tasks_sched_users_rm_confirm_${assignmentId}_${u.id}`
        ),
      ]);
    });
  }

  rows.push([
    Markup.button.callback(
      "➕ Добавить пользователя",
      `admin_shift_tasks_sched_users_add_${assignmentId}_p1`
    ),
  ]);

  if (selected.length) {
    rows.push([
      Markup.button.callback(
        "👥 Сделать для всех",
        `admin_shift_tasks_sched_users_all_${assignmentId}`
      ),
    ]);
  }

  rows.push([
    Markup.button.callback(
      "⬅️ Назад",
      `admin_shift_tasks_sched_card_${assignmentId}`
    ),
  ]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(rows) },
    { edit: true }
  );
}

async function renderSchedUsersScreenB(ctx, assignmentId, page, query) {
  const limit = 10;
  const p = Math.max(1, Number(page) || 1);
  const offset = (p - 1) * limit;

  const sel = await pool.query(
    `SELECT user_id FROM task_assignment_targets WHERE assignment_id = $1`,
    [assignmentId]
  );
  const selectedSet = new Set(sel.rows.map((r) => Number(r.user_id)));

  const q = (query || "").trim();
  const qq = q.startsWith("@") ? q.slice(1) : q;

  let where = "";
  const params = [];
  if (qq) {
    where = `WHERE (username IS NOT NULL AND username ILIKE $1)
          OR (full_name IS NOT NULL AND full_name ILIKE $1)
          OR (work_phone IS NOT NULL AND work_phone ILIKE $1)`;
    params.push(`%${qq}%`);
  }

  const list = await pool.query(
    `
    SELECT id, full_name, username, work_phone
    FROM users
    ${where}
    ORDER BY full_name NULLS LAST, username NULLS LAST, id
    LIMIT ${limit} OFFSET ${offset}
    `,
    params
  );

  let text =
    `👤 <b>Добавить пользователей</b>\n\n` +
    `Для быстрого поиска введите @username, телефон или часть имени.\n` +
    `Можно также переслать сообщение пользователя.\n\n`;

  if (qq) text += `Фильтр: <b>${escHtml(q)}</b>\n\n`;

  const rows = [];

  if (!list.rows.length) {
    text += `Ничего не найдено.\n`;
  } else {
    list.rows.forEach((u) => {
      const parts = [];
      if (u.full_name) parts.push(u.full_name);
      if (u.username) parts.push(`@${u.username}`);
      if (u.work_phone) parts.push(u.work_phone);

      const mark = selectedSet.has(Number(u.id)) ? "✅ " : "";
      rows.push([
        Markup.button.callback(
          `${mark}${parts.join(" / ") || `id:${u.id}`}`,
          `admin_shift_tasks_sched_users_toggle_${assignmentId}_${u.id}_p${p}`
        ),
      ]);
    });
  }

  // пагинация
  const nav = [];
  if (p > 1)
    nav.push(
      Markup.button.callback(
        "⬅️",
        `admin_shift_tasks_sched_users_add_${assignmentId}_p${p - 1}`
      )
    );
  nav.push(Markup.button.callback(`стр. ${p}`, "noop"));
  nav.push(
    Markup.button.callback(
      "➡️",
      `admin_shift_tasks_sched_users_add_${assignmentId}_p${p + 1}`
    )
  );
  rows.push(nav);

  rows.push([
    Markup.button.callback(
      "⬅️ Назад",
      `admin_shift_tasks_sched_users_${assignmentId}`
    ),
  ]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(rows) },
    { edit: true }
  );

  // сохраняем состояние поиска (чтобы text handler знал куда применять)
  setSt(ctx.from.id, {
    step: "sched_users_search",
    schedUsers: { assignmentId, page: p },
  });
}

async function renderCreateUsersScreenA(ctx) {
  const st = getSt(ctx.from.id);
  const ids = (st?.add?.targetUserIds || []).map(Number);

  let text = `👥/👤 <b>Пользователи задачи</b>\n\n`;
  const rows = [];

  if (!ids.length) {
    text += `Сейчас: <b>для всех</b>\n`;
  } else {
    const rr = await pool.query(
      `
      SELECT id, full_name, username, work_phone
      FROM users
      WHERE id = ANY($1::int[])
      ORDER BY full_name NULLS LAST, username NULLS LAST, id
      `,
      [ids]
    );

    text += `Выбраны пользователи (нажмите чтобы удалить):\n`;
    rr.rows.forEach((u, idx) => {
      const parts = [];
      if (u.full_name) parts.push(u.full_name);
      if (u.username) parts.push(`@${u.username}`);
      if (u.work_phone) parts.push(u.work_phone);

      rows.push([
        Markup.button.callback(
          `✅ ${idx + 1}. ${parts.join(" / ")}`,
          `admin_shift_tasks_add_users_rm_confirm_${u.id}`
        ),
      ]);
    });
  }

  rows.push([
    Markup.button.callback(
      "➕ Добавить пользователя",
      "admin_shift_tasks_add_users_add_p1"
    ),
  ]);

  if (ids.length) {
    rows.push([
      Markup.button.callback(
        "👥 Сделать для всех",
        "admin_shift_tasks_add_users_all"
      ),
    ]);
  }

  rows.push([Markup.button.callback("⬅️ Назад", "admin_shift_tasks_add_back")]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(rows) },
    { edit: true }
  );
}

async function renderCreateUsersScreenB(ctx, page, query) {
  const st = getSt(ctx.from.id);
  if (!st?.add) return;

  const selectedSet = new Set((st.add.targetUserIds || []).map(Number));

  const limit = 10;
  const p = Math.max(1, Number(page) || 1);
  const offset = (p - 1) * limit;

  const q = (query || "").trim();
  const qq = q.startsWith("@") ? q.slice(1) : q;

  let where = "";
  const params = [];
  if (qq) {
    where = `WHERE (username IS NOT NULL AND username ILIKE $1)
          OR (full_name IS NOT NULL AND full_name ILIKE $1)
          OR (work_phone IS NOT NULL AND work_phone ILIKE $1)`;
    params.push(`%${qq}%`);
  }

  const list = await pool.query(
    `
    SELECT id, full_name, username, work_phone
    FROM users
    ${where}
    ORDER BY full_name NULLS LAST, username NULLS LAST, id
    LIMIT ${limit} OFFSET ${offset}
    `,
    params
  );

  let text =
    `👤 <b>Добавить пользователей</b>\n\n` +
    `Для быстрого поиска введите @username, телефон или часть имени.\n` +
    `Можно также переслать сообщение пользователя.\n\n`;

  if (qq) text += `Фильтр: <b>${escHtml(q)}</b>\n\n`;

  const rows = [];

  list.rows.forEach((u) => {
    const parts = [];
    if (u.full_name) parts.push(u.full_name);
    if (u.username) parts.push(`@${u.username}`);
    if (u.work_phone) parts.push(u.work_phone);

    const mark = selectedSet.has(Number(u.id)) ? "✅ " : "";
    rows.push([
      Markup.button.callback(
        `${mark}${parts.join(" / ") || `id:${u.id}`}`,
        `admin_shift_tasks_add_users_toggle_${u.id}_p${p}`
      ),
    ]);
  });

  const nav = [];
  if (p > 1)
    nav.push(
      Markup.button.callback("⬅️", `admin_shift_tasks_add_users_add_p${p - 1}`)
    );
  nav.push(Markup.button.callback(`стр. ${p}`, "noop"));
  nav.push(
    Markup.button.callback("➡️", `admin_shift_tasks_add_users_add_p${p + 1}`)
  );
  rows.push(nav);

  rows.push([
    Markup.button.callback("⬅️ Назад", "admin_shift_tasks_add_forwho"),
  ]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(rows) },
    { edit: true }
  );

  setSt(ctx.from.id, {
    step: "create_users_search",
    createUsers: { page: p },
    createUsersQuery: q,
  });
}

function registerAdminShiftTasks(bot, ensureUser, logError) {
  // -----------------------------
  // SCHEDULE USERS (targets)
  // -----------------------------
  async function renderSchedUsers(ctx, user, assignmentId) {
    const r = await pool.query(
      `
    SELECT u.id, u.full_name, u.username, u.work_phone
    FROM task_assignment_targets tat
    JOIN users u ON u.id = tat.user_id
    WHERE tat.assignment_id = $1
    ORDER BY u.full_name NULLS LAST, u.username NULLS LAST, u.id
    `,
      [assignmentId]
    );

    let text = `👥/👤 <b>Пользователи задачи</b>\n\n`;

    if (!r.rows.length) {
      text += `Сейчас: <b>для всех</b>\n`;
    } else {
      text += `Сейчас выбраны:\n`;
      r.rows.forEach((u, idx) => {
        const parts = [];
        if (u.full_name) parts.push(escHtml(u.full_name));
        if (u.username) parts.push(`@${escHtml(u.username)}`);
        if (u.work_phone) parts.push(escHtml(u.work_phone));
        text += `${idx + 1}. ${parts.join(" / ")}\n`;
      });
    }

    const rows = [];

    if (r.rows.length) {
      // кнопки удаления каждого выбранного
      const delBtns = r.rows.map((u, idx) =>
        Markup.button.callback(
          `❌ ${idx + 1}`,
          `admin_shift_tasks_sched_users_rm_${assignmentId}_${u.id}`
        )
      );
      for (let i = 0; i < delBtns.length; i += 6)
        rows.push(delBtns.slice(i, i + 6));

      rows.push([
        Markup.button.callback(
          "👥 Сделать для всех",
          `admin_shift_tasks_sched_users_all_${assignmentId}`
        ),
      ]);
    }

    rows.push([
      Markup.button.callback(
        "➕ Добавить пользователя",
        `admin_shift_tasks_sched_users_add_${assignmentId}`
      ),
    ]);

    rows.push([
      Markup.button.callback(
        "⬅️ Назад",
        `admin_shift_tasks_sched_card_${assignmentId}`
      ),
    ]);

    const kb = Markup.inlineKeyboard(rows);
    await deliver(ctx, { text, extra: kb }, { edit: true });
  }

  bot.action(/^admin_shift_tasks_sched_users_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const assignmentId = Number(ctx.match[1]);
      await renderSchedUsersScreenA(ctx, assignmentId);
    } catch (e) {
      logError("admin_shift_tasks_sched_users", e);
    }
  });

  bot.action(/^admin_shift_tasks_sched_users_all_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery("Теперь для всех ✅").catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const assignmentId = Number(ctx.match[1]);
      await pool.query(
        `DELETE FROM task_assignment_targets WHERE assignment_id = $1`,
        [assignmentId]
      );
      await renderSchedUsersScreenA(ctx, assignmentId);
    } catch (e) {
      logError("admin_shift_tasks_sched_users_all", e);
    }
  });

  bot.action(
    /^admin_shift_tasks_sched_users_rm_confirm_(\d+)_(\d+)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery().catch(() => {});
        const user = await ensureUser(ctx);
        if (!isAdmin(user)) return;

        const assignmentId = Number(ctx.match[1]);
        const targetUserId = Number(ctx.match[2]);

        const kb = Markup.inlineKeyboard([
          [
            Markup.button.callback(
              "🗑 Удалить",
              `admin_shift_tasks_sched_users_rm_${assignmentId}_${targetUserId}`
            ),
          ],
          [
            Markup.button.callback(
              "⬅️ Назад",
              `admin_shift_tasks_sched_users_${assignmentId}`
            ),
          ],
        ]);

        await deliver(
          ctx,
          { text: "🗑 <b>Удалить пользователя из задачи?</b>", extra: kb },
          { edit: true }
        );
      } catch (e) {
        logError("admin_shift_tasks_sched_users_rm_confirm", e);
      }
    }
  );

  bot.action(/^admin_shift_tasks_sched_users_rm_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery("Удалено ✅").catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const assignmentId = Number(ctx.match[1]);
      const targetUserId = Number(ctx.match[2]);

      await pool.query(
        `DELETE FROM task_assignment_targets WHERE assignment_id = $1 AND user_id = $2`,
        [assignmentId, targetUserId]
      );

      await renderSchedUsersScreenA(ctx, assignmentId);
    } catch (e) {
      logError("admin_shift_tasks_sched_users_rm", e);
    }
  });

  bot.action(
    /^admin_shift_tasks_sched_users_add_(\d+)_p(\d+)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery().catch(() => {});
        const user = await ensureUser(ctx);
        if (!isAdmin(user)) return;

        const assignmentId = Number(ctx.match[1]);
        const page = Number(ctx.match[2]);

        await renderSchedUsersScreenB(ctx, assignmentId, page, "");
      } catch (e) {
        logError("admin_shift_tasks_sched_users_add", e);
      }
    }
  );

  bot.action(
    /^admin_shift_tasks_sched_users_toggle_(\d+)_(\d+)_p(\d+)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery().catch(() => {});
        const user = await ensureUser(ctx);
        if (!isAdmin(user)) return;

        const assignmentId = Number(ctx.match[1]);
        const targetUserId = Number(ctx.match[2]);
        const page = Number(ctx.match[3]);

        const ex = await pool.query(
          `SELECT 1 FROM task_assignment_targets WHERE assignment_id = $1 AND user_id = $2 LIMIT 1`,
          [assignmentId, targetUserId]
        );

        if (ex.rows.length) {
          await pool.query(
            `DELETE FROM task_assignment_targets WHERE assignment_id = $1 AND user_id = $2`,
            [assignmentId, targetUserId]
          );
        } else {
          await pool.query(
            `INSERT INTO task_assignment_targets (assignment_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
            [assignmentId, targetUserId]
          );
        }

        // перерисовываем ту же страницу
        const st = getSt(ctx.from.id);
        const q = st?.schedUsersQuery || "";
        await renderSchedUsersScreenB(ctx, assignmentId, page, q);
      } catch (e) {
        logError("admin_shift_tasks_sched_users_toggle", e);
      }
    }
  );

  bot.action("noop", async (ctx) => ctx.answerCbQuery().catch(() => {}));

  bot.action(
    /^admin_shift_tasks_sched_users_pick_(\d+)_(\d+)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery("Добавлено ✅").catch(() => {});
        const user = await ensureUser(ctx);
        if (!isAdmin(user)) return;

        const assignmentId = Number(ctx.match[1]);
        const targetUserId = Number(ctx.match[2]);

        await pool.query(
          `
      INSERT INTO task_assignment_targets (assignment_id, user_id)
      VALUES ($1, $2)
      ON CONFLICT DO NOTHING
      `,
          [assignmentId, targetUserId]
        );

        // выходим из input-step
        setSt(ctx.from.id, { step: null });

        await renderSchedUsers(ctx, user, assignmentId);
      } catch (e) {
        logError("admin_shift_tasks_sched_users_pick", e);
      }
    }
  );

  bot.action(/^admin_shift_tasks_sched_users_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      await renderSchedUsers(ctx, user, Number(ctx.match[1]));
    } catch (e) {
      logError("admin_shift_tasks_sched_users", e);
    }
  });

  bot.action(/^admin_shift_tasks_sched_users_all_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery("Теперь для всех ✅").catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      const assignmentId = Number(ctx.match[1]);

      await pool.query(
        `DELETE FROM task_assignment_targets WHERE assignment_id = $1`,
        [assignmentId]
      );
      await renderSchedUsers(ctx, user, assignmentId);
    } catch (e) {
      logError("admin_shift_tasks_sched_users_all", e);
    }
  });

  bot.action(/^admin_shift_tasks_sched_users_rm_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const assignmentId = Number(ctx.match[1]);
      const targetUserId = Number(ctx.match[2]);

      await pool.query(
        `DELETE FROM task_assignment_targets WHERE assignment_id = $1 AND user_id = $2`,
        [assignmentId, targetUserId]
      );

      await renderSchedUsers(ctx, user, assignmentId);
    } catch (e) {
      logError("admin_shift_tasks_sched_users_rm", e);
    }
  });

  bot.action(/^admin_shift_tasks_sched_users_add_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const assignmentId = Number(ctx.match[1]);

      setSt(ctx.from.id, {
        step: "sched_users_input",
        schedUsers: { assignmentId },
      });

      await deliver(
        ctx,
        {
          text:
            "👤 Введите @username, телефон или часть имени.\n" +
            "Можно также переслать сообщение пользователя.",
          extra: Markup.inlineKeyboard([
            [
              Markup.button.callback(
                "⬅️ Назад",
                `admin_shift_tasks_sched_users_${assignmentId}`
              ),
            ],
          ]),
        },
        { edit: true }
      );
    } catch (e) {
      logError("admin_shift_tasks_sched_users_add", e);
    }
  });

  // entry
  bot.action("admin_shift_tasks", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const today = await dbTodayISO();
      setSt(ctx.from.id, {
        step: "pick_point",
        pointId: null,
        dateISO: today,
        filter: "all",
        mode: "view",
      });

      await renderPickPoint(ctx);
    } catch (e) {
      logError("admin_shift_tasks", e);
    }
  });

  // /tN — открыть карточку задачи из списка (отдельным сообщением)
  async function sendOpTaskCard(ctx, st, assignmentId) {
    const r = await pool.query(
      `
        SELECT
          a.id AS assignment_id,
          a.created_by_user_id,
          cu.full_name AS creator_name,
          cu.username AS creator_username,
          cu.work_phone AS creator_phone,
          t.title,
          t.answer_type
        FROM task_assignments a
        JOIN task_templates t ON t.id = a.template_id
        LEFT JOIN users cu ON cu.id = a.created_by_user_id
        WHERE a.id = $1
        LIMIT 1
      `,
      [assignmentId]
    );

    const asg = r.rows[0];
    if (!asg) {
      await ctx.reply("❌ Задача не найдена");
      return;
    }

    const doneMap = await loadDoneInfoMap(st.pointId, st.dateISO, [
      assignmentId,
    ]);
    const doneInfo = doneMap.get(assignmentId) || null;

    const statusLine = doneInfo
      ? "✅ <b>Выполнено</b>"
      : "▫️ <b>Ожидание выполнения</b>";

    const creator = [
      asg.creator_name ? escHtml(asg.creator_name) : "—",
      asg.creator_username ? `@${escHtml(asg.creator_username)}` : null,
      asg.creator_phone ? escHtml(asg.creator_phone) : null,
    ]
      .filter(Boolean)
      .join(" / ");

    const doneBy = doneInfo
      ? [
          doneInfo.done_by_name ? escHtml(doneInfo.done_by_name) : "—",
          doneInfo.done_by_username
            ? `@${escHtml(doneInfo.done_by_username)}`
            : null,
          doneInfo.done_by_phone ? escHtml(doneInfo.done_by_phone) : null,
        ]
          .filter(Boolean)
          .join(" / ")
      : null;

    let text = `📌 <b>Задача</b>\n\n`;
    text += `📝 <b>Текст:</b> ${escHtml(asg.title)}\n`;
    text += `📅 <b>Дата:</b> ${fmtRuDate(st.dateISO)}\n\n`;
    text += `${statusLine}\n\n`;
    text += `👤 <b>Кто создал:</b> ${creator}\n`;
    text += `✅ <b>Кто выполнил:</b> ${doneBy ? doneBy : "—"}\n`;

    if (doneInfo) {
      // медиа
      if (doneInfo.file_id && doneInfo.file_type) {
        try {
          if (doneInfo.file_type === "photo") {
            await ctx.replyWithPhoto(doneInfo.file_id).catch(() => {});
          } else if (doneInfo.file_type === "video") {
            await ctx.replyWithVideo(doneInfo.file_id).catch(() => {});
          }
        } catch (_) {}
      }

      if (
        doneInfo.answer_number !== null &&
        doneInfo.answer_number !== undefined
      ) {
        text += `\n🔢 <b>Ответ:</b> ${escHtml(
          String(doneInfo.answer_number)
        )}\n`;
      } else if (doneInfo.answer_text) {
        text += `\n📝 <b>Ответ:</b> ${escHtml(doneInfo.answer_text)}\n`;
      }
    }

    const kb = Markup.inlineKeyboard([
      [
        Markup.button.callback(
          "⬅️ Назад к задачам",
          "admin_shift_tasks_back_to_list"
        ),
      ],
    ]);

    await deliver(ctx, { text, extra: kb }, { edit: false });
  }

  bot.hears(/^\/t(\d+)(?:@[\w_]+)?$/, async (ctx) => {
    try {
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getSt(ctx.from.id);
      if (!st?.pointId || !st?.dateISO) {
        await ctx.reply(
          "❗ Сначала откройте экран «Задачи смены» и выберите точку/дату."
        );
        return;
      }

      const n = Number(ctx.match?.[1] || 0);
      if (!Number.isInteger(n) || n <= 0) {
        await ctx.reply("ℹ️ Используйте команду так: /t1, /t2, /t3 ...");
        return;
      }

      const order = (st.opAssignments || []).map(Number);
      if (!order.length) {
        await ctx.reply("❗ Список задач пуст — нечего открывать.");
        return;
      }

      const assignmentId = order[n - 1];
      if (!assignmentId) {
        await ctx.reply(`❌ Неверный номер. Доступно: 1–${order.length}`);
        return;
      }

      await sendOpTaskCard(ctx, st, Number(assignmentId));
    } catch (e) {
      logError("admin_shift_tasks_t", e);
    }
  });

  bot.action("admin_shift_tasks_back_to_list", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      await renderPointScreen(ctx, user);
    } catch (e) {
      logError("admin_shift_tasks_back_to_list", e);
    }
  });

  bot.action(/^admin_shift_tasks_point_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const pointId = Number(ctx.match[1]);
      const today = await dbTodayISO();
      setSt(ctx.from.id, {
        pointId,
        dateISO: today,
        filter: "all",
        mode: "view",
        deleteSelected: [],
      });

      await renderPointScreen(ctx, user);
    } catch (e) {
      logError("admin_shift_tasks_point_pick", e);
    }
  });

  bot.action("admin_shift_tasks_back_to_points", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      setSt(ctx.from.id, {
        step: "pick_point",
        pointId: null,
        mode: "view",
        filter: "all",
      });
      await renderPickPoint(ctx);
    } catch (e) {
      logError("admin_shift_tasks_back_to_points", e);
    }
  });

  // copy task
  bot.action(/^admin_shift_tasks_copy_(\d+)$/, async (ctx) => {
    try {
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const asgId = Number(ctx.match[1]);
      const r = await pool.query(
        `
        SELECT t.title
        FROM task_assignments a
        JOIN task_templates t ON t.id = a.template_id
        WHERE a.id = $1
        LIMIT 1
        `,
        [asgId]
      );
      const title = r.rows[0]?.title || "—";
      await ctx.answerCbQuery(title, { show_alert: true }).catch(() => {});
    } catch (e) {
      logError("admin_shift_tasks_copy", e);
    }
  });

  // pick date
  bot.action("admin_shift_tasks_pick_date", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getSt(ctx.from.id);
      if (!st?.pointId) return renderPickPoint(ctx);

      const kb = await buildDatePicker(st.dateISO);

      await deliver(
        ctx,
        {
          text: "📅 <b>Выберите дату</b>\n\n(можно прошедшие, или «Ввести дату»)",
          extra: kb,
        },
        { edit: true }
      );
    } catch (e) {
      logError("admin_shift_tasks_pick_date", e);
    }
  });

  bot.action("admin_shift_tasks_date_input", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      setSt(ctx.from.id, { step: "date_input" });

      const kb = Markup.inlineKeyboard([
        [Markup.button.callback("⬅️ Назад", "admin_shift_tasks_pick_date")],
      ]);

      await deliver(
        ctx,
        {
          text:
            "📅 <b>Введите дату</b>\n\n" +
            "Формат: <b>ДД.ММ.ГГГГ</b> (например 08.01.2026)\n" +
            "или <b>ГГГГ-ММ-ДД</b> (например 2026-01-08).",
          extra: kb,
        },
        { edit: true }
      );
    } catch (e) {
      logError("admin_shift_tasks_date_input", e);
    }
  });

  bot.action("admin_shift_tasks_add_users_all", async (ctx) => {
    try {
      await ctx.answerCbQuery("Теперь для всех ✅").catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getSt(ctx.from.id);
      if (!st?.add) return;
      st.add.targetUserIds = [];
      setSt(ctx.from.id, { add: st.add, step: null });

      await renderCreateUsersScreenA(ctx);
    } catch (e) {
      logError("admin_shift_tasks_add_users_all", e);
    }
  });

  bot.action(/^admin_shift_tasks_add_users_rm_confirm_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const uid = Number(ctx.match[1]);
      const kb = Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "🗑 Удалить",
            `admin_shift_tasks_add_users_rm_${uid}`
          ),
        ],
        [Markup.button.callback("⬅️ Назад", "admin_shift_tasks_add_forwho")],
      ]);
      await deliver(
        ctx,
        { text: "🗑 <b>Удалить пользователя из задачи?</b>", extra: kb },
        { edit: true }
      );
    } catch (e) {
      logError("admin_shift_tasks_add_users_rm_confirm", e);
    }
  });

  bot.action(/^admin_shift_tasks_add_users_rm_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery("Удалено ✅").catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const uid = Number(ctx.match[1]);
      const st = getSt(ctx.from.id);
      if (!st?.add) return;

      st.add.targetUserIds = (st.add.targetUserIds || []).filter(
        (x) => Number(x) !== uid
      );
      setSt(ctx.from.id, { add: st.add });

      await renderCreateUsersScreenA(ctx);
    } catch (e) {
      logError("admin_shift_tasks_add_users_rm", e);
    }
  });

  bot.action(/^admin_shift_tasks_add_users_add_p(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const page = Number(ctx.match[1]);
      await renderCreateUsersScreenB(ctx, page, "");
    } catch (e) {
      logError("admin_shift_tasks_add_users_add", e);
    }
  });

  bot.action(
    /^admin_shift_tasks_add_users_toggle_(\d+)_p(\d+)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery().catch(() => {});
        const user = await ensureUser(ctx);
        if (!isAdmin(user)) return;

        const uid = Number(ctx.match[1]);
        const page = Number(ctx.match[2]);

        const st = getSt(ctx.from.id);
        if (!st?.add) return;

        const set = new Set((st.add.targetUserIds || []).map(Number));
        if (set.has(uid)) set.delete(uid);
        else set.add(uid);

        st.add.targetUserIds = Array.from(set);
        setSt(ctx.from.id, { add: st.add });

        const q = st.createUsersQuery || "";
        await renderCreateUsersScreenB(ctx, page, q);
      } catch (e) {
        logError("admin_shift_tasks_add_users_toggle", e);
      }
    }
  );

  // Для кого? (внутри добавления задачи)
  bot.action("admin_shift_tasks_add_forwho", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getSt(ctx.from.id);
      if (!st?.pointId || st.mode !== "add") return;

      if (!st.add) st.add = {};
      if (!Array.isArray(st.add.targetUserIds)) st.add.targetUserIds = [];

      await renderCreateUsersScreenA(ctx);
    } catch (e) {
      logError("admin_shift_tasks_add_forwho", e);
    }
  });

  bot.action("admin_shift_tasks_add_forwho_back", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      // FIX: иначе st.step остаётся add_forwho_input и перехватывает ввод текста задачи
      setSt(ctx.from.id, { step: null });

      await renderPointScreen(ctx, user);
    } catch (e) {
      logError("admin_shift_tasks_add_forwho_back", e);
    }
  });

  bot.action("admin_shift_tasks_add_forwho_all", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getSt(ctx.from.id);
      if (!st?.pointId || st.mode !== "add") return;

      setSt(ctx.from.id, {
        step: null,
        add: { ...st.add, forUserId: null, forUserName: null },
      });
      await renderPointScreen(ctx, user);
    } catch (e) {
      logError("admin_shift_tasks_add_forwho_all", e);
    }
  });

  bot.action(/^admin_shift_tasks_add_forwho_pick_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getSt(ctx.from.id);
      if (!st?.pointId || st.mode !== "add") return;

      const id = Number(ctx.match[1]);
      const r = await pool.query(
        `SELECT id, full_name, username, work_phone FROM users WHERE id = $1 LIMIT 1`,
        [id]
      );
      const u = r.rows[0];
      if (!u) {
        await ctx
          .answerCbQuery("Пользователь не найден", { show_alert: true })
          .catch(() => {});
        return;
      }

      setSt(ctx.from.id, {
        step: null,
        add: {
          ...st.add,
          forUserId: Number(u.id),
          forUserName: u.full_name || u.username || String(u.id),
        },
      });

      await renderPointScreen(ctx, user);
    } catch (e) {
      logError("admin_shift_tasks_add_forwho_pick", e);
    }
  });

  bot.action(/^admin_shift_tasks_sched_card_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      await renderScheduledCard(ctx, user, Number(ctx.match[1]));
    } catch (e) {
      logError("admin_shift_tasks_sched_card", e);
    }
  });

  bot.action(/^admin_shift_tasks_sched_toggle_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery("Ок").catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const id = Number(ctx.match[1]);
      await pool.query(
        `UPDATE task_assignments SET is_active = NOT is_active WHERE id=$1`,
        [id]
      );
      await renderScheduledCard(ctx, user, id);
    } catch (e) {
      logError("admin_shift_tasks_sched_toggle", e);
    }
  });

  bot.action(/^admin_shift_tasks_sched_delete_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery("Удалено").catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const id = Number(ctx.match[1]);
      await pool.query(
        `UPDATE task_assignments SET is_active = FALSE WHERE id=$1`,
        [id]
      );

      await renderScheduledList(ctx, user);
    } catch (e) {
      logError("admin_shift_tasks_sched_delete", e);
    }
  });

  bot.action(/^admin_shift_tasks_sched_period_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const id = Number(ctx.match[1]);
      setSt(ctx.from.id, { step: "sched_edit_period", editPickId: id });

      const kb = Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "по дням недели",
            "admin_shift_tasks_sched_set_weekly"
          ),
        ],
        [
          Markup.button.callback(
            "каждые x дней",
            "admin_shift_tasks_sched_set_everyx"
          ),
        ],
        [
          Markup.button.callback(
            "⬅️ Назад",
            `admin_shift_tasks_sched_card_${id}`
          ),
        ],
      ]);

      await deliver(
        ctx,
        { text: "Выберите новую периодичность (применится сразу):", extra: kb },
        { edit: true }
      );
    } catch (e) {
      logError("admin_shift_tasks_sched_period", e);
    }
  });

  bot.action("admin_shift_tasks_sched_set_weekly", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getSt(ctx.from.id);
      setSt(ctx.from.id, { add: { ...(st.add || {}), weekdaysMask: 0 } });

      await deliver(
        ctx,
        {
          text: "Выберите дни недели (мультивыбор ✅):",
          extra: buildWeekdaysPicker(0),
        },
        { edit: true }
      );
    } catch (e) {
      logError("admin_shift_tasks_sched_set_weekly", e);
    }
  });

  bot.action(/^admin_shift_tasks_date_(\d{4}-\d{2}-\d{2})$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const iso = ctx.match[1];
      setSt(ctx.from.id, {
        dateISO: iso,
        mode: "view",
        filter: "all",
        deleteSelected: [],
      });
      await renderPointScreen(ctx, user);
    } catch (e) {
      logError("admin_shift_tasks_date_set", e);
    }
  });

  bot.action("admin_shift_tasks_point_back", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      await renderPointScreen(ctx, user);
    } catch (e) {
      logError("admin_shift_tasks_point_back", e);
    }
  });

  bot.action("admin_shift_tasks_point_redraw", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      setSt(ctx.from.id, { mode: "view", filter: "all" });
      await renderPointScreen(ctx, user);
    } catch (e) {
      logError("admin_shift_tasks_point_redraw", e);
    }
  });

  // ----- ADD MODE -----
  bot.action("admin_shift_tasks_add", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      setSt(ctx.from.id, {
        step: null,
        mode: "add",
        add: {
          answerType: "button",
          scheduleType: "single",
          weekdaysMask: 0,
          everyXDays: null,
          timeMode: "all_day",
          deadlineTime: null,

          // NEW: для кого (null = все)
          forUserId: null,
          forUserName: null,
        },
      });
      await renderPointScreen(ctx, user);
    } catch (e) {
      logError("admin_shift_tasks_add", e);
    }
  });

  bot.action("admin_shift_tasks_add_back", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getSt(ctx.from.id);
      if (!st?.pointId) return;

      // важно: НЕ трогаем st.add (там targetUserIds)
      setSt(ctx.from.id, { step: null, mode: "add" });
      await renderPointScreen(ctx, user);
    } catch (e) {
      logError("admin_shift_tasks_add_back", e);
    }
  });

  bot.action("admin_shift_tasks_add_done", async (ctx) => {
    try {
      await ctx.answerCbQuery("Готово ✅").catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      setSt(ctx.from.id, { mode: "view", filter: "all" });
      await renderPointScreen(ctx, user);
    } catch (e) {
      logError("admin_shift_tasks_add_done", e);
    }
  });

  bot.action("admin_shift_tasks_add_cancel", async (ctx) => {
    try {
      await ctx.answerCbQuery("Отменено").catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      setSt(ctx.from.id, { mode: "view", filter: "all" });
      await renderPointScreen(ctx, user);
    } catch (e) {
      logError("admin_shift_tasks_add_cancel", e);
    }
  });

  // type picker
  bot.action("admin_shift_tasks_add_type", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      const st = getSt(ctx.from.id);
      if (!st?.pointId) return;

      await deliver(
        ctx,
        {
          text: "Выберите <b>тип ответа</b>:",
          extra: buildAnswerTypePicker(st),
        },
        { edit: true }
      );
    } catch (e) {
      logError("admin_shift_tasks_add_type", e);
    }
  });

  bot.action("admin_shift_tasks_add_type_close", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      await renderPointScreen(ctx, user);
    } catch (e) {
      logError("admin_shift_tasks_add_type_close", e);
    }
  });

  bot.action(
    /^admin_shift_tasks_add_type_set_(photo|video|number|text|button)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery("Ок").catch(() => {});
        const user = await ensureUser(ctx);
        if (!isAdmin(user)) return;

        const t = ctx.match[1];
        const st = getSt(ctx.from.id);
        if (!st) return;

        setSt(ctx.from.id, { add: { ...st.add, answerType: t } });
        await renderPointScreen(ctx, user);
      } catch (e) {
        logError("admin_shift_tasks_add_type_set", e);
      }
    }
  );

  // period picker
  bot.action("admin_shift_tasks_add_period", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      await deliver(
        ctx,
        {
          text: "Выберите <b>периодичность</b>:",
          extra: buildPeriodPicker(getSt(ctx.from.id)),
        },
        { edit: true }
      );
    } catch (e) {
      logError("admin_shift_tasks_add_period", e);
    }
  });

  bot.action("admin_shift_tasks_add_period_close", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      await renderPointScreen(ctx, user);
    } catch (e) {
      logError("admin_shift_tasks_add_period_close", e);
    }
  });

  bot.action("admin_shift_tasks_add_period_single", async (ctx) => {
    try {
      await ctx.answerCbQuery("Разовая").catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getSt(ctx.from.id);
      setSt(ctx.from.id, {
        add: {
          ...st.add,
          scheduleType: "single",
          weekdaysMask: 0,
          everyXDays: null,
        },
      });
      await renderPointScreen(ctx, user);
    } catch (e) {
      logError("admin_shift_tasks_add_period_single", e);
    }
  });

  bot.action("admin_shift_tasks_add_period_weekly", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getSt(ctx.from.id);
      setSt(ctx.from.id, { add: { ...st.add, scheduleType: "weekly" } });

      await deliver(
        ctx,
        {
          text: "Выберите дни недели (мультивыбор ✅):",
          extra: buildWeekdaysPicker(st.add.weekdaysMask || 0),
        },
        { edit: true }
      );
    } catch (e) {
      logError("admin_shift_tasks_add_period_weekly", e);
    }
  });

  bot.action(
    /^admin_shift_tasks_add_weekdays_toggle_(mon|tue|wed|thu|fri|sat|sun)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery().catch(() => {});
        const user = await ensureUser(ctx);
        if (!isAdmin(user)) return;

        const key = ctx.match[1];
        const st = getSt(ctx.from.id);
        const d = WD.find((x) => x.key === key);
        if (!d) return;

        const mask = Number(st.add.weekdaysMask || 0);
        const nextMask = (mask & d.bit) !== 0 ? mask & ~d.bit : mask | d.bit;

        setSt(ctx.from.id, {
          add: { ...st.add, weekdaysMask: nextMask, scheduleType: "weekly" },
        });

        // если редактируем расписание scheduled-задачи — применяем сразу
        const st2 = getSt(ctx.from.id);
        if (st2.step === "sched_edit_period" && st2.editPickId) {
          await pool.query(
            `
    UPDATE task_schedules
    SET schedule_type='weekly',
        weekdays_mask=$2,
        every_x_days=NULL,
        start_date=NULL,
        single_date=NULL
    WHERE assignment_id=$1
    `,
            [Number(st2.editPickId), Number(st2.add.weekdaysMask || 0)]
          );

          await ctx.answerCbQuery("Применено ✅").catch(() => {});
          await renderScheduledCard(ctx, user, Number(st2.editPickId));
          return;
        }

        await deliver(
          ctx,
          {
            text: "Выберите дни недели (мультивыбор ✅):",
            extra: buildWeekdaysPicker(nextMask),
          },
          { edit: true }
        );
      } catch (e) {
        logError("admin_shift_tasks_add_weekdays_toggle", e);
      }
    }
  );

  bot.action("admin_shift_tasks_add_weekdays_close", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      await renderPointScreen(ctx, user);
    } catch (e) {
      logError("admin_shift_tasks_add_weekdays_close", e);
    }
  });

  bot.action("admin_shift_tasks_add_period_everyx", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getSt(ctx.from.id);
      setSt(ctx.from.id, {
        add: { ...st.add, scheduleType: "every_x_days", everyXDays: null },
      });

      await deliver(
        ctx,
        {
          text: "Введите <b>X</b> (каждые сколько дней):\nНапример: <code>3</code>",
          extra: Markup.inlineKeyboard([
            [
              Markup.button.callback(
                "⬅️ Назад",
                "admin_shift_tasks_add_period"
              ),
            ],
            [
              Markup.button.callback(
                "❌ Отмена",
                "admin_shift_tasks_add_cancel"
              ),
            ],
          ]),
        },
        { edit: true }
      );
    } catch (e) {
      logError("admin_shift_tasks_add_period_everyx", e);
    }
  });

  // time toggle
  bot.action("admin_shift_tasks_add_time", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getSt(ctx.from.id);
      const on = st.add.timeMode === "deadline";
      const kb = Markup.inlineKeyboard([
        [
          Markup.button.callback(
            `${on ? "✅ " : ""}да`,
            "admin_shift_tasks_time_yes"
          ),
        ],
        [
          Markup.button.callback(
            `${!on ? "✅ " : ""}нет`,
            "admin_shift_tasks_time_no"
          ),
        ],
        [Markup.button.callback("⬅️ Назад", "admin_shift_tasks_point_redraw")],
      ]);

      await deliver(
        ctx,
        { text: "⏱ Ограничение по времени:", extra: kb },
        { edit: true }
      );
    } catch (e) {
      logError("admin_shift_tasks_add_time", e);
    }
  });

  bot.action("admin_shift_tasks_time_no", async (ctx) => {
    try {
      await ctx.answerCbQuery("Ок").catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getSt(ctx.from.id);
      setSt(ctx.from.id, {
        add: { ...st.add, timeMode: "all_day", deadlineTime: null },
      });
      await renderPointScreen(ctx, user);
    } catch (e) {
      logError("admin_shift_tasks_time_no", e);
    }
  });

  bot.action("admin_shift_tasks_time_yes", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getSt(ctx.from.id);
      setSt(ctx.from.id, { add: { ...st.add, timeMode: "deadline" } });

      await deliver(
        ctx,
        {
          text: "Введите время в формате <code>14:00</code>",
          extra: Markup.inlineKeyboard([
            [
              Markup.button.callback(
                "⬅️ Назад",
                "admin_shift_tasks_point_redraw"
              ),
            ],
            [
              Markup.button.callback(
                "❌ Отмена",
                "admin_shift_tasks_add_cancel"
              ),
            ],
          ]),
        },
        { edit: true }
      );
    } catch (e) {
      logError("admin_shift_tasks_time_yes", e);
    }
  });

  // ----- DELETE MODE -----
  bot.action("admin_shift_tasks_delete", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      setSt(ctx.from.id, { mode: "delete", deleteSelected: [] });
      await renderPointScreen(ctx, user);
    } catch (e) {
      logError("admin_shift_tasks_delete", e);
    }
  });

  bot.action(/^admin_shift_tasks_del_toggle_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const id = Number(ctx.match[1]);
      const st = getSt(ctx.from.id);
      const arr = (st.deleteSelected || []).map(Number);
      const next = arr.includes(id)
        ? arr.filter((x) => x !== id)
        : [...arr, id];
      setSt(ctx.from.id, { deleteSelected: next });
      await renderPointScreen(ctx, user);
    } catch (e) {
      logError("admin_shift_tasks_del_toggle", e);
    }
  });

  bot.action("admin_shift_tasks_del_apply", async (ctx) => {
    try {
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getSt(ctx.from.id);
      const ids = Array.from(new Set(st?.deleteSelected || []))
        .map((x) => parseInt(x, 10))
        .filter((x) => Number.isFinite(x));

      if (!ids.length) {
        await ctx
          .answerCbQuery("Ничего не выбрано", { show_alert: true })
          .catch(() => {});
        return;
      }

      await ctx.answerCbQuery("Удаляю...").catch(() => {});

      const res = await pool.query(
        `UPDATE task_assignments
         SET is_active = FALSE
       WHERE id = ANY($1::int[])`,
        [ids]
      );

      // Если вдруг 0 строк обновилось — покажем алёрт (значит ids не те / уже удалено)
      if (!res.rowCount) {
        await ctx
          .answerCbQuery("Не удалось удалить (0 записей). Проверь IDs.", {
            show_alert: true,
          })
          .catch(() => {});
      }

      setSt(ctx.from.id, { mode: "view", deleteSelected: [], filter: "all" });
      await renderPointScreen(ctx, user);
    } catch (e) {
      logError("admin_shift_tasks_del_apply", e);
    }
  });

  // ----- SCHEDULE FILTER + EDIT PERIOD -----
  bot.action("admin_shift_tasks_sched_root", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      await renderScheduledList(ctx, user);
    } catch (e) {
      logError("admin_shift_tasks_sched_root", e);
    }
  });

  bot.action(/^admin_shift_tasks_edit_pick_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const id = Number(ctx.match[1]);
      setSt(ctx.from.id, { editPickId: id });

      await deliver(
        ctx,
        {
          text: "Выберите новую периодичность (применится сразу):",
          extra: buildEditPeriodOptionsKeyboard(),
        },
        { edit: true }
      );
    } catch (e) {
      logError("admin_shift_tasks_edit_pick", e);
    }
  });

  bot.action("admin_shift_tasks_sched_set_everyx", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getSt(ctx.from.id);
      setSt(ctx.from.id, { step: "sched_edit_everyx" });

      await deliver(
        ctx,
        {
          text: "Введите <b>X</b> (каждые сколько дней):\nНапример: <code>3</code>",
          extra: Markup.inlineKeyboard([
            [
              Markup.button.callback(
                "⬅️ Назад",
                `admin_shift_tasks_sched_card_${st.editPickId}`
              ),
            ],
          ]),
        },
        { edit: true }
      );
    } catch (e) {
      logError("admin_shift_tasks_sched_set_everyx", e);
    }
  });

  bot.action("admin_shift_tasks_edit_set_single", async (ctx) => {
    try {
      await ctx.answerCbQuery("Применяю...").catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getSt(ctx.from.id);
      const id = Number(st.editPickId);
      if (!id) return;

      await pool.query(
        `
        UPDATE task_schedules
        SET schedule_type='single',
            single_date=$2,
            start_date=NULL,
            weekdays_mask=0,
            every_x_days=NULL
        WHERE assignment_id=$1
        `,
        [id, st.dateISO]
      );

      setSt(ctx.from.id, {
        mode: "view",
        filter: "scheduled",
        editPickId: null,
      });
      await renderPointScreen(ctx, user);
    } catch (e) {
      logError("admin_shift_tasks_edit_set_single", e);
    }
  });

  bot.action("admin_shift_tasks_edit_set_weekly", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      // просто переиспользуем weekly picker (в стейте add.weekdaysMask)
      const st = getSt(ctx.from.id);
      setSt(ctx.from.id, { add: { ...st.add, weekdaysMask: 0 } });

      await deliver(
        ctx,
        {
          text: "Выберите дни недели (мультивыбор ✅):",
          extra: buildWeekdaysPicker(0),
        },
        { edit: true }
      );
    } catch (e) {
      logError("admin_shift_tasks_edit_set_weekly", e);
    }
  });

  bot.action("admin_shift_tasks_edit_set_everyx", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      await deliver(
        ctx,
        {
          text: "Введите <b>X</b> (каждые сколько дней):\nНапример: <code>3</code>",
          extra: Markup.inlineKeyboard([
            [
              Markup.button.callback(
                "⬅️ Назад",
                "admin_shift_tasks_sched_back"
              ),
            ],
          ]),
        },
        { edit: true }
      );

      // пометим, что следующий ввод X — это edit, а не add
      setSt(ctx.from.id, { step: "edit_everyx_input" });
    } catch (e) {
      logError("admin_shift_tasks_edit_set_everyx", e);
    }
  });

  // ----- TEXT INPUT HANDLER (add task / set time / set everyX) -----

  // ловим пересланные сообщения для выбора "Для кого?"
  bot.on("message", async (ctx, next) => {
    try {
      const st = getSt(ctx.from.id);
      if (!st) return next();

      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return next();

      if (st.step !== "add_forwho_input" || st.mode !== "add") return next();

      const fwdId = ctx.message?.forward_from?.id || null;
      if (!fwdId) return next();

      const candidates = await searchUsersForWho(null, fwdId);
      if (!candidates.length) {
        await ctx.reply(
          "❌ Пользователь не найден в базе (по пересланному сообщению)."
        );
        return;
      }

      const btns = candidates
        .slice(0, 10)
        .map((u) => [
          Markup.button.callback(
            formatUserLabel(u),
            `admin_shift_tasks_add_forwho_pick_${u.id}`
          ),
        ]);

      const kb = Markup.inlineKeyboard([
        ...btns,
        [
          Markup.button.callback(
            "👥 Для всех",
            "admin_shift_tasks_add_forwho_all"
          ),
        ],
        [
          Markup.button.callback(
            "⬅️ Назад",
            "admin_shift_tasks_add_forwho_back"
          ),
        ],
      ]);

      await deliver(
        ctx,
        {
          text: "Найдено по пересланному сообщению. Выберите пользователя:",
          extra: kb,
        },
        { edit: false }
      );
      return;
    } catch (e) {
      logError("admin_shift_tasks_add_forwho_forward", e);
      return next();
    }
  });
  bot.on("text", async (ctx, next) => {
    const st = getSt(ctx.from.id);
    if (!st) return next();

    const user = await ensureUser(ctx);
    if (!isAdmin(user)) return next();

    const txt = String(ctx.message.text || "").trim();
    if (!txt) return next();

    // 0) ввод произвольной даты
    if (st.step === "date_input") {
      const iso = parseAnyDateToISO(txt);
      if (!iso) {
        await ctx.reply("❌ Не понял дату. Формат: 08.01.2026 или 2026-01-08");
        return;
      }
      setSt(ctx.from.id, {
        step: null,
        dateISO: iso,
        mode: "view",
        filter: "all",
        deleteSelected: [],
      });
      await renderPointScreen(ctx, user);
      return;
    }

    if (st.step === "sched_users_search" && st.schedUsers?.assignmentId) {
      const q = (ctx.message.text || "").trim();
      setSt(ctx.from.id, { schedUsersQuery: q });

      await renderSchedUsersScreenB(
        ctx,
        st.schedUsers.assignmentId,
        st.schedUsers.page || 1,
        q
      );
      return;
    }

    // 0.1) поиск пользователя для "Для кого?"
    if (st.step === "add_forwho_input") {
      const candidates = await searchUsersForWho(txt);
      if (!candidates.length) {
        await ctx.reply(
          "❌ Никого не нашёл. Попробуйте @username, телефон или часть имени."
        );
        return;
      }

      const btns = candidates
        .slice(0, 10)
        .map((u) => [
          Markup.button.callback(
            formatUserLabel(u),
            `admin_shift_tasks_add_forwho_pick_${u.id}`
          ),
        ]);

      const kb = Markup.inlineKeyboard([
        ...btns,
        [
          Markup.button.callback(
            "👥 Для всех",
            "admin_shift_tasks_add_forwho_all"
          ),
        ],
        [
          Markup.button.callback(
            "⬅️ Назад",
            "admin_shift_tasks_add_forwho_back"
          ),
        ],
      ]);

      await deliver(
        ctx,
        { text: "Найдено. Выберите пользователя:", extra: kb },
        { edit: false }
      );
      return;
    }

    // 1) если ждём ввод времени
    if (
      st.mode === "add" &&
      st.add.timeMode === "deadline" &&
      !st.add.deadlineTime
    ) {
      const t = normalizeTime(txt);
      if (!t) {
        await ctx.reply("❌ Нужно время в формате 14:00");
        return;
      }
      setSt(ctx.from.id, { add: { ...st.add, deadlineTime: t } });
      await renderPointScreen(ctx, user);
      return;
    }

    // SCHEDULE EDIT: every_x_days
    if (st.step === "sched_edit_everyx") {
      const x = Number(txt);
      if (!Number.isFinite(x) || x <= 0 || x > 365) {
        await ctx.reply("❌ Введите число X от 1 до 365");
        return;
      }
      const id = Number(st.editPickId);
      if (!id) return;

      await pool.query(
        `
        UPDATE task_schedules
        SET schedule_type='every_x_days',
            every_x_days=$2,
            start_date=CURRENT_DATE,
            weekdays_mask=0,
            single_date=NULL
        WHERE assignment_id=$1
        `,
        [id, Math.floor(x)]
      );

      setSt(ctx.from.id, { step: "pick_point" });
      await ctx.reply("✅ Применено");
      await renderScheduledCard(ctx, user, id);
      return;
    }

    // 2) если ждём X для every_x_days (add)
    if (
      st.mode === "add" &&
      st.add.scheduleType === "every_x_days" &&
      !st.add.everyXDays
    ) {
      const x = Number(txt);
      if (!Number.isFinite(x) || x <= 0 || x > 365) {
        await ctx.reply("❌ Введите число X от 1 до 365");
        return;
      }
      setSt(ctx.from.id, { add: { ...st.add, everyXDays: Math.floor(x) } });
      await renderPointScreen(ctx, user);
      return;
    }

    // 3) если ждём X для every_x_days (edit)
    if (st.step === "edit_everyx_input") {
      const x = Number(txt);
      if (!Number.isFinite(x) || x <= 0 || x > 365) {
        await ctx.reply("❌ Введите число X от 1 до 365");
        return;
      }
      const id = Number(st.editPickId);
      if (!id) return;

      await pool.query(
        `
        UPDATE task_schedules
        SET schedule_type='every_x_days',
            every_x_days=$2,
            start_date=$3,
            single_date=NULL,
            weekdays_mask=0
        WHERE assignment_id=$1
        `,
        [id, Math.floor(x), st.dateISO]
      );

      setSt(ctx.from.id, {
        step: "pick_point",
        mode: "view",
        filter: "scheduled",
        editPickId: null,
      });
      await renderPointScreen(ctx, user);
      return;
    }

    // 4) ADD TASK: любой текст в режиме add = новая задача
    if (st.mode === "add") {
      const title = txt;

      // template (не как общий шаблон, просто для назначения)
      const tplRes = await pool.query(
        `
        INSERT INTO task_templates (title, answer_type, is_active, created_by_user_id)
VALUES ($1, $2, TRUE, $3)

        RETURNING id
        `,
        [title, st.add.answerType, user.id]
      );
      const templateId = tplRes.rows[0].id;

      const ids = Array.isArray(st.add.targetUserIds)
        ? st.add.targetUserIds.map(Number)
        : [];
      const taskType = ids.length ? "individual" : "global";

      const asgRes = await pool.query(
        `
  INSERT INTO task_assignments
    (task_type, template_id, created_by_user_id, point_scope, trade_point_id, is_active)
  VALUES
    ($1, $2, $3, 'one_point', $4, TRUE)
  RETURNING id
  `,
        [taskType, templateId, user.id, st.pointId]
      );

      const assignmentId = asgRes.rows[0].id;

      if (ids.length) {
        for (const uid of ids) {
          await pool.query(
            `
      INSERT INTO task_assignment_targets (assignment_id, user_id)
      VALUES ($1, $2)
      ON CONFLICT DO NOTHING
      `,
            [assignmentId, uid]
          );
        }
      }

      // schedule
      const scheduleType = st.add.scheduleType || "single";

      if (scheduleType === "single") {
        await pool.query(
          `
          INSERT INTO task_schedules
            (assignment_id, schedule_type, single_date, time_mode, deadline_time)
          VALUES
            ($1, 'single', $2, $3, $4)
          `,
          [assignmentId, st.dateISO, st.add.timeMode, st.add.deadlineTime]
        );
      } else if (scheduleType === "weekly") {
        await pool.query(
          `
          INSERT INTO task_schedules
            (assignment_id, schedule_type, weekdays_mask, time_mode, deadline_time)
          VALUES
            ($1, 'weekly', $2, $3, $4)
          `,
          [
            assignmentId,
            Number(st.add.weekdaysMask || 0),
            st.add.timeMode,
            st.add.deadlineTime,
          ]
        );
      } else if (scheduleType === "every_x_days") {
        await pool.query(
          `
          INSERT INTO task_schedules
            (assignment_id, schedule_type, every_x_days, start_date, time_mode, deadline_time)
          VALUES
            ($1, 'every_x_days', $2, $3, $4, $5)
          `,
          [
            assignmentId,
            Number(st.add.everyXDays || 1),
            st.dateISO,
            st.add.timeMode,
            st.add.deadlineTime,
          ]
        );
      }

      // уведомление, если это на сегодня и есть активные смены
      await sendNewTasksNotification(st.pointId, st.dateISO, [title], user.id);

      await ctx.reply("✅ Задача добавлена");
      await renderPointScreen(ctx, user);
      return;
    }

    return next();
  });
}

module.exports = { registerAdminShiftTasks };
