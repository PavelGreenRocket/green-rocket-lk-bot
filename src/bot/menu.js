// src/bot/menu.js
const { Markup } = require("telegraf");
const { deliver } = require("../utils/renderHelpers");
const pool = require("../db/pool");
const { countUnreadNotifications } = require("./notifications");
const { showInterviewDetails } = require("./interviewUser");
const { showInternshipDetails } = require("./internshipUser");
const { registerReports } = require("./reports");

// ===== Helpers =====

function normStaffStatus(raw) {
  // В БД у вас дефолт 'employee', ранее в коде часто использовали 'worker'
  if (!raw) return "employee";
  if (raw === "worker") return "employee";
  return raw;
}

async function getActiveShift(userId) {
  const sres = await pool.query(
    `
    SELECT s.id, s.trade_point_id, tp.title AS point_title, s.status, s.opened_at
    FROM shifts s
    LEFT JOIN trade_points tp ON tp.id = s.trade_point_id
    WHERE s.user_id = $1
      AND opened_at::date = CURRENT_DATE
      AND status IN ('opening_in_progress','opened','closing_in_progress')
      AND trade_point_id IS NOT NULL
    ORDER BY opened_at DESC
    LIMIT 1
    `,
    [userId]
  );
  return sres.rows[0] || null;
}

/**
 * Возвращает объект:
 * { status: string|null, decline_reason: string|null, is_deferred: boolean|null }
 */
async function getCandidateRow(user) {
  if (!user?.candidate_id) return null;
  const res = await pool.query(
    `SELECT status, is_deferred, decline_reason FROM candidates WHERE id = $1`,
    [user.candidate_id]
  );
  return res.rows[0] || null;
}

function isAdminRole(role) {
  return role === "admin" || role === "super_admin";
}

// ===== Screens =====

async function showProfileShiftScreen(ctx, user, { edit = true } = {}) {
  const activeShift = await getActiveShift(user.id);

  const baseText = await buildStatusText(user);

  let shiftBlock = "\n<u><b>Смена</b></u>\n";
  if (activeShift) {
    shiftBlock +=
      `🟢 Активна (<b>${activeShift.point_title || "—"}</b>)\n` +
      `📋 Задачи: 1/3 выполнены \n\n`;
  } else {
    shiftBlock += `⚪️ Не открыта\n`;
  }
  shiftBlock += `<u><b>Текущие показатели:</b></u>\n`;
  shiftBlock += `• <b>Выручка:</b> 12 000 ₽\n`;
  shiftBlock += `• <b>Выплата за смену:</b> 1 200 ₽\n\n`;

  shiftBlock += `<u><b>До премии +10%:</b></u>\n`;
  shiftBlock += `🔥 Осталось <b>100 ₽</b> выручки\n`;
  shiftBlock += `(+300 ₽ к выплате)`;

  const rows = [];

  // 1) Группа "Смена"
  rows.push([
    Markup.button.callback(" 🚀 Смена (📋 - 💬 - 📝)", "lk_shift_group"),
  ]);

  // 2) Группа "Операции"
  rows.push([Markup.button.callback("🧩 Операции (🚫 - 📦 - 📖)", "lk_ops_group")]);

  // 3/4) Отчёты vs Аналитика и отчёты
  if (isAdminRole(user.role)) {
    rows.push([
      Markup.button.callback(" 📊 Аналитика и отчёты", "lk_analytics_group"),
    ]);
  } else {
    rows.push([Markup.button.callback("📊 Отчёты", "lk_reports")]);
  }

  rows.push([Markup.button.callback("⬅️ В меню", "lk_main_menu")]);

  await deliver(
    ctx,
    {
      text:
        `${baseText}${shiftBlock}\n` +
        `______________________________\n`,
      extra: { ...Markup.inlineKeyboard(rows), parse_mode: "HTML" },
    },
    { edit }
  );
}

