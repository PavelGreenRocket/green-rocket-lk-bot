// src/bot/adminUsers/aiLogs.js

const pool = require("../../db/pool");
const { Markup } = require("telegraf");
const { deliver } = require("../../utils/renderHelpers");
const {
  getAdminAiViewState,
  setAdminAiViewState,
  isAdmin,
} = require("./state");
const { getAiConfig, setSetting } = require("../../ai/settings");

const AI_LOGS_PAGE_SIZE = 10;

// Количество новых логов ИИ (не просмотренных админом)
async function getNewAiLogsCount() {
  const res = await pool.query(
    `
      SELECT COUNT(*) AS cnt
      FROM ai_chat_logs
      WHERE is_new_for_admin = TRUE
    `
  );
  return Number(res.rows[0]?.cnt || 0);
}

// Количество обращений, подозрительных на "не по работе" (ещё не подтвержденных админом)
async function getPendingOfftopicCount() {
  const res = await pool.query(
    `
      SELECT COUNT(*) AS cnt
      FROM ai_chat_logs
      WHERE is_offtopic_suspected = TRUE
        AND is_offtopic_confirmed IS NULL
    `
  );
  return Number(res.rows[0]?.cnt || 0);
}

// Получение списка логов (вопросов к ИИ) для заданной страницы и фильтра
async function getAiLogsPage(page = 1, filter = "all") {
  if (page < 1) page = 1;

  let where = "1=1";
  if (filter === "offtopic") {
    where = "l.is_offtopic_confirmed = TRUE";
  }

  const countRes = await pool.query(
    `SELECT COUNT(*) AS cnt FROM ai_chat_logs l WHERE ${where}`
  );
  const total = Number(countRes.rows[0]?.cnt || 0);
  const totalPages = total > 0 ? Math.ceil(total / AI_LOGS_PAGE_SIZE) : 1;
  if (page > totalPages) page = totalPages;

  const offset = (page - 1) * AI_LOGS_PAGE_SIZE;

  const res = await pool.query(
    `
      SELECT
        l.id,
        l.user_id,
        l.question,
        l.answer,
        l.created_at,
        l.is_new_for_admin,
        l.is_offtopic_suspected,
        l.is_offtopic_confirmed,
        u.full_name
      FROM ai_chat_logs l
      LEFT JOIN users u ON u.id = l.user_id
      WHERE ${where}
      ORDER BY l.created_at DESC
      LIMIT $1 OFFSET $2
    `,
    [AI_LOGS_PAGE_SIZE, offset]
  );

  return {
    total,
    page,
    totalPages,
    logs: res.rows,
  };
}

// --- Статистика (как было) ---
async function getAiStats(period = "month") {
  let interval;
  if (period === "day") interval = "1 day";
  else if (period === "week") interval = "7 days";
  else if (period === "year") interval = "1 year";
  else interval = "1 month";

  const res = await pool.query(
    `
      SELECT
        COUNT(*) AS total,
        COUNT(DISTINCT user_id) AS users,
        COUNT(*) FILTER (WHERE is_offtopic_confirmed IS TRUE) AS offtopic
      FROM ai_chat_logs
      WHERE created_at >= now() - INTERVAL '${interval}'
    `
  );

  return {
    total: Number(res.rows[0].total) || 0,
    users: Number(res.rows[0].users) || 0,
    offtopic: Number(res.rows[0].offtopic) || 0,
  };
}

