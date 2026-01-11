// src/bot/admin/shiftTasks.screens.js
const { Markup } = require("telegraf");
const pool = require("../../db/pool");
const { deliver } = require("../../utils/renderHelpers");

const {
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
} = require("./shiftTasks.schema");

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
      t.answer_type,
      COALESCE(tg.target_count, 0) AS target_count
    FROM task_assignments a
    JOIN task_schedules s ON s.assignment_id = a.id
    JOIN task_templates t ON t.id = a.template_id
    LEFT JOIN users u ON u.id = a.created_by_user_id
    LEFT JOIN (
      SELECT assignment_id, COUNT(*)::int AS target_count
      FROM task_assignment_targets
      GROUP BY assignment_id
    ) tg ON tg.assignment_id = a.id
    WHERE a.task_type IN ('global','individual')
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
    const selected =
      !isDone && r.task_type === "individual" && Number(r.target_count) > 0
        ? ` 👤(${Number(r.target_count)})`
        : "";

    const op = ` /t${n}`;

    const printableTitle = selectedSet.has(Number(r.assignment_id))
      ? `<s>${escHtml(r.title)}</s>`
      : escHtml(r.title);

    if (mode === "delete") {
      text += `${n}. ${mark} ${printableTitle}\n`;
    } else {
      text += `${statusMark} ${mark} ${printableTitle}${selected}${who}${op}\n`;
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

  // --- дата-бар: ← DD MM YY →
  const d = new Date(st.dateISO + "T00:00:00");
  const dd = String(d.getDate()).padStart(2, "0") + ".";
  const mm = String(d.getMonth() + 1).padStart(2, "0") + ".";
  const yy = String(d.getFullYear()).slice(-2);

  rows.push([
    Markup.button.callback("←", "admin_shift_tasks_date_prev"),
    Markup.button.callback(dd, "admin_shift_tasks_pick_day"),
    Markup.button.callback(mm, "admin_shift_tasks_pick_month"),
    Markup.button.callback(yy, "admin_shift_tasks_pick_year"),
    Markup.button.callback("→", "admin_shift_tasks_date_next"),
  ]);

  // если выбранная дата < сегодня (в таймзоне БД) — скрываем add/delete
  // важно: сравниваем как YYYY-MM-DD строки (лексикографически работает)
  // todayISO кладём в st при входе/выборе точки через dbTodayISO()
  const todayISO = st.todayISO || null;
  const isPast = todayISO ? st.dateISO < todayISO : false;

  if (!isPast) {
    rows.push([
      Markup.button.callback(
        `➕ Добавить задачу на ${fmtRuDate(st.dateISO)}`,
        "admin_shift_tasks_add"
      ),
    ]);
    rows.push([
      Markup.button.callback("🗑 Удалить задачу", "admin_shift_tasks_delete"),
    ]);
  }

  rows.push([
    Markup.button.callback(
      "⏰ Задачи по расписанию",
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

  const targetIds = Array.isArray(a.targetUserIds) ? a.targetUserIds : [];

  const whoLabel = targetIds.length
    ? `👤 Для кого? (выбрано: ${targetIds.length})`
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

  let text = `⏰ <b>Задачи по расписанию</b>\n\n`;
  text += `• Точка: <b>${escHtml(point.title)}</b>\n\n`;

  if (!scheduled.length) {
    text += `Пока нет задач по расписанию.\n`;
  } else {
    text += `<b>Список задач:</b>\n`;
    scheduled.forEach((r, idx) => {
      const n = idx + 1;
      const creator = r.creator_name ? ` (${r.creator_name})` : "";
      const on = r.is_active ? "" : " (выключена)";
      text += `${n}. ⏰ ${escHtml(r.title)}${on}\n`;
    });
    text += "__________________\n";
    text += "<i>Нажмите на нужный номер, для просмотра деталей</i>\n";
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

  // матчим на дату (+ overrides для переносов расписанных задач)
  const ov = await loadOverridesForDate(st.pointId, st.dateISO);

  const matched = allActive.filter((r) => {
    const aid = Number(r.assignment_id);
    if (ov.skip.has(aid)) return false;
    if (ov.include.has(aid)) return true;
    return scheduleMatchesDate(r, st.dateISO);
  });

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
      a.template_id,
      a.task_type,
      a.trade_point_id,
      a.is_active,
      a.created_by_user_id,
      u.full_name AS creator_name,
      u.username AS creator_username,
      u.work_phone AS creator_phone,

      -- counts:
      (SELECT COUNT(*)::int FROM task_assignment_targets tat WHERE tat.assignment_id = a.id) AS target_cnt,
      (SELECT COUNT(*)::int FROM task_assignment_responsibles tar WHERE tar.assignment_id = a.id) AS resp_cnt,

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

  let text = `⏰  <b>Задача по расписанию</b>\n\n`;
  text += `Задача: <b>${escHtml(row.title)}</b>\n`;

  // создатель отдельной строкой
  const creatorParts = [];
  if (row.creator_name) creatorParts.push(escHtml(row.creator_name));
  if (row.creator_username)
    creatorParts.push(`@${escHtml(row.creator_username)}`);
  text += `Создал задачу: <b>${
    creatorParts.length ? creatorParts.join(" / ") : "—"
  }</b>\n`;

  text += `Статус: <b>${status}</b>\n`;
  text += `Периодичность: <b>${scheduleLabel(row) || "—"}</b>\n`;
  // следующий день выполнения
  const nextD = nextScheduleDate(row);
  text += `Следующий день выполнения: <b>${
    nextD ? fmtShortDateYY(nextD) : "—"
  }</b>\n`;

  const targetCnt = Number(row.target_cnt || 0);
  const respCnt = Number(row.resp_cnt || 0);

  const whoBtnLabel = targetCnt
    ? `👤 Для кого? (выбрано ${targetCnt})`
    : "👥 Для кого? (все)";

  const respBtnLabel = respCnt
    ? `🤵‍♂️ Ответственные (выбрано ${respCnt})`
    : "🤵‍♂️ Ответственные (не назначены)";

  // точки, где есть эта задача (по template_id)
  let pointsBtnLabel = "📍 Точки";
  try {
    const pr = await pool.query(
      `
    SELECT p.id, p.title
    FROM task_assignments a
    JOIN trade_points p ON p.id = a.trade_point_id
    WHERE a.template_id = $1 AND a.task_type = $2 AND a.is_active = TRUE
    ORDER BY p.title ASC
    `,
      [row.template_id, row.task_type]
    );
    const pts = pr.rows || [];
    if (pts.length === 1) pointsBtnLabel = `📍 Точки (${pts[0].title})`;
    else if (pts.length > 1)
      pointsBtnLabel = `📍 Точки (выбрано ${pts.length})`;
  } catch (_) {}

  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "🔁 Поменять периодичность",
        `admin_shift_tasks_sched_period_${row.assignment_id}`
      ),
    ],
    [
      Markup.button.callback(
        respBtnLabel,
        `admin_shift_tasks_sched_resp_${row.assignment_id}`
      ),
    ],

    [
      Markup.button.callback(
        pointsBtnLabel,
        `admin_shift_tasks_sched_points_${row.assignment_id}`
      ),
    ],

    [
      Markup.button.callback(
        whoBtnLabel,
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

// -----------------------------
// SCHEDULE RESPONSIBLES (helpers)
// -----------------------------
async function loadSchedResponsibles(assignmentId) {
  const r = await pool.query(
    `
    SELECT u.id, u.full_name, u.username, u.work_phone
    FROM task_assignment_responsibles ar
    JOIN users u ON u.id = ar.user_id
    WHERE ar.assignment_id = $1
    ORDER BY u.full_name NULLS LAST, u.id ASC
    `,
    [assignmentId]
  );
  return r.rows;
}

async function loadSchedRespSettings(assignmentId) {
  await ensureShiftTasksSchema();

  const baseDefault = {
    assignment_id: assignmentId,
    enabled: false,
    days_before: 0,
    completion_enabled: true, // по умолчанию включено
  };

  try {
    const r = await pool.query(
      `
      SELECT
        assignment_id,
        notifications_enabled AS enabled,
        days_before,
        COALESCE(completion_notifications_enabled, TRUE) AS completion_enabled
      FROM task_assignment_responsible_settings
      WHERE assignment_id = $1
      LIMIT 1
      `,
      [assignmentId]
    );
    return r.rows[0] || baseDefault;
  } catch (e) {
    // fallback если колонки нет
    const r = await pool.query(
      `
      SELECT
        assignment_id,
        notifications_enabled AS enabled,
        days_before
      FROM task_assignment_responsible_settings
      WHERE assignment_id = $1
      LIMIT 1
      `,
      [assignmentId]
    );
    return r.rows[0] ? { ...r.rows[0], completion_enabled: true } : baseDefault;
  }
}

async function upsertSchedRespSettings(assignmentId, patch) {
  await ensureShiftTasksSchema();

  const enabled =
    typeof patch.enabled === "boolean" ? patch.enabled : undefined;
  const daysBefore = Number.isInteger(patch.days_before)
    ? patch.days_before
    : undefined;
  const completionEnabled =
    typeof patch.completion_enabled === "boolean"
      ? patch.completion_enabled
      : undefined;

  const cur = await loadSchedRespSettings(assignmentId);

  const nextEnabled = enabled === undefined ? cur.enabled : enabled;
  const nextDays = daysBefore === undefined ? cur.days_before : daysBefore;
  const nextCompletion =
    completionEnabled === undefined
      ? typeof cur.completion_enabled === "boolean"
        ? cur.completion_enabled
        : true
      : completionEnabled;

  // Пишем с completion_notifications_enabled; если колонки вдруг нет — fallback.
  try {
    await pool.query(
      `
      INSERT INTO task_assignment_responsible_settings
        (assignment_id, notifications_enabled, days_before, completion_notifications_enabled, updated_at)
      VALUES ($1, $2, $3, $4, now())
      ON CONFLICT (assignment_id) DO UPDATE
        SET notifications_enabled = EXCLUDED.notifications_enabled,
            days_before = EXCLUDED.days_before,
            completion_notifications_enabled = EXCLUDED.completion_notifications_enabled,
            updated_at = now()
      `,
      [assignmentId, nextEnabled, nextDays, nextCompletion]
    );
  } catch (_) {
    await pool.query(
      `
      INSERT INTO task_assignment_responsible_settings
        (assignment_id, notifications_enabled, days_before, updated_at)
      VALUES ($1, $2, $3, now())
      ON CONFLICT (assignment_id) DO UPDATE
        SET notifications_enabled = EXCLUDED.notifications_enabled,
            days_before = EXCLUDED.days_before,
            updated_at = now()
      `,
      [assignmentId, nextEnabled, nextDays]
    );
  }

  return {
    assignment_id: assignmentId,
    enabled: nextEnabled,
    days_before: nextDays,
    completion_enabled: nextCompletion,
  };
}

async function loadAssignmentTitle(assignmentId) {
  const r = await pool.query(
    `
    SELECT a.id, t.title
    FROM task_assignments a
    JOIN task_templates t ON t.id = a.template_id
    WHERE a.id = $1
    LIMIT 1
    `,
    [assignmentId]
  );
  return r.rows[0] || null;
}

async function searchUsersPaged(q, page, limit = 10) {
  const offset = page * limit;

  // если пришло @username
  const qq = (q || "").trim();
  const like = `%${qq.replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;

  const r = await pool.query(
    `
    SELECT id, full_name, username, work_phone
    FROM users
    WHERE
      ($1 = '' OR
        (username IS NOT NULL AND username ILIKE $2) OR
        (work_phone IS NOT NULL AND work_phone ILIKE $2) OR
        (full_name IS NOT NULL AND full_name ILIKE $2)
      )
    ORDER BY full_name NULLS LAST, id ASC
    LIMIT $3 OFFSET $4
    `,
    [qq, like, limit, offset]
  );

  // всего (для пагинации)
  const c = await pool.query(
    `
    SELECT COUNT(*)::int AS cnt
    FROM users
    WHERE
      ($1 = '' OR
        (username IS NOT NULL AND username ILIKE $2) OR
        (work_phone IS NOT NULL AND work_phone ILIKE $2) OR
        (full_name IS NOT NULL AND full_name ILIKE $2)
      )
    `,
    [qq, like]
  );

  return { rows: r.rows, total: c.rows[0]?.cnt || 0 };
}

function fmtUserLine(u) {
  const name = u.full_name || `id:${u.id}`;
  const uname = u.username ? `@${u.username}` : "";
  const phone = u.work_phone ? u.work_phone : "";
  const parts = [name, uname, phone].filter(Boolean);
  return parts.join(" / ");
}

// -----------------------------
// SCHEDULE RESPONSIBLES (screens)
// -----------------------------
async function renderSchedRespScreen(ctx, user, assignmentId) {
  const a = await loadAssignmentTitle(assignmentId);
  if (!a) {
    await ctx.answerCbQuery("Не найдено", { show_alert: true }).catch(() => {});
    return;
  }

  const resp = await loadSchedResponsibles(assignmentId);
  const settings = await loadSchedRespSettings(assignmentId);

  let text = `🤵‍♂️ <b>Ответственные задачи</b>\n\n`;
  text += `Задача: <b>${escHtml(a.title)}</b>\n\n`;

  if (!resp.length) {
    text += `Сейчас ответственных нет.\n`;
    text += `\nℹ️ Если ответственных нет — уведомления включить нельзя.\n`;
  } else {
    text += `Ответственные (нажмите чтобы удалить):\n`;
    resp.forEach((u, i) => {
      text += `✅ ${i + 1}. ${escHtml(fmtUserLine(u))}\n`;
    });
  }

  const notifLine = settings.enabled
    ? `🔔 Уведомления: <b>включены</b>\n`
    : `🔕 Уведомления: <b>выключены</b>\n`;
  const daysLine = settings.enabled
    ? `⏳ За сколько дней напоминать: <b>${settings.days_before}</b>\n`
    : "";

  text += `\n${notifLine}${daysLine}`;

  const rows = [];

  // кнопки удаления ответственных (каждый — отдельная кнопка)
  if (resp.length) {
    resp.forEach((u, i) => {
      rows.push([
        Markup.button.callback(
          `✅ ${i + 1}. ${u.full_name || u.username || u.id}`,
          `admin_shift_tasks_sched_resp_rm_${assignmentId}_${u.id}`
        ),
      ]);
    });
  }

  rows.push([
    Markup.button.callback(
      "➕ Добавить ответственного",
      `admin_shift_tasks_sched_resp_add_${assignmentId}_0`
    ),
  ]);

  // toggle уведомлений
  if (settings.enabled) {
    rows.push([
      Markup.button.callback(
        "🔕 Выключить уведомления",
        `admin_shift_tasks_sched_resp_notif_off_${assignmentId}`
      ),
    ]);
  } else {
    rows.push([
      Markup.button.callback(
        "🔔 Включить уведомления",
        `admin_shift_tasks_sched_resp_notif_on_${assignmentId}`
      ),
    ]);
  }

  rows.push([
    Markup.button.callback(
      "⬅️ Назад",
      `admin_shift_tasks_sched_card_${assignmentId}`
    ),
  ]);

  setSt(ctx.from.id, {
    mode: "sched_resp",
    schedResp: { assignmentId, page: 0, q: "" },
  });

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(rows) },
    { edit: true }
  );
}

async function renderSchedRespAddScreen(ctx, user, assignmentId, page, q) {
  const a = await loadAssignmentTitle(assignmentId);
  if (!a) {
    await ctx.answerCbQuery("Не найдено", { show_alert: true }).catch(() => {});
    return;
  }

  const selected = await loadSchedResponsibles(assignmentId);
  const selectedSet = new Set(selected.map((x) => Number(x.id)));

  const { rows, total } = await searchUsersPaged(q || "", page || 0, 10);
  const pages = Math.max(1, Math.ceil(total / 10));

  let text = `👤 <b>Добавить ответственного</b>\n\n`;
  text += `Задача: <b>${escHtml(a.title)}</b>\n\n`;
  text += `Для быстрого поиска введите @username, телефон или часть имени.\n`;
  text += `Можно также переслать сообщение пользователя.\n\n`;
  text += `Страница: <b>${(page || 0) + 1}/${pages}</b>\n`;

  const kb = [];

  // список пользователей (✅ если уже выбран)
  rows.forEach((u) => {
    const isSel = selectedSet.has(Number(u.id));
    kb.push([
      Markup.button.callback(
        `${isSel ? "✅ " : ""}${u.full_name || u.username || u.id}`,
        `admin_shift_tasks_sched_resp_pick_${assignmentId}_${u.id}_${page || 0}`
      ),
    ]);
  });

  // пагинация
  const nav = [];
  if ((page || 0) > 0) {
    nav.push(
      Markup.button.callback(
        "⬅️",
        `admin_shift_tasks_sched_resp_add_${assignmentId}_${(page || 0) - 1}`
      )
    );
  }
  if ((page || 0) < pages - 1) {
    nav.push(
      Markup.button.callback(
        "➡️",
        `admin_shift_tasks_sched_resp_add_${assignmentId}_${(page || 0) + 1}`
      )
    );
  }
  if (nav.length) kb.push(nav);

  kb.push([
    Markup.button.callback(
      "⬅️ Назад",
      `admin_shift_tasks_sched_resp_${assignmentId}`
    ),
  ]);

  setSt(ctx.from.id, {
    mode: "sched_resp_add",
    schedResp: { assignmentId, page: page || 0, q: q || "" },
  });

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(kb) },
    { edit: true }
  );
}

async function renderSchedRespDaysScreen(ctx, user, assignmentId) {
  const a = await loadAssignmentTitle(assignmentId);
  if (!a) {
    await ctx.answerCbQuery("Не найдено", { show_alert: true }).catch(() => {});
    return;
  }

  let text = `🔔 <b>Уведомления по задаче</b>\n\n`;
  text += `Задача: <b>${escHtml(a.title)}</b>\n\n`;
  text += `За сколько дней до выполнения присылать уведомление?\n`;
  text += `Введите число (например 1, 2, 3).\n\n`;
  text += `Или нажмите «в день выполнения».\n`;

  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "📅 В день выполнения",
        `admin_shift_tasks_sched_resp_days_set0_${assignmentId}`
      ),
    ],
    [
      Markup.button.callback(
        "⬅️ Назад",
        `admin_shift_tasks_sched_resp_${assignmentId}`
      ),
    ],
  ]);

  setSt(ctx.from.id, {
    mode: "sched_resp_days",
    schedResp: { assignmentId, page: 0, q: "" },
  });

  await deliver(ctx, { text, extra: kb }, { edit: true });
}



module.exports = {
  buildAddKeyboard,
  buildAnswerTypePicker,
  buildDatePicker,
  buildDeleteKeyboard,
  buildEditPeriodOptionsKeyboard,
  buildEditPeriodPickKeyboard,
  buildMainKeyboard,
  buildPeriodPicker,
  buildSchedFilterKeyboard,
  buildTasksText,
  buildWeekdaysPicker,
  clearSt,
  fmtUserLine,
  getPointActiveShiftInfo,
  getSt,
  isAdmin,
  loadAssignmentTitle,
  loadAssignmentsForPoint,
  loadDoneInfoMap,
  loadPoints,
  loadSchedRespSettings,
  loadSchedResponsibles,
  maskToWeekdays,
  renderCreateUsersScreenA,
  renderCreateUsersScreenB,
  renderPickPoint,
  renderPointScreen,
  renderSchedRespAddScreen,
  renderSchedRespDaysScreen,
  renderSchedRespScreen,
  renderSchedUsersScreenA,
  renderSchedUsersScreenB,
  renderScheduledCard,
  renderScheduledList,
  scheduleLabel,
  scheduleMark,
  searchUsersPaged,
  sendNewTasksNotification,
  setSt,
  timeLabel,
  trunc,
  typeEmoji,
  upsertSchedRespSettings
};