async function showShiftGroupMenu(ctx, user, { edit = true } = {}) {
  const activeShift = await getActiveShift(user.id);
  const rows = [];

  // 1.1 Закрыть/Открыть смену (callback один и тот же, как было)
  rows.push([
    Markup.button.callback(
      activeShift ? "🛑 Закрыть смену" : "🚀 Открыть смену",
      "lk_shift_toggle"
    ),
  ]);

  // Остальные пункты актуальны, когда смена активна
  if (activeShift) {
    rows.push([Markup.button.callback("📋 Задачи смены", "lk_tasks_today")]);
    rows.push([
      Markup.button.callback(
        "💬 Комментарий для следующей смены",
        "lk_next_shift_comment"
      ),
    ]);
    rows.push([
      Markup.button.callback(
        "📝 Замечания по прошлой смене",
        "lk_prev_shift_complaints"
      ),
    ]);
  }

  rows.push([Markup.button.callback("⬅️ Назад", "lk_profile_shift")]);

  await deliver(
    ctx,
    {
      text: " 🚀 Смена (📋 - 💬 - 📝)\n\nВыберите действие:",
      extra: { ...Markup.inlineKeyboard(rows), parse_mode: "HTML" },
    },
    { edit }
  );
}

async function showOpsGroupMenu(ctx, user, { edit = true } = {}) {
  const rows = [];

  rows.push([Markup.button.callback("🚫 Стоп-листы", "lk_ops_stoplists_stub")]);
  rows.push([Markup.button.callback("📦 Склад", "lk_ops_warehouse_wip")]);

  rows.push([Markup.button.callback("⬅️ Назад", "lk_profile_shift")]);

  await deliver(
    ctx,
    {
      text: "🧩 Операции (🚫 - 📦 - 📖)\n\nВыберите раздел:",
      extra: { ...Markup.inlineKeyboard(rows), parse_mode: "HTML" },
    },
    { edit }
  );
}

async function showAnalyticsGroupMenu(ctx, user, { edit = true } = {}) {
  const rows = [
    [Markup.button.callback("📊 Отчёты", "lk_reports")],
    [Markup.button.callback("⬅️ Назад", "lk_profile_shift")],
  ];

  await deliver(
    ctx,
    {
      text: "📊 Аналитика и отчёты\n\nВыберите раздел:",
      extra: { ...Markup.inlineKeyboard(rows), parse_mode: "HTML" },
    },
    { edit }
  );
}

async function showToolsMenu(ctx, user, { edit = true } = {}) {
  const staffStatus = normStaffStatus(user.staff_status);
  const rows = [];

  // Академия
  if (staffStatus === "candidate") {
    rows.push([
      Markup.button.callback("📚 Академия бариста", "lk_academy_locked"),
    ]);
  } else {
    const academyUrl = "https://t.me/barista_academy_GR_bot";
    rows.push([Markup.button.url("📚 Академия бариста", academyUrl)]);
  }

  // Склад
  rows.push([Markup.button.callback("📦 Склад", "lk_warehouse_locked")]);

  // ИИ
  rows.push([Markup.button.callback("🔮 Задать вопрос ИИ", "lk_ai_question")]);

  rows.push([Markup.button.callback("⬅️ В меню", "lk_main_menu")]);

  await deliver(
    ctx,
    {
      text: "📦 <b>Рабочие инструменты</b>\n\nВыберите раздел:",
      extra: { ...Markup.inlineKeyboard(rows), parse_mode: "HTML" },
    },
    { edit }
  );
}

// ===== Menus =====