// --- Метрики / аналитика ---
async function getAiMetrics(period = "month") {
  let interval;
  if (period === "day") interval = "1 day";
  else if (period === "week") interval = "7 days";
  else if (period === "year") interval = "1 year";
  else interval = "1 month";

  const base = await pool.query(
    `
    SELECT
      COUNT(*) AS total,
      COUNT(DISTINCT user_id) AS users,
      COUNT(*) FILTER (WHERE is_offtopic_confirmed IS TRUE) AS offtopic_confirmed,
      COUNT(*) FILTER (
        WHERE is_offtopic_suspected IS TRUE AND is_offtopic_confirmed IS NULL
      ) AS pending_offtopic,
      AVG(LENGTH(COALESCE(answer,''))) AS avg_answer_len,
      COUNT(*) FILTER (
        WHERE answer ILIKE 'Я не нашёл%' OR answer ILIKE 'Я не нашел%'
      ) AS no_theory_like
    FROM ai_chat_logs
    WHERE created_at >= now() - INTERVAL '${interval}'
    `
  );

  const b = base.rows[0] || {};
  const total = Number(b.total) || 0;
  const users = Number(b.users) || 0;
  const offtopicConfirmed = Number(b.offtopic_confirmed) || 0;
  const pendingOfftopic = Number(b.pending_offtopic) || 0;
  const avgAnswerLen = b.avg_answer_len
    ? Math.round(Number(b.avg_answer_len))
    : 0;
  const noTheoryLike = Number(b.no_theory_like) || 0;

  const topUsersRes = await pool.query(
    `
    SELECT
      COALESCE(u.full_name, 'Без имени') AS full_name,
      COUNT(*) AS cnt
    FROM ai_chat_logs l
    LEFT JOIN users u ON u.id = l.user_id
    WHERE l.created_at >= now() - INTERVAL '${interval}'
    GROUP BY COALESCE(u.full_name, 'Без имени')
    ORDER BY COUNT(*) DESC
    LIMIT 7
    `
  );

  const topUsers = topUsersRes.rows.map((r) => ({
    name: r.full_name,
    cnt: Number(r.cnt) || 0,
  }));

  return {
    total,
    users,
    offtopicConfirmed,
    pendingOfftopic,
    avgAnswerLen,
    noTheoryLike,
    topUsers,
    offtopicPercent: total ? Math.round((offtopicConfirmed / total) * 100) : 0,
  };
}

// Отображение списка обращений к ИИ
async function showAiLogsList(ctx, page) {
  const adminId = ctx.from.id;
  const { aiFilter, aiToolsExpanded, aiFilterExpanded } =
    getAdminAiViewState(adminId);

  const {
    total,
    page: realPage,
    totalPages,
    logs,
  } = await getAiLogsPage(page, aiFilter);

  if (!total) {
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback("🔙 Назад", "admin_users")],
    ]);

    await deliver(
      ctx,
      {
        text:
          aiFilter === "offtopic"
            ? '🤖 История обращений к ИИ: пока нет подтверждённых обращений "не по работе".'
            : "🤖 История обращений к ИИ пока пуста.",
        extra: keyboard,
      },
      { edit: true }
    );
    return;
  }

  let text =
    "🤖 История обращений к ИИ\n\n" +
    `Всего записей: ${total}\n` +
    `Страница ${realPage} из ${totalPages}\n` +
    `Фильтр: ${
      aiFilter === "offtopic" ? '🚫🤖 только "не по работе"' : "все обращения"
    }\n\n` +
    "Выбери запрос:";

  const buttons = [];

  for (const row of logs) {
    const date = new Date(row.created_at).toLocaleString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
    const name = row.full_name || "Без имени";
    const newIcon = row.is_new_for_admin ? "🆕 " : "";
    const offIcon = row.is_offtopic_confirmed ? "❗ " : "";
    const label = `${newIcon}${offIcon}${date} — ${name}`;

    buttons.push([
      Markup.button.callback(label, `admin_ai_log_${row.id}_${realPage}`),
    ]);
  }

  // 🔎 фильтр (панель)
  const filterToggleLabel = aiFilterExpanded
    ? "🔎 Фильтр (скрыть)"
    : "🔎 Фильтр";
  buttons.push([
    Markup.button.callback(
      filterToggleLabel,
      `admin_ai_filter_toggle_${realPage}`
    ),
  ]);

  if (aiFilterExpanded) {
    if (aiFilter === "all") {
      buttons.push([
        Markup.button.callback(
          "🚫🤖 Обращения не по работе",
          `admin_ai_logs_filter_offtopic_${realPage}`
        ),
      ]);
    } else {
      buttons.push([
        Markup.button.callback(
          "🔄 Показать все обращения",
          `admin_ai_logs_filter_all_${realPage}`
        ),
      ]);
    }
  }

  // раскрытие (вместо отдельной “Статистики”)
  const toggleLabel = aiToolsExpanded ? "▴ Свернуть" : "▾ Раскрыть";
  buttons.push([
    Markup.button.callback(toggleLabel, `admin_ai_tools_toggle_${realPage}`),
  ]);

  if (aiToolsExpanded) {
    buttons.push([
      Markup.button.callback("📊 Статистика обращений", "admin_ai_stats_menu"),
    ]);
    buttons.push([
      Markup.button.callback("📈 Метрики / аналитика", "admin_ai_metrics_menu"),
    ]);

    // Top-K сейчас реализован на стороне assistant.js как кол-во фрагментов (chunks).
    // UI-настройки Top-K добавим следующим шагом (когда заведём таблицу настроек).
    buttons.push([
      Markup.button.callback("🧠 Top-K теории", "admin_ai_topk_menu"),
    ]);
  }

  // навигация страниц
  const navRow = [];
  if (realPage > 1) {
    navRow.push(
      Markup.button.callback("⬅️ Назад", `admin_ai_logs_${realPage - 1}`)
    );
  }
  if (realPage < totalPages) {
    navRow.push(
      Markup.button.callback("➡️ Далее", `admin_ai_logs_${realPage + 1}`)
    );
  }
  if (navRow.length) buttons.push(navRow);

  buttons.push([Markup.button.callback("🔙 Назад", "admin_users")]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(buttons) },
    { edit: true }
  );
}

