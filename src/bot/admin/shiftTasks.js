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

function fmtShortDate(v) {
  if (!v) return "";
  const d = v instanceof Date ? v : new Date(v);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}`;
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
  // 14 дней: сегодня + 13 (в таймзоне БД)
  const r = await pool.query(`
    SELECT (CURRENT_DATE + offs)::text AS d
    FROM generate_series(0, 13) AS offs
  `);

  const btns = r.rows.map(({ d }) => {
    const label = (d === dateISO ? "✅ " : "") + fmtRuDate(d);
    return Markup.button.callback(label, `admin_shift_tasks_date_${d}`);
  });

  const rows = [];
  for (let i = 0; i < btns.length; i += 7) rows.push(btns.slice(i, i + 7));
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
  deleteSelectedIds
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
    const creator = r.creator_name ? ` (${r.creator_name})` : "";
    const mark = scheduleMark(r.schedule_type);

    // В режиме удаления: выбранные перечёркиваем
    const title = selectedSet.has(Number(r.assignment_id))
      ? `<s>${escHtml(r.title)}</s>`
      : escHtml(r.title);
    if (mode === "delete") {
      text += `${n}. ${mark} ${title}${escHtml(creator)}\n`;
    } else {
      text += `${n}. ${mark} <code>${escHtml(r.title)}</code>${escHtml(
        creator
      )}\n`;
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

  const text = buildTasksText(
    point.title,
    st.dateISO,
    shiftInfo,
    items,
    st.mode,
    st.deleteSelected
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
      s.schedule_type,
      s.start_date,
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
  text += `Задача: <b>${escHtml(row.title)}</b>${escHtml(creator)}\n`;
  text += `Статус: <b>${status}</b>\n`;
  text += `Периодичность: <b>${escHtml(scheduleLabel(row))}</b>\n`;

  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "🔁 Поменять периодичность",
        `admin_shift_tasks_sched_period_${row.assignment_id}`
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

function registerAdminShiftTasks(bot, ensureUser, logError) {
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
          text: "📅 <b>Выберите дату</b>\n\n(только сегодня и будущие)",
          extra: kb,
        },
        { edit: true }
      );
    } catch (e) {
      logError("admin_shift_tasks_pick_date", e);
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
        mode: "add",
        add: {
          answerType: "button",
          scheduleType: "single",
          weekdaysMask: 0,
          everyXDays: null,
          timeMode: "all_day",
          deadlineTime: null,
        },
      });
      await renderPointScreen(ctx, user);
    } catch (e) {
      logError("admin_shift_tasks_add", e);
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
  bot.on("text", async (ctx, next) => {
    const st = getSt(ctx.from.id);
    if (!st) return next();

    const user = await ensureUser(ctx);
    if (!isAdmin(user)) return next();

    const txt = String(ctx.message.text || "").trim();
    if (!txt) return next();

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

      // assignment (global, one_point)
      const asgRes = await pool.query(
        `
        INSERT INTO task_assignments
          (task_type, template_id, created_by_user_id, point_scope, trade_point_id, is_active)
        VALUES
          ('global', $1, $2, 'one_point', $3, TRUE)
        RETURNING id
        `,
        [templateId, user.id, st.pointId]
      );
      const assignmentId = asgRes.rows[0].id;

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
