// src/bot/admin/tasks/create.js
const { Markup } = require("telegraf");
const pool = require("../../../db/pool");
const { deliver } = require("../../../utils/renderHelpers");

const createStates = new Map();

/**
 * State shape:
 * {
 *   mode: "tcreate",
 *   step: string,
 *   taskType: "individual" | "global",
 *   selectedUserIds: number[],
 *
 *   // template selection / creation
 *   source: "new" | "saved",
 *   templateId: number|null,
 *   draftTitle: string|null,
 *   draftAnswerType: "text"|"number"|"photo"|"video"|null,
 *   saveAsTemplate: boolean|null,
 *
 *   // point scope
 *   pointScope: "all_points" | "one_point",
 *   tradePointId: number|null,
 *
 *   // schedule
 *   isRecurring: boolean|null,
 *   scheduleType: "single"|"weekly"|"every_x_days"|null,
 *   singleDate: string|null,      // YYYY-MM-DD
 *   startDate: string|null,       // YYYY-MM-DD (for weekly/every_x_days)
 *   weekdaysMask: number,         // weekly bitmask
 *   everyXDays: number|null,
 *
 *   timeMode: "all_day"|"deadline_time"|null,
 *   deadlineTime: string|null,    // HH:MM
 * }
 */

function getState(tgId) {
  return createStates.get(tgId) || null;
}
function setState(tgId, s) {
  createStates.set(tgId, s);
}
function clearState(tgId) {
  createStates.delete(tgId);
}

function isAdmin(user) {
  return user && (user.role === "admin" || user.role === "super_admin");
}

function trunc(s, n = 40) {
  const t = (s || "").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}

// Accepts YYYY-MM-DD or DD.MM.YYYY
function normalizeDate(input) {
  const raw = (input || "").trim();
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  const ru = /^(\d{2})\.(\d{2})\.(\d{4})$/;

  if (iso.test(raw)) return raw;
  const m = raw.match(ru);
  if (m) {
    const dd = m[1];
    const mm = m[2];
    const yyyy = m[3];
    return `${yyyy}-${mm}-${dd}`;
  }
  return null;
}

// Accepts HH:MM
function normalizeTime(input) {
  const raw = (input || "").trim();
  const re = /^([01]\d|2[0-3]):([0-5]\d)$/;
  return re.test(raw) ? raw : null;
}

// Weekday bit mapping (Mon=1<<0 ... Sun=1<<6)
const WD = [
  { key: "mon", label: "Пн", bit: 1 << 0 },
  { key: "tue", label: "Вт", bit: 1 << 1 },
  { key: "wed", label: "Ср", bit: 1 << 2 },
  { key: "thu", label: "Чт", bit: 1 << 3 },
  { key: "fri", label: "Пт", bit: 1 << 4 },
  { key: "sat", label: "Сб", bit: 1 << 5 },
  { key: "sun", label: "Вс", bit: 1 << 6 },
];

async function showStepType(ctx) {
  const text = "📝 <b>Создать задачу</b>\n\nКакая задача?";
  const keyboard = Markup.inlineKeyboard([
    [{ text: "👤 Индивидуальная", callback_data: "tcreate_type_individual" }],
    [{ text: "🌐 Общая (для всех)", callback_data: "tcreate_type_global" }],
    [{ text: "❌ Отмена", callback_data: "tcreate_cancel" }],
  ]);
  await deliver(ctx, { text, extra: keyboard }, { edit: true });
}

async function showStepUsers(ctx, selectedIds) {
  const res = await pool.query(
    `
      SELECT id, full_name, staff_status
      FROM users
      WHERE staff_status IN ('intern','worker')
      ORDER BY full_name
      LIMIT 40
    `
  );

  let text = "👥 <b>Выбор пользователей</b>\n";
  text += "Нажимай, чтобы отметить ✅\n\n";

  const buttons = [];
  for (const u of res.rows) {
    const checked = selectedIds.has(u.id) ? "✅ " : "";
    const status = u.staff_status === "intern" ? "🎓" : "👨‍💼";
    buttons.push([
      Markup.button.callback(
        `${checked}${status} ${u.full_name || "Без имени"}`,
        `tcreate_users_toggle_${u.id}`
      ),
    ]);
  }

  buttons.push([Markup.button.callback("➡️ Продолжить", "tcreate_users_done")]);
  buttons.push([Markup.button.callback("⬅️ Назад", "tcreate_users_back")]);
  buttons.push([Markup.button.callback("❌ Отмена", "tcreate_cancel")]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(buttons) },
    { edit: true }
  );
}