// Детали лога
async function showAiLogDetails(ctx, logId, returnPage) {
  const res = await pool.query(
    `
      SELECT
        l.id,
        l.user_id,
        l.question,
        l.answer,
        l.created_at,
        l.is_new_for_admin,
        l.is_offtopic_suspected,
        l.is_offtopic_confirmed,
        u.full_name
      FROM ai_chat_logs l
      LEFT JOIN users u ON u.id = l.user_id
      WHERE l.id = $1
    `,
    [logId]
  );

  if (!res.rows.length) {
    await ctx.reply("Запись общения с ИИ не найдена.");
    return;
  }

  const row = res.rows[0];

  // Помечаем как прочитанное
  if (row.is_new_for_admin) {
    await pool.query(
      "UPDATE ai_chat_logs SET is_new_for_admin = FALSE WHERE id = $1",
      [logId]
    );
    row.is_new_for_admin = false;
  }

  const date = new Date(row.created_at).toLocaleString("ru-RU", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
  const name = row.full_name || "Без имени";

  // Считаем количество уже подтверждённых замечаний у пользователя
  let issuesBefore = 0;
  if (row.user_id) {
    const cntRes = await pool.query(
      `
        SELECT COUNT(*) AS cnt
        FROM ai_chat_logs
        WHERE user_id = $1 AND is_offtopic_confirmed = TRUE
      `,
      [row.user_id]
    );
    issuesBefore = Number(cntRes.rows[0]?.cnt || 0);
  }

  const issuesLine =
    issuesBefore > 0
      ? `🚫🤖 Замечания по обращениям к ИИ: ${issuesBefore}❗`
      : "🚫🤖 Замечания по обращениям к ИИ: не было ✅";

  let text =
    "🤖 Запрос к ИИ\n\n" +
    `Пользователь: ${name}\n` +
    `Дата: ${date}\n\n` +
    `${issuesLine}\n\n` +
    `❓ Вопрос:\n${row.question}\n\n` +
    `💡 Ответ ИИ:\n${row.answer}`;

  const buttons = [];

  if (row.is_offtopic_suspected) {
    if (row.is_offtopic_confirmed === null) {
      buttons.push([
        Markup.button.callback(
          "❗ Отметить замечание",
          `admin_ai_log_mark_offtopic_${row.id}_${returnPage || 1}`
        ),
      ]);
      buttons.push([
        Markup.button.callback(
          "✅ Вопрос был по работе",
          `admin_ai_log_mark_ok_${row.id}_${returnPage || 1}`
        ),
      ]);
    } else if (row.is_offtopic_confirmed === true) {
      buttons.push([
        Markup.button.callback(
          "✅ Отметить, что вопрос был по работе",
          `admin_ai_log_mark_ok_${row.id}_${returnPage || 1}`
        ),
      ]);
    } else {
      buttons.push([
        Markup.button.callback(
          "❗ Отметить замечание",
          `admin_ai_log_mark_offtopic_${row.id}_${returnPage || 1}`
        ),
      ]);
    }
  }

  buttons.push([
    Markup.button.callback(
      "🔙 К списку запросов",
      `admin_ai_logs_${returnPage || 1}`
    ),
  ]);
  buttons.push([Markup.button.callback("🔙 Назад", "admin_users")]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(buttons) },
    { edit: true }
  );
}