async function buildMainKeyboard(user) {
  const staffStatus = normStaffStatus(user.staff_status);
  const role = user.role || "user";

  // Если кандидат без candidate_id — меню не показываем
  if (staffStatus === "candidate" && !user.candidate_id) return null;

  // Кандидатские экраны (инвайты) — управляются /start напрямую, тут клавиатура не нужна
  // Но на всякий случай оставим кнопки, если когда-то захотите показывать не напрямую.
  if (staffStatus === "candidate" && user.candidate_id) {
    const cand = await getCandidateRow(user);

    if (cand?.status === "invited") {
      return Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "📄 Детали собеседования",
            "lk_interview_details"
          ),
        ],
        [
          Markup.button.callback(
            "❌ Отказаться от собеседования",
            "lk_interview_decline"
          ),
        ],
      ]);
    }

    if (cand?.status === "internship_invited") {
      return Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "📄 Детали стажировки",
            "lk_internship_details"
          ),
        ],
        [
          Markup.button.callback(
            "❌ Отказаться от стажировки",
            "lk_internship_decline"
          ),
        ],
      ]);
    }

    return null;
  }

  // ===== Обычное меню ЛК (для employee/admin/intern с открытым доступом) =====
  const buttons = [];

  buttons.push([
    Markup.button.callback("👤 Профиль / Смена", "lk_profile_shift"),
  ]);
  buttons.push([
    Markup.button.callback("📦 Рабочие инструменты", "lk_tools_menu"),
  ]);

  const unread = await countUnreadNotifications(user.id);
  const notifLabel =
    unread > 0 ? `🔔 Уведомления (${unread})` : "🔔 Уведомления";
  buttons.push([Markup.button.callback(notifLabel, "lk_notifications")]);

  // Детали стажировки — отображаем в меню стажёра (с доступом),
  // и можете оставить также для кандидата-инвайта, если когда-то решите показывать меню.
  if (staffStatus === "intern") {
    buttons.push([
      Markup.button.callback("📄 Детали стажировки", "lk_internship_details"),
    ]);
  }

  // Админ: собеседования
  if (isAdminRole(role)) {
    const res = await pool.query(
      `
        SELECT COUNT(*) AS cnt
        FROM candidates
        WHERE status = 'invited'
          AND admin_id = $1
      `,
      [user.id]
    );
    const interviewsCount = Number(res.rows[0]?.cnt || 0);
    if (interviewsCount > 0) {
      buttons.push([
        Markup.button.callback(
          `❗ Собеседования (${interviewsCount})`,
          "lk_admin_my_interviews"
        ),
      ]);
    }
  }

  // Админ-панель
  if (isAdminRole(role)) {
    buttons.push([Markup.button.callback("⚙️ Админ-панель", "lk_admin_menu")]);
  }

  return Markup.inlineKeyboard(buttons);
}

async function buildStatusText(user) {
  const staffStatus = normStaffStatus(user.staff_status);
  const role = user.role || "user";
  const name = user.full_name || "Гость";
  const position = user.position || "";

  // Кандидат: текст зависит от candidates.status
  if (staffStatus === "candidate" && user.candidate_id) {
    const cand = await getCandidateRow(user);

    if (cand?.status === "invited") {
      return (
        `${name}, вы приглашены на собеседование в Green Rocket! ☕\n\n` +
        "Личный кабинет пока закрыт.\n\n" +
        "Нажмите «📄 Детали собеседования», чтобы посмотреть дату, время и место,\n" +
        "или «❌ Отказаться от собеседования», если вы не сможете прийти."
      );
    }

    if (cand?.status === "internship_invited") {
      return (
        `${name}, вы приглашены на стажировку в Green Rocket! 🚀\n\n` +
        "Стажировка ещё не началась, поэтому личный кабинет пока закрыт.\n\n" +
        "Нажмите «📄 Детали стажировки», чтобы посмотреть дату, время и место."
      );
    }

    if (cand?.status === "rejected") {
      if (cand.decline_reason === "отказался сам") {
        return (
          "❌ Вы отказались от собеседования.\n\n" +
          "Мы сообщили наставнику.\n" +
          "Если это ошибка — свяжитесь, пожалуйста, с руководителем."
        );
      }
      return "❌ К сожалению, мы не готовы продолжить с вами сотрудничество.\n\nСпасибо, что нашли время!";
    }

    if (cand?.status === "interviewed") {
      return (
        `${name}, спасибо за собеседование!\n\n` +
        "Мы приняли вашу анкету и вернёмся с решением позже.\n" +
        "Личный кабинет пока закрыт."
      );
    }

    return "Личный кабинет пока закрыт.";
  }

  // Обычный ЛК текст
  let statusLine = "";
  if (staffStatus === "intern") statusLine = "<b>Статус:</b> 🎓 стажёр";
  else if (staffStatus === "employee")
    statusLine = "<b>Статус:</b> 👨‍💼 сотрудник";
  else statusLine = `<b>Статус:</b> ${staffStatus}`;

  let positionLine = "";
  if (position) positionLine = `<b>Должность:</b> ${position}\n`;

  let roleLine = "";
  if (role === "admin") roleLine = "<b>Роль:</b> админ\n";
  if (role === "super_admin") roleLine = "<b>Роль:</b> супер-админ\n";

  let text = `<b>Имя:</b> ${name}\n`;
  text += `${statusLine}\n`;
  if (roleLine) text += roleLine;
  if (positionLine) text += positionLine;

  return text;
}