async function showStepSource(ctx) {
  const text = "📌 <b>Откуда берём задачу?</b>";
  const keyboard = Markup.inlineKeyboard([
    [{ text: "➕ Новая задача", callback_data: "tcreate_source_new" }],
    [{ text: "📌 Сохранённая задача", callback_data: "tcreate_source_saved" }],
    [{ text: "⬅️ Назад", callback_data: "tcreate_source_back" }],
    [{ text: "❌ Отмена", callback_data: "tcreate_cancel" }],
  ]);
  await deliver(ctx, { text, extra: keyboard }, { edit: true });
}

async function showAwaitNewDescription(ctx) {
  const text =
    "➕ <b>Новая задача</b>\n\n" +
    "1) Отправьте <b>описание задачи</b> одним сообщением.\n\n" +
    "Пример: «Проверить чистоту витрины»";
  const keyboard = Markup.inlineKeyboard([
    [{ text: "⬅️ Назад", callback_data: "tcreate_source_back" }],
    [{ text: "❌ Отмена", callback_data: "tcreate_cancel" }],
  ]);
  await deliver(ctx, { text, extra: keyboard }, { edit: true });
}

async function showPickAnswerType(ctx, title) {
  const text =
    "2) Выберите <b>тип ответа</b> для задачи:\n\n" +
    `📝 Описание: <i>${trunc(title, 80)}</i>`;
  const keyboard = Markup.inlineKeyboard([
    [{ text: "📝 Текст", callback_data: "tcreate_new_answer_text" }],
    [{ text: "🔢 Число", callback_data: "tcreate_new_answer_number" }],
    [{ text: "📷 Фото", callback_data: "tcreate_new_answer_photo" }],
    [{ text: "🎥 Видео", callback_data: "tcreate_new_answer_video" }],
    [{ text: "⬅️ Назад", callback_data: "tcreate_new_back_to_desc" }],
    [{ text: "❌ Отмена", callback_data: "tcreate_cancel" }],
  ]);
  await deliver(ctx, { text, extra: keyboard }, { edit: true });
}

async function showAskSaveTemplate(ctx) {
  const text = "3) Сохранить задачу как <b>шаблон</b>?";
  const keyboard = Markup.inlineKeyboard([
    [{ text: "✅ Да", callback_data: "tcreate_save_tpl_yes" }],
    [{ text: "❌ Нет", callback_data: "tcreate_save_tpl_no" }],
    [{ text: "⬅️ Назад", callback_data: "tcreate_save_tpl_back" }],
    [{ text: "❌ Отмена", callback_data: "tcreate_cancel" }],
  ]);
  await deliver(ctx, { text, extra: keyboard }, { edit: true });
}

async function showPickTemplateList(ctx) {
  const res = await pool.query(
    `
      SELECT id, title, answer_type
      FROM task_templates
      WHERE is_active = TRUE
      ORDER BY id DESC
      LIMIT 30
    `
  );

  let text = "📌 <b>Сохранённые шаблоны</b>\n\n";
  if (!res.rows.length) {
    text +=
      "Пока нет ни одного шаблона.\n\nСоздайте «➕ Новая задача» и сохраните как шаблон.";
    const keyboard = Markup.inlineKeyboard([
      [{ text: "⬅️ Назад", callback_data: "tcreate_source_back" }],
      [{ text: "❌ Отмена", callback_data: "tcreate_cancel" }],
    ]);
    await deliver(ctx, { text, extra: keyboard }, { edit: true });
    return;
  }

  const buttons = [];
  for (const t of res.rows) {
    const typeEmoji =
      t.answer_type === "text"
        ? "📝"
        : t.answer_type === "number"
        ? "🔢"
        : t.answer_type === "photo"
        ? "📷"
        : "🎥";
    buttons.push([
      Markup.button.callback(
        `${typeEmoji} #${t.id} ${trunc(t.title, 42)}`,
        `tcreate_tpl_pick_${t.id}`
      ),
    ]);
  }
  buttons.push([Markup.button.callback("⬅️ Назад", "tcreate_source_back")]);
  buttons.push([Markup.button.callback("❌ Отмена", "tcreate_cancel")]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(buttons) },
    { edit: true }
  );
}