// Регистрация action-хендлеров
function registerAdminAiLogs(bot, ensureUser, logError) {
  bot.action("admin_ai_topk_menu", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const admin = await ensureUser(ctx);
    if (!isAdmin(admin)) return;

    const text =
      "🧠 Top-K теории\n\n" +
      "Сколько фрагментов теории подставлять в промпт ассистента.\n" +
      "По умолчанию: 3.\n\n" +
      "Выбери значение:";

    const kb = Markup.inlineKeyboard([
      [
        Markup.button.callback("K=1", "admin_ai_topk_set_1"),
        Markup.button.callback("K=2", "admin_ai_topk_set_2"),
        Markup.button.callback("K=3 ✅", "admin_ai_topk_set_3"),
      ],
      [
        Markup.button.callback("K=4", "admin_ai_topk_set_4"),
        Markup.button.callback("K=5", "admin_ai_topk_set_5"),
      ],
      [Markup.button.callback("🔙 Назад", "admin_ai_logs_1")],
    ]);

    await deliver(ctx, { text, extra: kb }, { edit: true });
  });

  bot.action(/^admin_ai_topk_set_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const admin = await ensureUser(ctx);
    if (!isAdmin(admin)) return;

    const k = Number(ctx.match[1]);
    if (!Number.isFinite(k) || k < 1 || k > 10) return;

    // TODO: позже сохраним в БД ai_settings
    // Пока просто показываем подтверждение:
    await ctx.reply(
      `✅ Top-K установлен: ${k}\n(сохранение в настройки сделаем следующим шагом)`
    );

    // Возвращаемся к списку логов
    await ctx.telegram.sendMessage(ctx.chat.id, "Открываю историю…");
    // либо сразу:
    // await showAiLogsList(ctx, 1);
  });

  bot.action(/^admin_ai_logs_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const page = parseInt(ctx.match[1], 10) || 1;
      await showAiLogsList(ctx, page);
    } catch (err) {
      logError("admin_ai_logs_x", err);
    }
  });

  bot.action(/^admin_ai_tools_toggle_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const page = parseInt(ctx.match[1], 10) || 1;
      const st = getAdminAiViewState(ctx.from.id);
      setAdminAiViewState(ctx.from.id, {
        aiToolsExpanded: !st.aiToolsExpanded,
      });
      await showAiLogsList(ctx, page);
    } catch (err) {
      logError("admin_ai_tools_toggle_x", err);
    }
  });

  bot.action(/^admin_ai_filter_toggle_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const page = parseInt(ctx.match[1], 10) || 1;
      const st = getAdminAiViewState(ctx.from.id);

      // при открытии фильтра можно свернуть "инструменты", чтобы не раздувать клавиатуру
      const nextExpanded = !st.aiFilterExpanded;

      setAdminAiViewState(ctx.from.id, {
        aiFilterExpanded: nextExpanded,
        aiToolsExpanded: nextExpanded ? false : st.aiToolsExpanded,
      });

      await showAiLogsList(ctx, page);
    } catch (err) {
      logError("admin_ai_filter_toggle_x", err);
    }
  });

  bot.action(/^admin_ai_log_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const logId = parseInt(ctx.match[1], 10);
      const page = parseInt(ctx.match[2], 10) || 1;
      await showAiLogDetails(ctx, logId, page);
    } catch (err) {
      logError("admin_ai_log_x", err);
    }
  });

  bot.action(/^admin_ai_logs_filter_offtopic_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const page = parseInt(ctx.match[1], 10) || 1;
      setAdminAiViewState(ctx.from.id, { aiFilter: "offtopic" });
      await showAiLogsList(ctx, page);
    } catch (err) {
      logError("admin_ai_logs_filter_offtopic_x", err);
    }
  });

  bot.action(/^admin_ai_logs_filter_all_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const page = parseInt(ctx.match[1], 10) || 1;
      setAdminAiViewState(ctx.from.id, { aiFilter: "all" });
      await showAiLogsList(ctx, page);
    } catch (err) {
      logError("admin_ai_logs_filter_all_x", err);
    }
  });

  // подтверждение оффтопика (как было) — оставляем
  bot.action(/^admin_ai_log_mark_offtopic_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const logId = parseInt(ctx.match[1], 10);
      const returnPage = parseInt(ctx.match[2], 10) || 1;

      const res = await pool.query(
        "SELECT id, user_id, is_offtopic_confirmed FROM ai_chat_logs WHERE id = $1",
        [logId]
      );
      if (!res.rows.length) {
        await ctx.reply("Запись общения с ИИ не найдена.");
        return;
      }

      const row = res.rows[0];

      // Сколько замечаний было раньше
      let issuesBefore = 0;
      if (row.user_id) {
        const cntRes = await pool.query(
          "SELECT COUNT(*) AS cnt FROM ai_chat_logs WHERE user_id = $1 AND is_offtopic_confirmed = TRUE",
          [row.user_id]
        );
        issuesBefore = Number(cntRes.rows[0]?.cnt || 0);
      }

      // Помечаем как "не по работе"
      await pool.query(
        `
          UPDATE ai_chat_logs
          SET is_offtopic_suspected = TRUE, is_offtopic_confirmed = TRUE
          WHERE id = $1
        `,
        [logId]
      );

      // Логирование действия
      if (row.user_id) {
        await pool.query(
          `
            INSERT INTO admin_action_logs (admin_id, target_user_id, action_type, details)
            VALUES ($1, $2, $3, $4)
          `,
          [admin.id, row.user_id, "ai_offtopic_confirmed", { logId }]
        );
      }

      // Уведомление пользователю (пока оставляем как есть; политику вынесем в настройки следующим шагом)
      if (row.user_id) {
        let notifText;
        if (issuesBefore === 0) {
          notifText =
            "🚫🤖 Обращение к ИИ не по работе. Это первое предупреждение. В следующий раз будет штраф 100 ₽.";
        } else {
          notifText =
            "🚫🤖 Повторное обращение к ИИ не по работе. Назначен штраф 100 ₽.";
        }

        const notifRes = await pool.query(
          "INSERT INTO notifications (text, created_by) VALUES ($1, $2) RETURNING id",
          [notifText, admin.id]
        );
        const notifId = notifRes.rows[0].id;

        await pool.query(
          "INSERT INTO user_notifications (notification_id, user_id) VALUES ($1, $2)",
          [notifId, row.user_id]
        );

        const uRes = await pool.query(
          "SELECT telegram_id FROM users WHERE id = $1",
          [row.user_id]
        );
        if (uRes.rows.length && uRes.rows[0].telegram_id) {
          try {
            await ctx.telegram.sendMessage(
              uRes.rows[0].telegram_id,
              "🚫🤖 НОВОЕ УВЕДОМЛЕНИЕ❗ Нажмите: /notification"
            );
          } catch (e) {}
        }
      }

      await showAiLogDetails(ctx, logId, returnPage);
    } catch (err) {
      logError("admin_ai_log_mark_offtopic_x", err);
    }
  });

  bot.action(/^admin_ai_log_mark_ok_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const logId = parseInt(ctx.match[1], 10);
      const returnPage = parseInt(ctx.match[2], 10) || 1;

      const res = await pool.query(
        "SELECT id, user_id FROM ai_chat_logs WHERE id = $1",
        [logId]
      );
      if (!res.rows.length) {
        await ctx.reply("Запись общения с ИИ не найдена.");
        return;
      }

      const row = res.rows[0];

      await pool.query(
        `
          UPDATE ai_chat_logs
          SET is_offtopic_suspected = FALSE, is_offtopic_confirmed = FALSE, off_topic_comment = NULL
          WHERE id = $1
        `,
        [logId]
      );

      if (row.user_id) {
        await pool.query(
          `
            INSERT INTO admin_action_logs (admin_id, target_user_id, action_type, details)
            VALUES ($1, $2, $3, $4)
          `,
          [admin.id, row.user_id, "ai_marked_as_work", { logId }]
        );
      }

      await showAiLogDetails(ctx, logId, returnPage);
    } catch (err) {
      logError("admin_ai_log_mark_ok_x", err);
    }
  });

  // --- Статистика (как было) ---
  bot.action("admin_ai_stats_menu", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const text = "📊 Статистика обращений к ИИ.\n\nВыбери период:";
      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback("📅 День", "admin_ai_stats_day"),
          Markup.button.callback("📆 Неделя", "admin_ai_stats_week"),
        ],
        [
          Markup.button.callback("🗓 Месяц", "admin_ai_stats_month"),
          Markup.button.callback("📈 Год", "admin_ai_stats_year"),
        ],
        [Markup.button.callback("🔙 К списку обращений", "admin_ai_logs_1")],
      ]);

      await deliver(ctx, { text, extra: keyboard }, { edit: true });
    } catch (err) {
      logError("admin_ai_stats_menu_x", err);
    }
  });

  bot.action(/^admin_ai_stats_(day|week|month|year)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const period = ctx.match[1];
      const stats = await getAiStats(period);

      const labels = {
        day: "за день",
        week: "за неделю",
        month: "за месяц",
        year: "за год",
      };

      const text =
        `📊 Статистика обращений к ИИ ${labels[period]}:\n\n` +
        `• Всего вопросов: ${stats.total}\n` +
        `• Пользователей: ${stats.users}\n` +
        `• Отмечено "не по работе": ${stats.offtopic}\n\n` +
        "Можно выбрать другой период:";

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback("📅 День", "admin_ai_stats_day"),
          Markup.button.callback("📆 Неделя", "admin_ai_stats_week"),
        ],
        [
          Markup.button.callback("🗓 Месяц", "admin_ai_stats_month"),
          Markup.button.callback("📈 Год", "admin_ai_stats_year"),
        ],
        [Markup.button.callback("🔙 К списку обращений", "admin_ai_logs_1")],
      ]);

      await deliver(ctx, { text, extra: keyboard }, { edit: true });
    } catch (err) {
      logError("admin_ai_stats_x", err);
    }
  });

  // --- Метрики / аналитика ---
  bot.action("admin_ai_metrics_menu", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const text =
        "📈 Метрики / аналитика по обращениям к ИИ.\n\nВыбери период:";
      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback("📅 День", "admin_ai_metrics_day"),
          Markup.button.callback("📆 Неделя", "admin_ai_metrics_week"),
        ],
        [
          Markup.button.callback("🗓 Месяц", "admin_ai_metrics_month"),
          Markup.button.callback("📈 Год", "admin_ai_metrics_year"),
        ],
        [Markup.button.callback("🔙 К списку обращений", "admin_ai_logs_1")],
      ]);

      await deliver(ctx, { text, extra: keyboard }, { edit: true });
    } catch (err) {
      logError("admin_ai_metrics_menu_x", err);
    }
  });

  bot.action(/^admin_ai_metrics_(day|week|month|year)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const period = ctx.match[1];
      const m = await getAiMetrics(period);

      const labels = {
        day: "за день",
        week: "за неделю",
        month: "за месяц",
        year: "за год",
      };

      let text =
        `📈 Метрики по обращениям к ИИ ${labels[period]}:\n\n` +
        `• Всего ответов: ${m.total}\n` +
        `• Уникальных пользователей: ${m.users}\n` +
        `• Подтверждено "не по работе": ${m.offtopicConfirmed} (${m.offtopicPercent}%)\n` +
        `• Подозрительных (ожидают решения): ${m.pendingOfftopic}\n` +
        `• Средняя длина ответа: ~${m.avgAnswerLen} символов\n` +
        `• Ответов "не нашёл в базе": ${m.noTheoryLike}\n\n`;

      if (m.topUsers.length) {
        text += "Топ пользователей по числу обращений:\n";
        for (const u of m.topUsers) {
          text += `• ${u.name}: ${u.cnt}\n`;
        }
      } else {
        text += "Топ пользователей: данных нет.\n";
      }

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback("📅 День", "admin_ai_metrics_day"),
          Markup.button.callback("📆 Неделя", "admin_ai_metrics_week"),
        ],
        [
          Markup.button.callback("🗓 Месяц", "admin_ai_metrics_month"),
          Markup.button.callback("📈 Год", "admin_ai_metrics_year"),
        ],
        [Markup.button.callback("🔙 К списку обращений", "admin_ai_logs_1")],
      ]);

      await deliver(ctx, { text, extra: keyboard }, { edit: true });
    } catch (err) {
      logError("admin_ai_metrics_x", err);
    }
  });
}

module.exports = {
  registerAiLogs: registerAdminAiLogs,
  getNewAiLogsCount,
  getPendingOfftopicCount,
};