// ===== Register =====

function registerMenu(bot, ensureUser, logError) {
  // /start
  bot.start(async (ctx) => {
    try {
      const user = await ensureUser(ctx);
      if (!user) return;

      const staffStatus = normStaffStatus(user.staff_status);
      const cand = await getCandidateRow(user);

      // 1) Кандидат, приглашён на собеседование -> всегда экран скрин 1
      if (staffStatus === "candidate" && cand?.status === "invited") {
        await showInterviewDetails(ctx, user, { edit: false });
        return;
      }

      // 2) Стажёр (intern) ИЛИ кандидат, приглашён на стажировку, и ЛК ещё закрыт -> всегда экран скрин 2
      //    ЛК "закрыт" считаем только для стажёра: lk_enabled !== true
      //    Для кандидата internship_invited — ЛК всегда закрыт до старта, и тоже должен показывать скрин 2.
      const needsInternshipScreen =
        (staffStatus === "intern" && user.lk_enabled !== true) ||
        (staffStatus === "candidate" &&
          (cand?.status === "internship_invited" || cand?.status === "intern"));

      if (needsInternshipScreen) {
        await showInternshipDetails(ctx, user, {
          withReadButton: false,
          edit: false,
        });
        return;
      }

      // 3) Иначе — обычный ЛК
      const text = await buildStatusText(user);
      const keyboard = await buildMainKeyboard(user);
      await deliver(
        ctx,
        { text, extra: { ...(keyboard || {}), parse_mode: "HTML" } },
        { edit: false }
      );
    } catch (err) {
      logError("lk_start", err);
    }
  });

  // Переход из уведомления "доступ открыт"
  bot.action("lk_open_menu", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      // При клике — поведение такое же как /start
      const staffStatus = normStaffStatus(user.staff_status);
      const cand = await getCandidateRow(user);

      if (staffStatus === "candidate" && cand?.status === "invited") {
        await showInterviewDetails(ctx, user, { edit: false });
        return;
      }

      const needsInternshipScreen =
        (staffStatus === "intern" && user.lk_enabled !== true) ||
        (staffStatus === "candidate" && cand?.status === "internship_invited");

      if (needsInternshipScreen) {
        await showInternshipDetails(ctx, user, {
          withReadButton: false,
          edit: false,
        });
        return;
      }

      const text = await buildStatusText(user);
      const keyboard = await buildMainKeyboard(user);

      await deliver(
        ctx,
        { text, extra: { ...(keyboard || {}), parse_mode: "HTML" } },
        { edit: false }
      );
    } catch (err) {
      logError("lk_open_menu", err);
    }
  });

  // Меню инструментов
  bot.action("lk_tools_menu", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      await showToolsMenu(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_tools_menu", e);
    }
  });

  // Назад в меню
  bot.action("lk_main_menu", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const staffStatus = normStaffStatus(user.staff_status);
      const cand = await getCandidateRow(user);

      if (staffStatus === "candidate" && cand?.status === "invited") {
        await showInterviewDetails(ctx, user, { edit: false });
        return;
      }

      const needsInternshipScreen =
        (staffStatus === "intern" && user.lk_enabled !== true) ||
        (staffStatus === "candidate" && cand?.status === "internship_invited");

      if (needsInternshipScreen) {
        await showInternshipDetails(ctx, user, {
          withReadButton: false,
          edit: false,
        });
        return;
      }

      const text = await buildStatusText(user);
      const keyboard = await buildMainKeyboard(user);

      await deliver(
        ctx,
        { text, extra: { ...(keyboard || {}), parse_mode: "HTML" } },
        { edit: true }
      );
    } catch (err) {
      logError("lk_main_menu", err);
    }
  });

  // Профиль / смена
  bot.action("lk_profile_shift", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      await showProfileShiftScreen(ctx, user, { edit: true });
    } catch (err) {
      logError("lk_profile_shift", err);
    }
  });

  // Группа "Смена"
  bot.action("lk_shift_group", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      await showShiftGroupMenu(ctx, user, { edit: true });
    } catch (err) {
      logError("lk_shift_group", err);
    }
  });

  // Группа "Операции"
  bot.action("lk_ops_group", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      await showOpsGroupMenu(ctx, user, { edit: true });
    } catch (err) {
      logError("lk_ops_group", err);
    }
  });

  // Заглушки
  bot.action("lk_ops_stoplists_stub", async (ctx) => {
    await ctx.answerCbQuery("Пока заглушка").catch(() => {});
  });

  bot.action("lk_ops_warehouse_wip", async (ctx) => {
    await ctx.answerCbQuery("В разработке").catch(() => {});
  });

  // Аналитика/отчёты (только админы)
  bot.action("lk_analytics_group", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      if (!isAdminRole(user.role)) {
        // на всякий случай — если вдруг кнопка появится не тому
        await ctx.answerCbQuery("Недоступно").catch(() => {});
        return;
      }

      await showAnalyticsGroupMenu(ctx, user, { edit: true });
    } catch (err) {
      logError("lk_analytics_group", err);
    }
  });

  // Академия закрыта (кандидат)
  bot.action("lk_academy_locked", async (ctx) => {
    try {
      const user = await ensureUser(ctx);
      if (!user) return;

      const staffStatus = normStaffStatus(user.staff_status);

      if (staffStatus === "candidate") {
        await ctx
          .answerCbQuery(
            "Доступ к обучению откроется после начала стажировки.",
            {
              show_alert: true,
            }
          )
          .catch(() => {});
      } else {
        await ctx
          .answerCbQuery("Функционал пока не готов.", { show_alert: true })
          .catch(() => {});
      }
    } catch (err) {
      logError("lk_academy_locked", err);
    }
  });

  // Склад закрыт
  bot.action("lk_warehouse_locked", async (ctx) => {
    try {
      const user = await ensureUser(ctx);
      if (!user) return;

      const staffStatus = normStaffStatus(user.staff_status);

      if (staffStatus === "candidate") {
        await ctx
          .answerCbQuery(
            "Ракета ещё на старте.\nДоступ к складу появится после начала стажировки.",
            { show_alert: true }
          )
          .catch(() => {});
      } else {
        await ctx
          .answerCbQuery("Функционал пока не готов.", { show_alert: true })
          .catch(() => {});
      }
    } catch (err) {
      logError("lk_warehouse_locked", err);
    }
  });

  registerReports(bot, ensureUser, logError);
}

module.exports = {
  registerMenu,
  buildStatusText,
  buildMainKeyboard,
};