async function showPointScope(ctx) {
  const text = "🏬 <b>Для каких точек задача?</b>";
  const keyboard = Markup.inlineKeyboard([
    [{ text: "🌐 Для всех точек", callback_data: "tcreate_point_all" }],
    [{ text: "📍 Для конкретной точки", callback_data: "tcreate_point_one" }],
    [{ text: "⬅️ Назад", callback_data: "tcreate_point_back" }],
    [{ text: "❌ Отмена", callback_data: "tcreate_cancel" }],
  ]);
  await deliver(ctx, { text, extra: keyboard }, { edit: true });
}

async function showPickTradePoint(ctx) {
  const res = await pool.query(
    `
      SELECT id, title
      FROM trade_points
      WHERE is_active = TRUE
      ORDER BY id
    `
  );

  let text = "📍 <b>Выберите торговую точку</b>";
  const buttons = [];
  for (const p of res.rows) {
    buttons.push([
      Markup.button.callback(`${p.title}`, `tcreate_point_pick_${p.id}`),
    ]);
  }
  buttons.push([Markup.button.callback("⬅️ Назад", "tcreate_point_back")]);
  buttons.push([Markup.button.callback("❌ Отмена", "tcreate_cancel")]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(buttons) },
    { edit: true }
  );
}

async function showAskRecurring(ctx) {
  const text = "🗓 <b>Задача по расписанию?</b>";
  const keyboard = Markup.inlineKeyboard([
    [{ text: "✅ Да", callback_data: "tcreate_sched_yes" }],
    [{ text: "❌ Нет (разовая)", callback_data: "tcreate_sched_no" }],
    [{ text: "⬅️ Назад", callback_data: "tcreate_sched_back" }],
    [{ text: "❌ Отмена", callback_data: "tcreate_cancel" }],
  ]);
  await deliver(ctx, { text, extra: keyboard }, { edit: true });
}

async function showAskSingleDate(ctx) {
  const text =
    "📅 <b>Дата разовой задачи</b>\n\n" +
    "Отправьте дату:\n" +
    "• <code>YYYY-MM-DD</code> (например 2025-12-18)\n" +
    "или\n" +
    "• <code>DD.MM.YYYY</code> (например 18.12.2025)";
  const keyboard = Markup.inlineKeyboard([
    [{ text: "⬅️ Назад", callback_data: "tcreate_sched_back" }],
    [{ text: "❌ Отмена", callback_data: "tcreate_cancel" }],
  ]);
  await deliver(ctx, { text, extra: keyboard }, { edit: true });
}

async function showPickRecurringType(ctx) {
  const text = "🔁 <b>Тип расписания</b>";
  const keyboard = Markup.inlineKeyboard([
    [{ text: "📅 По дням недели", callback_data: "tcreate_sched_weekdays" }],
    [{ text: "⏱ Каждые X дней", callback_data: "tcreate_sched_everyx" }],
    [{ text: "⬅️ Назад", callback_data: "tcreate_sched_back" }],
    [{ text: "❌ Отмена", callback_data: "tcreate_cancel" }],
  ]);
  await deliver(ctx, { text, extra: keyboard }, { edit: true });
}

async function showPickWeekdays(ctx, mask) {
  let text = "📅 <b>Выберите дни недели</b>\n\n";
  text += "Нажимай для мультивыбора ✅\n";

  const rows = [];
  for (const d of WD) {
    const on = (mask & d.bit) !== 0;
    rows.push([
      Markup.button.callback(
        `${on ? "✅ " : ""}${d.label}`,
        `tcreate_wd_toggle_${d.key}`
      ),
    ]);
  }

  rows.push([Markup.button.callback("➡️ Продолжить", "tcreate_wd_done")]);
  rows.push([Markup.button.callback("⬅️ Назад", "tcreate_wd_back")]);
  rows.push([Markup.button.callback("❌ Отмена", "tcreate_cancel")]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(rows) },
    { edit: true }
  );
}

async function showAskEveryX(ctx) {
  const text =
    "⏱ <b>Каждые сколько дней?</b>\n\n" + "Отправьте число X (например 3).";
  const keyboard = Markup.inlineKeyboard([
    [{ text: "⬅️ Назад", callback_data: "tcreate_schedtype_back" }],
    [{ text: "❌ Отмена", callback_data: "tcreate_cancel" }],
  ]);
  await deliver(ctx, { text, extra: keyboard }, { edit: true });
}

