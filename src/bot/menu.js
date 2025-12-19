// src/bot/menu.js
const { Markup } = require("telegraf");
const { deliver } = require("../utils/renderHelpers");
const pool = require("../db/pool");
const { countUnreadNotifications } = require("./notifications");
const { showInterviewDetails } = require("./interviewUser");

async function buildMainKeyboard(user) {
  const staffStatus = user.staff_status || "worker";
  const role = user.role || "user";

  if (staffStatus === "candidate" && !user.candidate_id) {
    return null;
  }

  // Особая клавиатура для кандидата
  if (staffStatus === "candidate" && user.candidate_id) {
    const res = await pool.query(
      "SELECT status, is_deferred, decline_reason FROM candidates WHERE id = $1",
      [user.candidate_id]
    );
    const cand = res.rows[0];

    // 1) Собеседование
    if (cand && cand.status === "invited") {
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

    // 2) Стажировка
    if (cand && cand.status === "internship_invited") {
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

  // Обычная клавиатура (смены, Академия, склад, ИИ, уведомления и т.п.)
  const buttons = [];

  // 1) Смена (открыть/закрыть) + задачи (только если смена активна)
  let activeShift = null;
  try {
    const sres = await pool.query(
      `
        SELECT id, status
        FROM shifts
        WHERE user_id = $1
          AND opened_at::date = CURRENT_DATE
          AND status IN ('opening_in_progress','opened','closing_in_progress')
        ORDER BY opened_at DESC
        LIMIT 1
      `,
      [user.id]
    );
    activeShift = sres.rows[0] || null;
  } catch (e) {
    // если таблица shifts ещё не подключена/пусто — не ломаем меню
    activeShift = null;
  }

  if (activeShift) {
    buttons.push([
      Markup.button.callback("🛑 Закрыть смену", "lk_shift_toggle"),
    ]);
    buttons.push([Markup.button.callback("📋 Задачи", "lk_tasks_today")]);
  } else {
    buttons.push([
      Markup.button.callback("🚀 Открыть смену", "lk_shift_toggle"),
    ]);
  }

  // 2) Академия бариста
  if (staffStatus === "candidate") {
    buttons.push([
      Markup.button.callback("📚 Академия бариста", "lk_academy_locked"),
    ]);
  } else {
    const academyUrl = "https://t.me/barista_academy_GR_bot";
    buttons.push([Markup.button.url("📚 Академия бариста", academyUrl)]);
  }

  // 3) Склад
  buttons.push([Markup.button.callback("📦 Склад", "lk_warehouse_locked")]);

  // 4) Уведомления (+ бейдж)
  const unread = await countUnreadNotifications(user.id);
  const notifLabel =
    unread > 0 ? `🔔 Уведомления (${unread})` : "🔔 Уведомления";
  buttons.push([Markup.button.callback(notifLabel, "lk_notifications")]);

  // 5) ИИ
  buttons.push([
    Markup.button.callback("🔮 Задать вопрос ИИ", "lk_ai_question"),
  ]);

  // 6) Кнопка "Собеседования (N) ❗" — только для admin / super_admin,
  //    и только если есть запланированные собеседования
  if (role === "admin" || role === "super_admin") {
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
          "lk_admin_my_interviews" // было "admin_users_candidates"
        ),
      ]);
    }
  }

  // 7) Детали стажировки — только для стажёров
  if (staffStatus === "intern") {
    buttons.push([
      Markup.button.callback("📄 Детали стажировки", "lk_internship_details"),
    ]);
  }

  // 8) Админ-панель — только для admin / super_admin
  if (role === "admin" || role === "super_admin") {
    buttons.push([Markup.button.callback("⚙️ Админ-панель", "lk_admin_menu")]);
  }

  return Markup.inlineKeyboard(buttons);
}