async function showPickTimeMode(ctx) {
  const text = "⏰ <b>Время выполнения</b>";
  const keyboard = Markup.inlineKeyboard([
    [{ text: "📆 В течение дня", callback_data: "tcreate_time_allday" }],
    [{ text: "🕒 Задать время (до HH:MM)", callback_data: "tcreate_time_set" }],
    [{ text: "⬅️ Назад", callback_data: "tcreate_time_back" }],
    [{ text: "❌ Отмена", callback_data: "tcreate_cancel" }],
  ]);
  await deliver(ctx, { text, extra: keyboard }, { edit: true });
}

async function showAskDeadlineTime(ctx) {
  const text =
    "🕒 <b>Введите время дедлайна</b>\n\n" +
    "Формат: <code>HH:MM</code> (например 14:00)";
  const keyboard = Markup.inlineKeyboard([
    [{ text: "⬅️ Назад", callback_data: "tcreate_time_back" }],
    [{ text: "❌ Отмена", callback_data: "tcreate_cancel" }],
  ]);
  await deliver(ctx, { text, extra: keyboard }, { edit: true });
}

function buildSummary(st) {
  const who =
    st.taskType === "global"
      ? "🌐 Общая (для всех)"
      : `👤 Индивидуальная (пользователей: ${st.selectedUserIds.length})`;

  const point =
    st.pointScope === "all_points"
      ? "🏬 Для всех точек"
      : `📍 Для точки #${st.tradePointId}`;

  const tpl = st.templateId
    ? `📌 Шаблон #${st.templateId}`
    : "📌 Шаблон: (нет)";
  const title = st.draftTitle ? `📝 ${trunc(st.draftTitle, 80)}` : "";
  const at = st.draftAnswerType ? `Тип ответа: ${st.draftAnswerType}` : "";

  let sched = "";
  if (st.scheduleType === "single") sched = `Разовая: ${st.singleDate}`;
  if (st.scheduleType === "weekly")
    sched = `По дням недели (mask=${st.weekdaysMask})`;
  if (st.scheduleType === "every_x_days")
    sched = `Каждые ${st.everyXDays} дней (старт: ${st.startDate})`;

  let time =
    st.timeMode === "all_day" ? "В течение дня" : `До ${st.deadlineTime}`;

  return (
    "✅ <b>Проверьте задачу</b>\n\n" +
    `${who}\n` +
    `${point}\n\n` +
    `${tpl}\n${title}\n${at}\n\n` +
    `🗓 Расписание: ${sched}\n` +
    `⏰ Время: ${time}`
  );
}

async function showConfirm(ctx, st) {
  const text = buildSummary(st);
  const keyboard = Markup.inlineKeyboard([
    [{ text: "✅ Создать", callback_data: "tcreate_confirm" }],
    [{ text: "⬅️ Назад", callback_data: "tcreate_confirm_back" }],
    [{ text: "❌ Отмена", callback_data: "tcreate_cancel" }],
  ]);
  await deliver(ctx, { text, extra: keyboard }, { edit: true });
}