async function buildStatusText(user) {
  const staffStatus = user.staff_status || "worker";
  const position = user.position || "";
  const role = user.role || "user";
  const name = user.full_name || "Гость";

  // ✅ Кандидат: текст зависит от candidates.status
  if (staffStatus === "candidate" && user.candidate_id) {
    const res = await pool.query(
      "SELECT status, is_deferred FROM candidates WHERE id = $1",
      [user.candidate_id]
    );
    const cand = res.rows[0];

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
        "Стажировка ещё не началась, поэтому личный кабинет пока закрыт.\n" +
        "Он откроется автоматически в момент старта.\n\n" +
        "🔔 За 2 часа до начала вы получите уведомление, " +
        "где нужно будет подтвердить присутствие - до этого ничего делать не нужно.\n\n"
      );
    }

    // ✅ rejected (и отложенные тоже rejected+is_deferred=true):
    // меню НЕ открываем, показываем “закрыто”
    if (cand?.status === "rejected") {
      // если отказался сам — показываем “вы отказались…”
      if (cand.decline_reason === "отказался сам") {
        return (
          "❌ Вы отказались от собеседования.\n\n" +
          "Мы сообщили наставнику.\n" +
          "Если это ошибка — свяжитесь, пожалуйста, с руководителем."
        );
      }

      return (
        "❌ К сожалению, мы не готовы продолжить с вами сотрудничество.\n\n" +
        "Спасибо, что нашли время!"
      );
    }

    // interviewED (“ожидают решения”) — тоже без меню, нейтрально
    if (cand?.status === "interviewed") {
      return (
        `${name}, спасибо за собеседование!\n\n` +
        "Мы приняли вашу анкету и вернёмся с решением позже.\n" +
        "Личный кабинет пока закрыт."
      );
    }

    // запасной вариант на прочие статусы
    return "Личный кабинет пока закрыт.";
  }

  // Дальше — обычный текст (включая кандидата на стажировку)
  let statusLine = "";
  if (staffStatus === "intern") {
    statusLine = "<b>Статус:</b> 🎓 стажёр";
  } else if (staffStatus === "worker") {
    statusLine = "<b>Статус:</b> 👨‍💼 сотрудник";
  } else if (staffStatus === "candidate") {
    statusLine = "<b>Статус:</b> 🧩 кандидат";
  } else {
    statusLine = `<b>Статус:</b> ${staffStatus}`;
  }

  let roleLine = "";
  if (role === "admin") roleLine = "<b>Роль:</b> админ\n";
  else if (role === "super_admin") roleLine = "<b>Роль:</b> супер-админ\n";

  let positionLine = "";
  if (position) {
    let posLabel = position;
    if (position === "barista") posLabel = "бариста";
    if (position === "point_admin") posLabel = "администратор точки";
    if (position === "senior_admin") posLabel = "старший администратор";
    if (position === "quality_manager") posLabel = "менеджер по качеству";
    if (position === "manager") posLabel = "управляющий";

    positionLine = `<b>Должность:</b> ${posLabel}\n`;
  }

  return (
    `<b>Имя:</b> ${name}\n` +
    `${statusLine}\n` +
    (roleLine || "") +
    (positionLine || "") +
    "\nЛичный кабинет активен.\n" +
    "Здесь ты сможешь отмечать смены, получать уведомления,\n" +
    "переходить в обучение и пользоваться другими функциями."
  );
}

function registerMenu(bot, ensureUser, logError) {
  // /start
  bot.start(async (ctx) => {
    try {
      const user = await ensureUser(ctx);
      if (!user) return;

      // ✅ если кандидат приглашён — сразу экран собеседования (без промежуточного меню)
      if (user.staff_status === "candidate" && user.candidate_id) {
        const res = await pool.query(
          "SELECT status FROM candidates WHERE id = $1",
          [user.candidate_id]
        );
        const cand = res.rows[0];
        if (cand?.status === "invited") {
          await showInterviewDetails(ctx, user, { edit: false });
          return;
        }
      }

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

  // Кнопка "Назад в меню"
  bot.action("lk_main_menu", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      const text = await buildStatusText(user);
      const keyboard = await buildMainKeyboard(user);
      await deliver(
        ctx,
        {
          text,
          extra: { ...(keyboard || {}), parse_mode: "HTML" },
        },
        { edit: true }
      );
    } catch (err) {
      logError("lk_main_menu", err);
    }
  });

  // Академия закрыта (кандидат)
  bot.action("lk_academy_locked", async (ctx) => {
    try {
      const user = await ensureUser(ctx);
      if (!user) return;
      const staffStatus = user.staff_status || "worker";

      if (staffStatus === "candidate") {
        await ctx
          .answerCbQuery(
            "Доступ к обучению откроется после начала стажировки.",
            { show_alert: true }
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

  // Склад
  bot.action("lk_warehouse_locked", async (ctx) => {
    try {
      const user = await ensureUser(ctx);
      if (!user) return;
      const staffStatus = user.staff_status || "worker";

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
}

module.exports = { registerMenu, buildStatusText, buildMainKeyboard };