async function persistAll(ctx, adminUser, st) {
  // Ensure templateId exists (for new task we create it now)
  let templateId = st.templateId;

  if (!templateId) {
    // create template (if user said "no", we keep it inactive so it won't pollute list)
    const isActive = !!st.saveAsTemplate;
    const insTpl = await pool.query(
      `
        INSERT INTO task_templates (title, answer_type, is_active, created_by_user_id)
        VALUES ($1, $2, $3, $4)
        RETURNING id
      `,
      [st.draftTitle, st.draftAnswerType, isActive, adminUser.id]
    );
    templateId = insTpl.rows[0].id;
  }

  // create assignment
  const insAsg = await pool.query(
    `
      INSERT INTO task_assignments
        (task_type, template_id, created_by_user_id, point_scope, trade_point_id, is_active)
      VALUES
        ($1, $2, $3, $4, $5, TRUE)
      RETURNING id
    `,
    [
      st.taskType,
      templateId,
      adminUser.id,
      st.pointScope,
      st.pointScope === "one_point" ? st.tradePointId : null,
    ]
  );
  const assignmentId = insAsg.rows[0].id;

  // targets for individual
  if (st.taskType === "individual") {
    for (const uid of st.selectedUserIds) {
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
  await pool.query(
    `
      INSERT INTO task_schedules
        (assignment_id, schedule_type, start_date, single_date, weekdays_mask, every_x_days, time_mode, deadline_time)
      VALUES
        ($1, $2, $3, $4, $5, $6, $7, $8)
    `,
    [
      assignmentId,
      st.scheduleType,
      st.scheduleType === "weekly" || st.scheduleType === "every_x_days"
        ? st.startDate
        : null,
      st.scheduleType === "single" ? st.singleDate : null,
      st.scheduleType === "weekly" ? st.weekdaysMask : null,
      st.scheduleType === "every_x_days" ? st.everyXDays : null,
      st.timeMode,
      st.timeMode === "deadline_time" ? st.deadlineTime : null,
    ]
  );

  return { assignmentId, templateId };
}

function registerAdminTaskCreate(bot, ensureUser, logError) {
  // -------------------- ENTRY --------------------
  bot.action("admin_task_create", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      setState(ctx.from.id, {
        mode: "tcreate",
        step: "type",
        taskType: null,
        selectedUserIds: [],

        source: null,
        templateId: null,
        draftTitle: null,
        draftAnswerType: null,
        saveAsTemplate: null,

        pointScope: null,
        tradePointId: null,

        isRecurring: null,
        scheduleType: null,
        singleDate: null,
        startDate: null,
        weekdaysMask: 0,
        everyXDays: null,

        timeMode: null,
        deadlineTime: null,
      });

      await showStepType(ctx);
    } catch (err) {
      logError("admin_task_create", err);
    }
  });

  // -------------------- CANCEL --------------------
  bot.action("tcreate_cancel", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      clearState(ctx.from.id);

      await deliver(
        ctx,
        {
          text: "Ок, отменено.",
          extra: Markup.inlineKeyboard([
            [{ text: "🛠 Админ-панель", callback_data: "lk_admin_menu" }],
          ]),
        },
        { edit: true }
      );
    } catch (err) {
      logError("tcreate_cancel", err);
    }
  });

  // -------------------- STEP: TYPE --------------------
  bot.action("tcreate_type_individual", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getState(ctx.from.id);
      if (!st) return;

      st.step = "users";
      st.taskType = "individual";
      setState(ctx.from.id, st);

      await showStepUsers(ctx, new Set(st.selectedUserIds));
    } catch (err) {
      logError("tcreate_type_individual", err);
    }
  });

  bot.action("tcreate_type_global", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getState(ctx.from.id);
      if (!st) return;

      st.step = "source";
      st.taskType = "global";
      st.selectedUserIds = [];
      setState(ctx.from.id, st);

      await showStepSource(ctx);
    } catch (err) {
      logError("tcreate_type_global", err);
    }
  });

  // -------------------- STEP: USERS --------------------
  bot.action(/^tcreate_users_toggle_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getState(ctx.from.id);
      if (!st || st.step !== "users") return;

      const uid = Number(ctx.match[1]);
      const set = new Set(st.selectedUserIds || []);
      if (set.has(uid)) set.delete(uid);
      else set.add(uid);

      st.selectedUserIds = Array.from(set);
      setState(ctx.from.id, st);

      await showStepUsers(ctx, set);
    } catch (err) {
      logError("tcreate_users_toggle", err);
    }
  });

  bot.action("tcreate_users_back", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getState(ctx.from.id);
      if (!st) return;

      st.step = "type";
      st.taskType = null;
      st.selectedUserIds = [];
      setState(ctx.from.id, st);

      await showStepType(ctx);
    } catch (err) {
      logError("tcreate_users_back", err);
    }
  });

  bot.action("tcreate_users_done", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getState(ctx.from.id);
      if (!st || st.step !== "users") return;

      if (!st.selectedUserIds?.length) {
        await ctx
          .answerCbQuery("Выбери хотя бы одного пользователя", {
            show_alert: true,
          })
          .catch(() => {});
        return;
      }

      st.step = "source";
      setState(ctx.from.id, st);

      await showStepSource(ctx);
    } catch (err) {
      logError("tcreate_users_done", err);
    }
  });

  // -------------------- STEP: SOURCE --------------------
  bot.action("tcreate_source_back", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getState(ctx.from.id);
      if (!st || st.step !== "source") return;

      if (st.taskType === "individual") {
        st.step = "users";
        setState(ctx.from.id, st);
        await showStepUsers(ctx, new Set(st.selectedUserIds || []));
      } else {
        st.step = "type";
        setState(ctx.from.id, st);
        await showStepType(ctx);
      }
    } catch (err) {
      logError("tcreate_source_back", err);
    }
  });

  bot.action("tcreate_source_new", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getState(ctx.from.id);
      if (!st || st.step !== "source") return;

      st.source = "new";
      st.step = "new_desc";
      st.templateId = null;
      st.draftTitle = null;
      st.draftAnswerType = null;
      st.saveAsTemplate = null;
      setState(ctx.from.id, st);

      await showAwaitNewDescription(ctx);
    } catch (err) {
      logError("tcreate_source_new", err);
    }
  });

  bot.action("tcreate_source_saved", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getState(ctx.from.id);
      if (!st || st.step !== "source") return;

      st.source = "saved";
      st.step = "tpl_list";
      setState(ctx.from.id, st);

      await showPickTemplateList(ctx);
    } catch (err) {
      logError("tcreate_source_saved", err);
    }
  });

  // -------------------- STEP: NEW TASK (DESCRIPTION via text) --------------------
  bot.on("text", async (ctx, next) => {
    const st = getState(ctx.from.id);
    if (!st || st.mode !== "tcreate") return next();

    try {
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return next();

      const txt = (ctx.message.text || "").trim();
      if (!txt) return next();

      // new description
      if (st.step === "new_desc") {
        st.draftTitle = txt;
        st.step = "new_type";
        setState(ctx.from.id, st);
        await showPickAnswerType(ctx, st.draftTitle);
        return;
      }

      // single date
      if (st.step === "single_date") {
        const d = normalizeDate(txt);
        if (!d) {
          await ctx.reply(
            "❌ Неверный формат даты. Пример: 2025-12-18 или 18.12.2025"
          );
          return;
        }
        st.singleDate = d;
        st.step = "time_mode";
        setState(ctx.from.id, st);
        await showPickTimeMode(ctx);
        return;
      }

      // every X days
      if (st.step === "everyx_input") {
        const x = Number(txt);
        if (!Number.isFinite(x) || x <= 0 || x > 365) {
          await ctx.reply("❌ Введите число X от 1 до 365");
          return;
        }
        st.everyXDays = Math.floor(x);
        // start date = today (простое MVP)
        st.startDate = new Date().toISOString().slice(0, 10);
        st.step = "time_mode";
        setState(ctx.from.id, st);
        await showPickTimeMode(ctx);
        return;
      }

      // deadline time
      if (st.step === "deadline_time") {
        const t = normalizeTime(txt);
        if (!t) {
          await ctx.reply("❌ Неверный формат. Пример: 14:00");
          return;
        }
        st.deadlineTime = t;
        st.step = "confirm";
        setState(ctx.from.id, st);
        await showConfirm(ctx, st);
        return;
      }

      return next();
    } catch (e) {
      // не роняем весь бот из-за мастера
      return next();
    }
  });

  // back from type pick to description
  bot.action("tcreate_new_back_to_desc", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getState(ctx.from.id);
      if (!st) return;

      st.step = "new_desc";
      st.draftAnswerType = null;
      setState(ctx.from.id, st);
      await showAwaitNewDescription(ctx);
    } catch (err) {
      logError("tcreate_new_back_to_desc", err);
    }
  });

  // answer type pick
  bot.action(/^tcreate_new_answer_(text|number|photo|video)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getState(ctx.from.id);
      if (!st || st.step !== "new_type") return;

      st.draftAnswerType = ctx.match[1];
      st.step = "save_tpl";
      setState(ctx.from.id, st);

      await showAskSaveTemplate(ctx);
    } catch (err) {
      logError("tcreate_new_answer_pick", err);
    }
  });

  bot.action("tcreate_save_tpl_back", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getState(ctx.from.id);
      if (!st) return;

      st.step = "new_type";
      st.saveAsTemplate = null;
      setState(ctx.from.id, st);

      await showPickAnswerType(ctx, st.draftTitle);
    } catch (err) {
      logError("tcreate_save_tpl_back", err);
    }
  });

  bot.action(/^tcreate_save_tpl_(yes|no)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getState(ctx.from.id);
      if (!st || st.step !== "save_tpl") return;

      st.saveAsTemplate = ctx.match[1] === "yes";
      st.step = "point_scope";
      setState(ctx.from.id, st);

      await showPointScope(ctx);
    } catch (err) {
      logError("tcreate_save_tpl_yesno", err);
    }
  });

  // -------------------- STEP: SAVED TEMPLATE PICK --------------------
  bot.action(/^tcreate_tpl_pick_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getState(ctx.from.id);
      if (!st) return;

      const templateId = Number(ctx.match[1]);
      st.templateId = templateId;

      // load template for summary fields (optional, but useful)
      const r = await pool.query(
        `SELECT title, answer_type FROM task_templates WHERE id = $1`,
        [templateId]
      );
      const tpl = r.rows[0];
      st.draftTitle = tpl?.title || null;
      st.draftAnswerType = tpl?.answer_type || null;

      st.step = "point_scope";
      setState(ctx.from.id, st);

      await showPointScope(ctx);
    } catch (err) {
      logError("tcreate_tpl_pick", err);
    }
  });

  // -------------------- STEP: POINT SCOPE --------------------
  bot.action("tcreate_point_back", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getState(ctx.from.id);
      if (!st) return;

      // if came from new flow (save_tpl) or saved tpl list
      st.step = st.source === "saved" ? "tpl_list" : "save_tpl";
      setState(ctx.from.id, st);

      if (st.source === "saved") {
        await showPickTemplateList(ctx);
      } else {
        await showAskSaveTemplate(ctx);
      }
    } catch (err) {
      logError("tcreate_point_back", err);
    }
  });

  bot.action("tcreate_point_all", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getState(ctx.from.id);
      if (!st) return;

      st.pointScope = "all_points";
      st.tradePointId = null;
      st.step = "ask_recurring";
      setState(ctx.from.id, st);

      await showAskRecurring(ctx);
    } catch (err) {
      logError("tcreate_point_all", err);
    }
  });

  bot.action("tcreate_point_one", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getState(ctx.from.id);
      if (!st) return;

      st.pointScope = "one_point";
      st.tradePointId = null;
      st.step = "pick_point";
      setState(ctx.from.id, st);

      await showPickTradePoint(ctx);
    } catch (err) {
      logError("tcreate_point_one", err);
    }
  });

  bot.action(/^tcreate_point_pick_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getState(ctx.from.id);
      if (!st || st.step !== "pick_point") return;

      st.tradePointId = Number(ctx.match[1]);
      st.step = "ask_recurring";
      setState(ctx.from.id, st);

      await showAskRecurring(ctx);
    } catch (err) {
      logError("tcreate_point_pick", err);
    }
  });

  // -------------------- STEP: SCHEDULE --------------------
  bot.action("tcreate_sched_back", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getState(ctx.from.id);
      if (!st) return;

      st.step = st.pointScope === "one_point" ? "pick_point" : "point_scope";
      setState(ctx.from.id, st);

      if (st.step === "pick_point") await showPickTradePoint(ctx);
      else await showPointScope(ctx);
    } catch (err) {
      logError("tcreate_sched_back", err);
    }
  });

  bot.action("tcreate_sched_no", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getState(ctx.from.id);
      if (!st) return;

      st.isRecurring = false;
      st.scheduleType = "single";
      st.step = "single_date";
      setState(ctx.from.id, st);

      await showAskSingleDate(ctx);
    } catch (err) {
      logError("tcreate_sched_no", err);
    }
  });

  bot.action("tcreate_sched_yes", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getState(ctx.from.id);
      if (!st) return;

      st.isRecurring = true;
      st.step = "sched_type";
      setState(ctx.from.id, st);

      await showPickRecurringType(ctx);
    } catch (err) {
      logError("tcreate_sched_yes", err);
    }
  });

  bot.action("tcreate_sched_weekdays", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getState(ctx.from.id);
      if (!st) return;

      st.scheduleType = "weekly";
      st.weekdaysMask = st.weekdaysMask || 0;
      // start date = today (MVP)
      st.startDate = new Date().toISOString().slice(0, 10);
      st.step = "weekdays";
      setState(ctx.from.id, st);

      await showPickWeekdays(ctx, st.weekdaysMask);
    } catch (err) {
      logError("tcreate_sched_weekdays", err);
    }
  });

  bot.action("tcreate_sched_everyx", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getState(ctx.from.id);
      if (!st) return;

      st.scheduleType = "every_x_days";
      st.everyXDays = null;
      st.step = "everyx_input";
      setState(ctx.from.id, st);

      await showAskEveryX(ctx);
    } catch (err) {
      logError("tcreate_sched_everyx", err);
    }
  });

  bot.action("tcreate_schedtype_back", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getState(ctx.from.id);
      if (!st) return;

      st.step = "sched_type";
      setState(ctx.from.id, st);
      await showPickRecurringType(ctx);
    } catch (err) {
      logError("tcreate_schedtype_back", err);
    }
  });

  // Weekdays toggle
  bot.action(
    /^tcreate_wd_toggle_(mon|tue|wed|thu|fri|sat|sun)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery().catch(() => {});
        const user = await ensureUser(ctx);
        if (!isAdmin(user)) return;

        const st = getState(ctx.from.id);
        if (!st || st.step !== "weekdays") return;

        const key = ctx.match[1];
        const d = WD.find((x) => x.key === key);
        if (!d) return;

        st.weekdaysMask = st.weekdaysMask ^ d.bit; // toggle bit
        setState(ctx.from.id, st);

        await showPickWeekdays(ctx, st.weekdaysMask);
      } catch (err) {
        logError("tcreate_wd_toggle", err);
      }
    }
  );

  bot.action("tcreate_wd_back", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getState(ctx.from.id);
      if (!st) return;

      st.step = "sched_type";
      setState(ctx.from.id, st);
      await showPickRecurringType(ctx);
    } catch (err) {
      logError("tcreate_wd_back", err);
    }
  });

  bot.action("tcreate_wd_done", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getState(ctx.from.id);
      if (!st || st.step !== "weekdays") return;

      if (!st.weekdaysMask) {
        await ctx
          .answerCbQuery("Выбери хотя бы один день", { show_alert: true })
          .catch(() => {});
        return;
      }

      st.step = "time_mode";
      setState(ctx.from.id, st);
      await showPickTimeMode(ctx);
    } catch (err) {
      logError("tcreate_wd_done", err);
    }
  });

  // -------------------- STEP: TIME MODE --------------------
  bot.action("tcreate_time_back", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getState(ctx.from.id);
      if (!st) return;

      // go back depending on schedule type
      if (st.scheduleType === "single") {
        st.step = "single_date";
        setState(ctx.from.id, st);
        await showAskSingleDate(ctx);
        return;
      }
      if (st.scheduleType === "weekly") {
        st.step = "weekdays";
        setState(ctx.from.id, st);
        await showPickWeekdays(ctx, st.weekdaysMask);
        return;
      }
      if (st.scheduleType === "every_x_days") {
        st.step = "everyx_input";
        setState(ctx.from.id, st);
        await showAskEveryX(ctx);
        return;
      }

      // fallback
      st.step = "ask_recurring";
      setState(ctx.from.id, st);
      await showAskRecurring(ctx);
    } catch (err) {
      logError("tcreate_time_back", err);
    }
  });

  bot.action("tcreate_time_allday", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getState(ctx.from.id);
      if (!st || st.step !== "time_mode") return;

      st.timeMode = "all_day";
      st.deadlineTime = null;
      st.step = "confirm";
      setState(ctx.from.id, st);

      await showConfirm(ctx, st);
    } catch (err) {
      logError("tcreate_time_allday", err);
    }
  });

  bot.action("tcreate_time_set", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getState(ctx.from.id);
      if (!st || st.step !== "time_mode") return;

      st.timeMode = "deadline_time";
      st.step = "deadline_time";
      setState(ctx.from.id, st);

      await showAskDeadlineTime(ctx);
    } catch (err) {
      logError("tcreate_time_set", err);
    }
  });

  // -------------------- CONFIRM --------------------
  bot.action("tcreate_confirm_back", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getState(ctx.from.id);
      if (!st) return;

      st.step = "time_mode";
      setState(ctx.from.id, st);
      await showPickTimeMode(ctx);
    } catch (err) {
      logError("tcreate_confirm_back", err);
    }
  });

  bot.action("tcreate_confirm", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const adminUser = await ensureUser(ctx);
      if (!isAdmin(adminUser)) return;

      const st = getState(ctx.from.id);
      if (!st || st.step !== "confirm") return;

      // Persist to DB
      const { assignmentId } = await persistAll(ctx, adminUser, st);

      clearState(ctx.from.id);

      await deliver(
        ctx,
        {
          text: `✅ Задача создана.\n\nID постановки: <b>${assignmentId}</b>`,
          extra: Markup.inlineKeyboard([
            [{ text: "🛠 Админ-панель", callback_data: "lk_admin_menu" }],
          ]),
        },
        { edit: true }
      );
    } catch (err) {
      logError("tcreate_confirm", err);
      await ctx.reply("❌ Ошибка при создании задачи. Проверьте логи сервера.");
    }
  });
}

module.exports = { registerAdminTaskCreate };
