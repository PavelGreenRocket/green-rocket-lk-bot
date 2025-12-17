// src/bot/admin/users/candidateList.js

const { Markup } = require("telegraf");
const pool = require("../../../db/pool");
const { deliver } = require("../../../utils/renderHelpers");
const { showCandidateCardLk } = require("./candidateCard");

// Фильтры вынесены в отдельный модуль
const {
  getCandidateFilters,
  setCandidateFilters,
  resetCandidateFilters,
} = require("./candidateFilters");
const { registerCandidateEditHandlers } = require("./candidateEdit");
const declineReasonStates = new Map(); // key: tgId, value: { candidateId }
const restoreModeStates = new Map();
const historyCandidatesFilter = new Map();

// ✅ Геттер restore-mode для candidateEdit.js
function isRestoreModeFor(tgId, candidateId) {
  return restoreModeStates.get(tgId) === candidateId;
}
// key: tgId -> value: 'invited' | 'interviewed' | 'internship_invited' | null

// ----------------------------------------
// СОСТОЯНИЕ РЕДАКТИРОВАНИЯ СОТРУДНИКОВ
// ----------------------------------------

const workerEditStates = new Map();

function getWorkerEditState(tgId) {
  return workerEditStates.get(tgId) || null;
}

function setWorkerEditState(tgId, state) {
  workerEditStates.set(tgId, state);
}

function clearWorkerEditState(tgId) {
  workerEditStates.delete(tgId);
}

// ----------------------------------------
// ХЕЛПЕРЫ ФОРМАТИРОВАНИЯ
// ----------------------------------------

const WEEK_DAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

function getStatusIcon(status) {
  switch (status) {
    case "invited":
      return "🕒";
    case "interviewed":
      return "✔️";
    case "internship_invited":
      return "☑️";
    case "cancelled":
    case "declined":
      return "❌";
    default:
      return "🕒";
  }
}

// 07.12 на 11:00 (ср)
function formatDateTimeShort(isoDate, timeStr) {
  if (!isoDate && !timeStr) return "не указана";

  let date = null;

  if (isoDate instanceof Date) {
    date = isoDate;
  } else if (typeof isoDate === "string") {
    const parts = isoDate.split("-");
    if (parts.length === 3) {
      const [y, m, d] = parts.map((x) => parseInt(x, 10));
      if (Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d)) {
        date = new Date(y, m - 1, d);
      }
    }
  }

  let datePart = "";
  let weekdayPart = "";

  if (date && !Number.isNaN(date.getTime())) {
    const dd = String(date.getDate()).padStart(2, "0");
    const mm = String(date.getMonth() + 1).padStart(2, "0");
    datePart = `${dd}.${mm}`;
    weekdayPart = WEEK_DAYS[date.getDay()];
  }

  let result = "";
  if (datePart) result += datePart;
  if (timeStr) result += (result ? " на " : "") + timeStr;
  if (weekdayPart) result += ` (${weekdayPart})`;
  return result || "не указана";
}

// ----------------------------------------
// ЗАГРУЗКА КАНДИДАТОВ ИЗ БД
// ----------------------------------------

async function loadCandidatesForAdmin(user, filters) {
  const statuses = [];

  if (filters.waiting) statuses.push("invited");
  if (filters.arrived) statuses.push("interviewed");
  if (filters.internshipInvited) statuses.push("internship_invited");
  if (filters.cancelled) statuses.push("cancelled");

  if (!statuses.length) {
    statuses.push("invited", "interviewed", "internship_invited");
  }

  const params = [statuses];
  let where = "c.status = ANY($1) AND c.status <> 'declined'";

  if (filters.scope === "personal") {
    params.push(user.id);
    where += " AND c.admin_id = $2";
  }

  if (!filters.cancelled) {
    where += " AND c.status <> 'cancelled'";
  }

  const res = await pool.query(
    `
      SELECT
        c.id,
        c.name,
        c.age,
        c.status,
        c.interview_date,
        c.interview_time,
        COALESCE(tp_place.title, 'не указано') AS place_title
      FROM candidates c
        LEFT JOIN trade_points tp_place ON c.point_id = tp_place.id
      WHERE ${where}
      ORDER BY c.interview_date NULLS LAST, c.interview_time NULLS LAST, c.id
    `,
    params
  );

  return res.rows;
}

// ----------------------------------------
// ОТРИСОВКА СПИСКА КАНДИДАТОВ
// ----------------------------------------

async function showCandidatesListLk(ctx, user, options = {}) {
  const tgId = ctx.from.id;
  const filters = getCandidateFilters(tgId);
  const shouldEdit =
    options.edit !== undefined
      ? options.edit
      : ctx.updateType === "callback_query";

  const candidates = await loadCandidatesForAdmin(user, filters);

  let text = "🟢 *Кандидаты*\n\n";
  text += "🕒 — приглашены на собеседование\n";
  text += "✔️ — пришли на собеседование, ожидают решения\n";
  text += "☑️ — приглашены на стажировку\n\n";

  if (filters.scope === "personal") {
    text += "Показаны только твои кандидаты.\n\n";
  } else {
    text += "Показаны все собеседования.\n\n";
  }

  if (!candidates.length) {
    text += "⚠️ По текущим фильтрам кандидатов нет.\n";
  } else {
    text += "Выбери кандидата:\n\n";
  }

  // Кнопки списка кандидатов
  const rows = [];

  for (const c of candidates) {
    const icon = getStatusIcon(c.status);
    const agePart = c.age ? ` (${c.age})` : "";
    const dt = formatDateTimeShort(c.interview_date, c.interview_time);

    rows.push([
      Markup.button.callback(
        `${icon} ${c.name}${agePart} — ${dt}`,
        `lk_cand_open_${c.id}` // сюда кликаем → открывается карточка
      ),
    ]);
  }

  // 2) ТРИ РЕЖИМА — как в старом users.js

  // 2) НИЗ ЭКРАНА (3 состояния): обычный / раскрыть / фильтр

  // вкладки всегда показываем
  rows.push([
    Markup.button.callback("✅ Кандидаты", "admin_users_candidates"),
    Markup.button.callback("Стажёры", "admin_users_interns"),
    Markup.button.callback("Сотрудники", "admin_users_workers"),
  ]);

  // --- СОСТОЯНИЕ: РАСКРЫТО ("раскрыть") ---
  if (filters.historyExpanded) {
    // + добавить (только внутри раскрыть)
    rows.push([
      Markup.button.callback("+ добавить", "lk_cand_create_start"),
      Markup.button.callback("+ добавить", "lk_add_intern"),
      Markup.button.callback("+ добавить", "lk_add_worker"),
    ]);

    // скрыть
    rows.push([
      Markup.button.callback("🔼 скрыть 🔼", "lk_cand_toggle_history"),
    ]);

    // общение с ИИ (заглушка)
    rows.push([Markup.button.callback("🔮 Общение с ИИ", "admin_ai_logs_1")]);

    // история
    rows.push([Markup.button.callback("📜 история", "lk_history_menu")]);

    // фильтр (в свернутом виде)
    rows.push([
      Markup.button.callback("🔽 Фильтр 🔽", "lk_cand_filter_toggle"),
    ]);

    // назад
    rows.push([Markup.button.callback("⬅️ Назад", "lk_admin_menu")]);

    // --- СОСТОЯНИЕ: ФИЛЬТР РАСКРЫТ ---
  } else if (filters.filtersExpanded) {
    // раскрыть (свернутое) — отдельной кнопкой
    rows.push([
      Markup.button.callback("🔽 раскрыть 🔽", "lk_cand_toggle_history"),
    ]);

    // фильтр (раскрытый) — отдельной кнопкой
    rows.push([
      Markup.button.callback("🔼 Фильтр 🔼", "lk_cand_filter_toggle"),
    ]);

    // статусы в 1 строку: 🕒 | ✔️ | ☑️ | ❌
    rows.push([
      Markup.button.callback(
        filters.waiting ? "🕒" : "➖🕒",
        "lk_cand_filter_status_waiting"
      ),
      Markup.button.callback(
        filters.arrived ? "✔️" : "➖✔️",
        "lk_cand_filter_status_arrived"
      ),
      Markup.button.callback(
        filters.internshipInvited ? "☑️" : "➖☑️",
        "lk_cand_filter_status_internship"
      ),
      Markup.button.callback(
        filters.cancelled ? "❌" : "➖❌",
        "lk_cand_filter_status_cancelled"
      ),
    ]);

    // 👤 личные | 👥 все
    rows.push([
      Markup.button.callback(
        filters.scope === "personal" ? "✅ 👤 личные" : "👤 личные",
        "lk_cand_filter_scope_personal"
      ),
      Markup.button.callback(
        filters.scope === "all" ? "✅ 👥 все" : "👥 все",
        "lk_cand_filter_scope_all"
      ),
    ]);

    // сбросить фильтры
    rows.push([
      Markup.button.callback("🔄 Сбросить фильтры", "lk_cand_filter_reset"),
    ]);

    // назад
    rows.push([Markup.button.callback("⬅️ Назад", "lk_admin_menu")]);

    // --- СОСТОЯНИЕ: ОБЫЧНОЕ (ничего не раскрыто) ---
  } else {
    // раскрыть (отдельно)
    rows.push([
      Markup.button.callback("🔽 раскрыть 🔽", "lk_cand_toggle_history"),
    ]);

    // фильтр (отдельно)
    rows.push([
      Markup.button.callback("🔽 Фильтр 🔽", "lk_cand_filter_toggle"),
    ]);

    // назад
    rows.push([Markup.button.callback("⬅️ Назад", "lk_admin_menu")]);
  }

  const keyboard = Markup.inlineKeyboard(rows);
  const extra = { ...keyboard, parse_mode: "Markdown" };

  await deliver(ctx, { text, extra }, { edit: shouldEdit });
}

// ----------------------------------------
// РЕГИСТРАЦИЯ ХЕНДЛЕРОВ ДЛЯ СПИСКА И ФИЛЬТРОВ
// ----------------------------------------

function registerCandidateListHandlers(bot, ensureUser, logError) {
  registerCandidateEditHandlers(
    bot,
    ensureUser,
    logError,
    showCandidateCardLk,
    isRestoreModeFor
  );

  const POSITIONS = [
    { code: "barista", label: "Бариста" },
    { code: "point_admin", label: "Администратор точки" },
    { code: "senior_admin", label: "Старший админ" },
    { code: "quality_manager", label: "Менеджер по качеству" },
    { code: "supervisor", label: "Руководитель" },
    { code: "control", label: "Управляющий" },
  ];

  const STAFF_STATUSES = [
    { code: "candidate", label: "Кандидат" },
    { code: "intern", label: "Стажёр" },
    { code: "worker", label: "Сотрудник" },
  ];

  const ROLES = [
    { code: "user", label: "Пользователь" },
    { code: "admin", label: "Админ" },
    { code: "super_admin", label: "Супер-админ" },
  ];

  // Вход в раздел "Пользователи" → сразу показываем кандидатов
  bot.action("admin_users", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        return;
      }

      await showCandidatesListLk(ctx, user, { edit: true });
    } catch (err) {
      logError("admin_users", err);
    }
  });

  // Явно "Кандидаты" из сегмента
  bot.action("admin_users_candidates", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        return;
      }

      await showCandidatesListLk(ctx, user, { edit: true });
    } catch (err) {
      logError("admin_users_candidates", err);
    }
  });

  // Быстрый переход "Мои собеседования"
  bot.action("lk_admin_my_interviews", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        return;
      }

      const tgId = ctx.from.id;
      const current = getCandidateFilters(tgId);
      const next = {
        ...current,
        scope: "personal",
        waiting: true,
        arrived: false,
        internshipInvited: false,
        cancelled: false,
      };
      setCandidateFilters(tgId, next);

      await showCandidatesListLk(ctx, user, { edit: true });
    } catch (err) {
      logError("lk_admin_my_interviews", err);
    }
  });

  // ================================
  // ИСТОРИЯ (общий раздел)
  // ================================

  // Главный экран выбора: кандидаты / стажёры / сотрудники
  bot.action("lk_history_menu", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});

      const text = "📜 <b>История</b>\n\n" + "Выберите раздел:";

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "👤 история кандидатов",
            "lk_history_candidates"
          ),
        ],
        [Markup.button.callback("🎓 история стажёров", "lk_history_interns")],
        [Markup.button.callback("🧑‍💼 история сотрудников", "lk_history_staff")],
        [Markup.button.callback("⬅️ Назад", "lk_history_back")],
      ]);

      // Если это вызвано из inline-сообщения — редактируем, иначе просто ответ
      if (ctx.callbackQuery?.message?.message_id) {
        await ctx.editMessageText(text, {
          parse_mode: "HTML",
          reply_markup: keyboard.reply_markup,
        });
      } else {
        await ctx.reply(text, {
          parse_mode: "HTML",
          reply_markup: keyboard.reply_markup,
        });
      }
    } catch (err) {
      logError("lk_history_menu", err);
    }
  });

  // Назад из истории → возвращаемся к списку кандидатов (тот же экран)
  bot.action("lk_history_back", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      // Возвращаемся в список кандидатов (как было)
      await showCandidatesListLk(ctx, await ensureUser(ctx), { edit: true });
    } catch (err) {
      logError("lk_history_back", err);
    }
  });

  async function showHistoryEntityScreen(
    ctx,
    title,
    deleteLabel,
    postponeLabel,
    deleteAction,
    postponeAction
  ) {
    const text =
      `📜 <b>${title}</b>\n\n` +
      "Выбери раздел:\n" +
      `1) ❌ ${deleteLabel} — будут удалены через 30 дней после отказа или отмены.\n` +
      `2) 🗑️ ${postponeLabel} — остаются в базе без автоудаления.`;

    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback(`❌ ${deleteLabel}`, deleteAction)],
      [Markup.button.callback(`🗑️ ${postponeLabel}`, postponeAction)],
      [Markup.button.callback("⬅️ Назад", "lk_history_menu")],
    ]);

    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      reply_markup: keyboard.reply_markup,
    });
  }

  // История кандидатов (каркас как на твоём скрине 2)
  bot.action("lk_history_candidates", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      await showHistoryEntityScreen(
        ctx,
        "История кандидатов",
        "Кандидаты на удалении",
        "Отложенные кандидаты",
        "lk_hist_del_open",
        "lk_hist_def_open"
      );
    } catch (err) {
      logError("lk_history_candidates", err);
    }
  });

  // История стажёров (каркас)
  bot.action("lk_history_interns", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      await showHistoryEntityScreen(
        ctx,
        "История кандидатов",
        "Кандидаты на удалении",
        "Отложенные кандидаты",
        "lk_hist_del_open",
        "lk_hist_def_open"
      );
    } catch (err) {
      logError("lk_history_interns", err);
    }
  });

  // История сотрудников (каркас)
  bot.action("lk_history_staff", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      await showHistoryEntityScreen(
        ctx,
        "История кандидатов",
        "Кандидаты на удалении",
        "Отложенные кандидаты",
        "lk_hist_del_open",
        "lk_hist_def_open"
      );
    } catch (err) {
      logError("lk_history_staff", err);
    }
  });

  // Заглушки: функционал добавим позже
  bot.action("lk_history_stub_delete", async (ctx) => {
    try {
      await ctx.answerCbQuery("Скоро добавим этот раздел.").catch(() => {});
    } catch (err) {
      logError("lk_history_stub_delete", err);
    }
  });

  bot.action("lk_history_stub_postpone", async (ctx) => {
    try {
      await ctx.answerCbQuery("Скоро добавим этот раздел.").catch(() => {});
    } catch (err) {
      logError("lk_history_stub_postpone", err);
    }
  });

  bot.action(/^lk_cand_postpone_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const candidateId = Number(ctx.match[1]);

      await pool.query(
        `
      UPDATE candidates
         SET is_deferred = true,
             declined_at = NULL
       WHERE id = $1
      `,
        [candidateId]
      );

      await showCandidateCardLk(ctx, candidateId, { edit: true });
    } catch (err) {
      logError("lk_cand_postpone", err);
    }
  });

  // Быстрый переход "Мои стажировки"
  bot.action("lk_admin_my_internships", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        return;
      }

      const tgId = ctx.from.id;
      const current = getCandidateFilters(tgId);
      const next = {
        ...current,
        scope: "personal",
        waiting: false,
        arrived: false,
        internshipInvited: true,
        cancelled: false,
      };
      setCandidateFilters(tgId, next);

      await showCandidatesListLk(ctx, user, { edit: true });
    } catch (err) {
      logError("lk_admin_my_internships", err);
    }
  });

  async function showCandidatesOnDeletion(ctx, { edit } = {}) {
    const tgId = ctx.from.id;
    const stage = historyCandidatesFilter.get(tgId) || null;

    const params = [];
    let where = `
    c.status = 'rejected'
    AND c.is_deferred = false
    AND c.declined_at IS NOT NULL
  `;

    if (stage) {
      params.push(stage);
      where += ` AND c.closed_from_status = $${params.length}`;
    }

    const res = await pool.query(
      `
      SELECT c.id, c.name, c.age, c.declined_at, c.closed_from_status
      FROM candidates c
      WHERE ${where}
      ORDER BY c.declined_at DESC, c.id DESC
      LIMIT 20
    `,
      params
    );

    const total = res.rows.length;

    let text =
      "❌ <b>Кандидаты на удалении</b>\n\n" +
      "Эти кандидаты находятся в списке на удаление и будут автоматически удалены через 30 дней после отказа или отмены.\n\n" +
      "Фильтры по этапу, на котором кандидат выбыл:\n" +
      "✔️ — после собеседования\n" +
      "✅ — после приглашения на стажировку\n" +
      "🕒 — до собеседования\n" +
      "🔄 — снять фильтр\n\n" +
      `Найдено: ${total}\n\n` +
      (total ? "Выбери кандидата:" : "Пока нет кандидатов на удалении.");

    const rows = [];

    // Кнопки-кандидаты
    for (const c of res.rows) {
      const title = `${c.name}${c.age ? ` (${c.age})` : ""} - ${
        c.declined_at ? String(c.declined_at).slice(0, 10) : ""
      }`;
      rows.push([Markup.button.callback(title, `lk_cand_open_${c.id}`)]);
    }

    // Фильтры (как на твоём скрине — 4 кнопки внизу)
    rows.push([
      Markup.button.callback("✔️", "lk_hist_del_filter_interviewed"),
      Markup.button.callback("✅", "lk_hist_del_filter_internship"),
      Markup.button.callback("🕒", "lk_hist_del_filter_invited"),
      Markup.button.callback("🔄", "lk_hist_del_filter_clear"),
    ]);

    // Назад
    rows.push([Markup.button.callback("⬅️ Назад", "lk_history_candidates")]);

    const keyboard = Markup.inlineKeyboard(rows);

    if (edit) {
      await ctx.editMessageText(text, {
        parse_mode: "HTML",
        reply_markup: keyboard.reply_markup,
      });
    } else {
      await ctx.reply(text, {
        parse_mode: "HTML",
        reply_markup: keyboard.reply_markup,
      });
    }
  }

  async function showDeferredCandidates(ctx, { edit } = {}) {
    const tgId = ctx.from.id;
    const stage = historyCandidatesFilter.get(tgId) || null;

    const params = [];
    let where = `
    c.status = 'rejected'
    AND c.is_deferred = true
  `;

    if (stage) {
      params.push(stage);
      where += ` AND c.closed_from_status = $${params.length}`;
    }

    const res = await pool.query(
      `
      SELECT c.id, c.name, c.age, c.closed_from_status
      FROM candidates c
      WHERE ${where}
      ORDER BY c.id DESC
      LIMIT 20
    `,
      params
    );

    const total = res.rows.length;

    let text =
      "🗑️ <b>Отложенные кандидаты</b>\n\n" +
      "Такие кандидаты сохранены, чтобы к ним можно было вернуться позже. Они не удаляются автоматически.\n\n" +
      "Фильтры по этапу, на котором кандидат выбыл:\n" +
      "✔️ — после собеседования\n" +
      "✅ — после приглашения на стажировку\n" +
      "🕒 — до собеседования\n" +
      "🔄 — снять фильтр\n\n" +
      (total ? "Выбери кандидата:" : "ℹ️ Пока нет отложенных кандидатов.");

    const rows = [];

    for (const c of res.rows) {
      const title = `${c.name}${c.age ? ` (${c.age})` : ""}`;
      rows.push([Markup.button.callback(title, `lk_cand_open_${c.id}`)]);
    }

    rows.push([
      Markup.button.callback("✔️", "lk_hist_def_filter_interviewed"),
      Markup.button.callback("✅", "lk_hist_def_filter_internship"),
      Markup.button.callback("🕒", "lk_hist_def_filter_invited"),
      Markup.button.callback("🔄", "lk_hist_def_filter_clear"),
    ]);

    rows.push([Markup.button.callback("⬅️ Назад", "lk_history_candidates")]);

    const keyboard = Markup.inlineKeyboard(rows);

    if (edit) {
      await ctx.editMessageText(text, {
        parse_mode: "HTML",
        reply_markup: keyboard.reply_markup,
      });
    } else {
      await ctx.reply(text, {
        parse_mode: "HTML",
        reply_markup: keyboard.reply_markup,
      });
    }
  }

  bot.action("lk_hist_del_open", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await showCandidatesOnDeletion(ctx, { edit: true });
  });

  bot.action("lk_hist_def_open", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await showDeferredCandidates(ctx, { edit: true });
  });

  bot.action("lk_hist_del_filter_interviewed", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    historyCandidatesFilter.set(ctx.from.id, "interviewed");
    await showCandidatesOnDeletion(ctx, { edit: true });
  });
  bot.action("lk_hist_del_filter_internship", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    historyCandidatesFilter.set(ctx.from.id, "internship_invited");
    await showCandidatesOnDeletion(ctx, { edit: true });
  });
  bot.action("lk_hist_del_filter_invited", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    historyCandidatesFilter.set(ctx.from.id, "invited");
    await showCandidatesOnDeletion(ctx, { edit: true });
  });
  bot.action("lk_hist_del_filter_clear", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    historyCandidatesFilter.delete(ctx.from.id);
    await showCandidatesOnDeletion(ctx, { edit: true });
  });

  bot.action("lk_hist_def_filter_interviewed", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    historyCandidatesFilter.set(ctx.from.id, "interviewed");
    await showDeferredCandidates(ctx, { edit: true });
  });
  bot.action("lk_hist_def_filter_internship", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    historyCandidatesFilter.set(ctx.from.id, "internship_invited");
    await showDeferredCandidates(ctx, { edit: true });
  });
  bot.action("lk_hist_def_filter_invited", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    historyCandidatesFilter.set(ctx.from.id, "invited");
    await showDeferredCandidates(ctx, { edit: true });
  });
  bot.action("lk_hist_def_filter_clear", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    historyCandidatesFilter.delete(ctx.from.id);
    await showDeferredCandidates(ctx, { edit: true });
  });

  // ----- СПИСОК СОТРУДНИКОВ -----

  async function showWorkersListLk(ctx, currentUser, options = {}) {
    const res = await pool.query(
      `
        SELECT id, full_name, position, role, staff_status
        FROM users
        WHERE staff_status = 'worker'
        ORDER BY full_name
      `
    );

    const workers = res.rows;

    let text = "👥 *Сотрудники*\n\n";

    if (!workers.length) {
      text += "Пока нет ни одного сотрудника.\n\n";
    } else {
      text += "Выбери сотрудника:\n\n";
    }

    const rows = [];

    for (const w of workers) {
      const name = w.full_name || "Без имени";
      const posText = w.position || "без должности";
      rows.push([
        Markup.button.callback(
          `${name} — ${posText}`,
          `admin_worker_open_${w.id}`
        ),
      ]);
    }

    // Низ — те же три режима, что и у кандидатов
    rows.push([
      Markup.button.callback("Кандидаты", "admin_users_candidates"),
      Markup.button.callback("Стажёры", "admin_users_interns"),
      Markup.button.callback("✅ Сотрудники", "admin_users_workers"),
    ]);

    rows.push([
      Markup.button.callback("+ добавить", "lk_cand_create_start"),
      Markup.button.callback("+ добавить", "lk_add_intern"),
      Markup.button.callback("+ добавить", "lk_add_worker"),
    ]);

    rows.push([Markup.button.callback("⬅️ Назад", "lk_admin_menu")]);

    const keyboard = Markup.inlineKeyboard(rows);

    if (options.edit) {
      await deliver(ctx, { text, extra: keyboard }, { edit: true });
    } else {
      await ctx.reply(text, keyboard);
    }
  }

  // ----- КАРТОЧКА СОТРУДНИКА -----

  async function showWorkerCardLk(ctx, workerId, options = {}) {
    const res = await pool.query(
      `
        SELECT
          id,
          full_name,
          role,
          staff_status,
          position,
          work_phone,
          username
        FROM users
        WHERE id = $1
      `,
      [workerId]
    );

    if (!res.rows.length) {
      if (!options.silent) {
        await ctx.reply("Этот сотрудник не найден или был удалён.");
      }
      return;
    }

    const u = res.rows[0];

    const roleLabels = {
      super_admin: "супер-админ",
      admin: "админ",
      user: "пользователь",
    };

    const statusLabels = {
      candidate: "кандидат",
      intern: "стажёр",
      worker: "сотрудник",
    };

    const roleText = roleLabels[u.role] || u.role || "не указана";
    const statusText =
      statusLabels[u.staff_status] || u.staff_status || "не указан";
    const positionText = u.position || "не указана";
    const workPhoneText = u.work_phone || "не указан";
    const usernameText = u.username ? `@${u.username}` : "не указан";

    let text = "🧑‍💼 *Сотрудник*\n\n";
    text += `• Имя: ${u.full_name || "не указано"}\n`;
    text += `• Роль: ${roleText}\n`;
    text += `• Статус: ${statusText}\n`;
    text += `• Должность: ${positionText}\n`;
    text += `• Рабочий номер: ${workPhoneText}\n`;
    text += `• Username: ${usernameText}\n`;

    const rows = [];

    rows.push([
      Markup.button.callback("⚙️ Настройки", `admin_worker_settings_${u.id}`),
    ]);
    rows.push([
      Markup.button.callback("⬅️ К сотрудникам", "admin_users_workers"),
    ]);

    const keyboard = Markup.inlineKeyboard(rows);

    if (options.edit) {
      await deliver(ctx, { text, extra: keyboard }, { edit: true });
    } else {
      await ctx.reply(text, keyboard);
    }
  }

  // ----- МЕНЮ НАСТРОЕК СОТРУДНИКА -----

  async function showWorkerSettingsMenu(ctx, workerId, options = {}) {
    const res = await pool.query(
      `
        SELECT
          id,
          full_name,
          role,
          staff_status,
          position,
          work_phone,
          username
        FROM users
        WHERE id = $1
      `,
      [workerId]
    );

    if (!res.rows.length) {
      if (!options.silent) {
        await ctx.reply("Этот сотрудник не найден или был удалён.");
      }
      return;
    }

    const u = res.rows[0];

    const roleLabels = {
      super_admin: "супер-админ",
      admin: "админ",
      user: "пользователь",
    };

    const statusLabels = {
      candidate: "кандидат",
      intern: "стажёр",
      worker: "сотрудник",
    };

    const roleText = roleLabels[u.role] || u.role || "не указана";
    const statusText =
      statusLabels[u.staff_status] || u.staff_status || "не указан";
    const positionText = u.position || "не указана";
    const workPhoneText = u.work_phone || "не указан";
    const usernameText = u.username ? `@${u.username}` : "не указан";

    let text = "⚙️ *Настройки сотрудника*\n\n";
    text += `• Имя: ${u.full_name || "не указано"}\n`;
    text += `• Роль: ${roleText}\n`;
    text += `• Статус: ${statusText}\n`;
    text += `• Должность: ${positionText}\n`;
    text += `• Рабочий номер: ${workPhoneText}\n`;
    text += `• Username: ${usernameText}\n`;

    const rows = [];

    rows.push([
      Markup.button.callback(
        "📞 Рабочий номер",
        `admin_worker_edit_phone_${u.id}`
      ),
    ]);
    rows.push([
      Markup.button.callback(
        "@ Username",
        `admin_worker_edit_username_${u.id}`
      ),
    ]);
    rows.push([
      Markup.button.callback(
        "✏️ Изменить имя",
        `admin_worker_edit_name_${u.id}`
      ),
    ]);
    rows.push([
      Markup.button.callback(
        "✏️ Изменить должность",
        `admin_worker_change_position_${u.id}`
      ),
    ]);
    rows.push([
      Markup.button.callback(
        "✏️ Изменить статус",
        `admin_worker_change_status_${u.id}`
      ),
    ]);

    if (u.role !== "super_admin") {
      rows.push([
        Markup.button.callback(
          "✏️ Изменить роль",
          `admin_worker_change_role_${u.id}`
        ),
      ]);
    }

    rows.push([
      Markup.button.callback("⬅️ К сотруднику", `admin_worker_open_${u.id}`),
    ]);

    const keyboard = Markup.inlineKeyboard(rows);

    if (options.edit) {
      await deliver(ctx, { text, extra: keyboard }, { edit: true });
    } else {
      await ctx.reply(text, keyboard);
    }
  }

  // Стажёры — пока заглушка
  bot.action("admin_users_interns", async (ctx) => {
    try {
      await ctx
        .answerCbQuery("Экран стажёров пока в разработке")
        .catch(() => {});
    } catch (err) {
      logError("admin_users_interns", err);
    }
  });

  // Сотрудники — полноценный экран
  bot.action("admin_users_workers", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        return;
      }

      await showWorkersListLk(ctx, user, { edit: true });
    } catch (err) {
      logError("admin_users_workers", err);
    }
  });

  // Открыть карточку сотрудника
  bot.action(/^admin_worker_open_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin")) {
        return;
      }

      const workerId = Number(ctx.match[1]);
      await showWorkerCardLk(ctx, workerId, { edit: true });
    } catch (err) {
      logError("admin_worker_open", err);
    }
  });

  // Открыть меню настроек сотрудника
  bot.action(/^admin_worker_settings_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin")) {
        return;
      }

      const workerId = Number(ctx.match[1]);
      await showWorkerSettingsMenu(ctx, workerId, { edit: true });
    } catch (err) {
      logError("admin_worker_settings", err);
    }
  });

  bot.action(/^admin_worker_edit_phone_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin")) {
        return;
      }

      const workerId = Number(ctx.match[1]);
      setWorkerEditState(ctx.from.id, {
        userId: workerId,
        field: "work_phone",
      });

      await ctx.reply(
        "Введи рабочий номер для этого сотрудника.\n" +
          "Чтобы очистить — отправь «-».\n" +
          "Для отмены — /cancel."
      );
    } catch (err) {
      logError("admin_worker_edit_phone", err);
    }
  });

  bot.action(/^admin_worker_edit_username_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin")) {
        return;
      }

      const workerId = Number(ctx.match[1]);
      setWorkerEditState(ctx.from.id, {
        userId: workerId,
        field: "username",
      });

      await ctx.reply(
        "Введи username сотрудника (можно с @).\n" +
          "Чтобы очистить — отправь «-».\n" +
          "Для отмены — /cancel."
      );
    } catch (err) {
      logError("admin_worker_edit_username", err);
    }
  });

  bot.action(/^admin_worker_edit_name_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin")) {
        return;
      }

      const workerId = Number(ctx.match[1]);
      setWorkerEditState(ctx.from.id, {
        userId: workerId,
        field: "full_name",
      });

      await ctx.reply(
        "Введи новое имя (ФИО) для этого сотрудника.\n" +
          "Для отмены — /cancel."
      );
    } catch (err) {
      logError("admin_worker_edit_name", err);
    }
  });

  bot.action(/^admin_worker_change_status_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin")) {
        return;
      }

      const workerId = Number(ctx.match[1]);
      const res = await pool.query(
        `SELECT full_name, staff_status FROM users WHERE id = $1`,
        [workerId]
      );
      if (!res.rows.length) {
        await ctx.reply("Сотрудник не найден.");
        return;
      }
      const u = res.rows[0];

      let text = `✏️ Выбор статуса для: ${u.full_name || "без имени"}\n\n`;
      text += "Выбери статус:";

      const rows = [];

      for (const s of STAFF_STATUSES) {
        const isCurrent = u.staff_status === s.code;
        rows.push([
          Markup.button.callback(
            (isCurrent ? "✅ " : "⚪ ") + s.label,
            `admin_worker_set_status_${workerId}_${s.code}`
          ),
        ]);
      }

      rows.push([
        Markup.button.callback(
          "⬅️ Назад к настройкам",
          `admin_worker_settings_${workerId}`
        ),
      ]);

      const keyboard = Markup.inlineKeyboard(rows);
      await deliver(ctx, { text, extra: keyboard }, { edit: true });
    } catch (err) {
      logError("admin_worker_change_status", err);
    }
  });

  bot.action(/^admin_worker_set_status_(\d+)_(\w+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin")) {
        return;
      }

      const workerId = Number(ctx.match[1]);
      const code = ctx.match[2];

      await pool.query(`UPDATE users SET staff_status = $1 WHERE id = $2`, [
        code,
        workerId,
      ]);

      await showWorkerSettingsMenu(ctx, workerId, { edit: true });
    } catch (err) {
      logError("admin_worker_set_status", err);
    }
  });

  bot.action(/^admin_worker_change_role_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin")) {
        return;
      }

      const workerId = Number(ctx.match[1]);
      const res = await pool.query(
        `SELECT full_name, role FROM users WHERE id = $1`,
        [workerId]
      );
      if (!res.rows.length) {
        await ctx.reply("Сотрудник не найден.");
        return;
      }
      const u = res.rows[0];

      if (u.role === "super_admin") {
        await ctx
          .answerCbQuery("Роль супер-админа можно менять только через /more.", {
            show_alert: true,
          })
          .catch(() => {});
        return;
      }

      let text = `✏️ Выбор роли для: ${u.full_name || "без имени"}\n\n`;
      text += "Выбери роль:";

      const rows = [];

      for (const r of ROLES) {
        const isCurrent = u.role === r.code;
        rows.push([
          Markup.button.callback(
            (isCurrent ? "✅ " : "⚪ ") + r.label,
            `admin_worker_set_role_${workerId}_${r.code}`
          ),
        ]);
      }

      rows.push([
        Markup.button.callback(
          "⬅️ Назад к настройкам",
          `admin_worker_settings_${workerId}`
        ),
      ]);

      const keyboard = Markup.inlineKeyboard(rows);
      await deliver(ctx, { text, extra: keyboard }, { edit: true });
    } catch (err) {
      logError("admin_worker_change_role", err);
    }
  });

  bot.action(/^admin_worker_set_role_(\d+)_(\w+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin")) {
        return;
      }

      const workerId = Number(ctx.match[1]);
      const role = ctx.match[2];

      await pool.query(`UPDATE users SET role = $1 WHERE id = $2`, [
        role,
        workerId,
      ]);

      await showWorkerSettingsMenu(ctx, workerId, { edit: true });
    } catch (err) {
      logError("admin_worker_set_role", err);
    }
  });

  // Текстовый ввод для полей сотрудника (рабочий номер, username, имя)
  bot.on("text", async (ctx, next) => {
    try {
      const state = getWorkerEditState(ctx.from.id);
      if (!state) return next();

      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin")) {
        clearWorkerEditState(ctx.from.id);
        return next();
      }

      let text = (ctx.message.text || "").trim();
      if (!text) return;

      if (text.toLowerCase() === "/cancel" || text.toLowerCase() === "отмена") {
        clearWorkerEditState(ctx.from.id);
        await ctx.reply("Ок, изменения отменены.");
        return;
      }

      const userId = state.userId;

      if (state.field === "work_phone") {
        const value = text === "-" ? null : text;
        await pool.query(`UPDATE users SET work_phone = $1 WHERE id = $2`, [
          value,
          userId,
        ]);
        clearWorkerEditState(ctx.from.id);
        await ctx.reply("Рабочий номер обновлён ✅");
        await showWorkerSettingsMenu(ctx, userId);
        return;
      }

      if (state.field === "username") {
        let value = text;
        if (value === "-" || value === "") {
          value = null;
        } else if (value.startsWith("@")) {
          value = value.slice(1);
        }

        await pool.query(`UPDATE users SET username = $1 WHERE id = $2`, [
          value,
          userId,
        ]);
        clearWorkerEditState(ctx.from.id);
        await ctx.reply("Username обновлён ✅");
        await showWorkerSettingsMenu(ctx, userId);
        return;
      }

      if (state.field === "full_name") {
        if (text.length < 2) {
          await ctx.reply(
            "Имя слишком короткое, попробуй ещё раз или /cancel."
          );
          return;
        }

        await pool.query(`UPDATE users SET full_name = $1 WHERE id = $2`, [
          text,
          userId,
        ]);
        clearWorkerEditState(ctx.from.id);
        await ctx.reply("Имя сотрудника обновлено ✅");
        await showWorkerSettingsMenu(ctx, userId);
        return;
      }

      return next();
    } catch (err) {
      logError("admin_worker_edit_text", err);
      return next();
    }
  });

  bot.on("text", async (ctx, next) => {
    try {
      // Если админ сейчас НЕ вводит причину отказа — отдаём управление дальше,
      // чтобы не ломать добавление кандидата и прочие сценарии.
      const st = declineReasonStates.get(ctx.from.id);
      if (!st) return next();

      const reason = (ctx.message.text || "").trim();
      if (!reason) return;

      // Сбрасываем режим ввода причины
      declineReasonStates.delete(ctx.from.id);

      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin")) {
        return next();
      }

      await applyCandidateDecline(ctx, st.candidateId, reason, admin.id);
    } catch (err) {
      logError("cand_decline_text_reason", err);
      return next();
    }
  });

  // --- ФИЛЬТРЫ ---

  // Открыть/закрыть фильтр
  bot.action("lk_cand_filter_toggle", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        return;
      }

      const tgId = ctx.from.id;
      const filters = getCandidateFilters(tgId);

      // при открытии фильтра — закрываем "раскрыть"
      setCandidateFilters(tgId, {
        filtersExpanded: !filters.filtersExpanded,
        historyExpanded: false,
      });

      await showCandidatesListLk(ctx, user, { edit: true });
    } catch (err) {
      logError("lk_cand_filter_toggle", err);
    }
  });

  // Открыть/закрыть "раскрыть" (история)
  bot.action("lk_cand_toggle_history", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        return;
      }

      const tgId = ctx.from.id;
      const filters = getCandidateFilters(tgId);

      // при открытии "раскрыть" — закрываем фильтр
      setCandidateFilters(tgId, {
        historyExpanded: !filters.historyExpanded,
        filtersExpanded: false,
      });

      await showCandidatesListLk(ctx, user, { edit: true });
    } catch (err) {
      logError("lk_cand_toggle_history", err);
    }
  });

  // Заглушка: "Общение с ИИ"
  bot.action("lk_ai_chat_stub", async (ctx) => {
    try {
      await ctx.answerCbQuery("Скоро добавим 🙂").catch(() => {});
    } catch (err) {
      logError("lk_ai_chat_stub", err);
    }
  });

  bot.action("lk_cand_filter_reset", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        return;
      }

      const tgId = ctx.from.id;
      resetCandidateFilters(tgId);
      await showCandidatesListLk(ctx, user, { edit: true });
    } catch (err) {
      logError("lk_cand_filter_reset", err);
    }
  });

  // Переключение области (личные / все)
  bot.action("lk_cand_filter_scope_personal", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        return;
      }

      const tgId = ctx.from.id;
      setCandidateFilters(tgId, { scope: "personal" });
      await showCandidatesListLk(ctx, user, { edit: true });
    } catch (err) {
      logError("lk_cand_filter_scope_personal", err);
    }
  });

  bot.action("lk_cand_filter_scope_all", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        return;
      }

      const tgId = ctx.from.id;
      setCandidateFilters(tgId, { scope: "all" });
      await showCandidatesListLk(ctx, user, { edit: true });
    } catch (err) {
      logError("lk_cand_filter_scope_all", err);
    }
  });

  // Переключатели статусов
  bot.action("lk_cand_filter_status_waiting", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        return;
      }

      const tgId = ctx.from.id;
      const filters = getCandidateFilters(tgId);
      setCandidateFilters(tgId, { waiting: !filters.waiting });
      await showCandidatesListLk(ctx, user, { edit: true });
    } catch (err) {
      logError("lk_cand_filter_status_waiting", err);
    }
  });

  bot.action("lk_cand_filter_status_arrived", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        return;
      }

      const tgId = ctx.from.id;
      const filters = getCandidateFilters(tgId);
      setCandidateFilters(tgId, { arrived: !filters.arrived });
      await showCandidatesListLk(ctx, user, { edit: true });
    } catch (err) {
      logError("lk_cand_filter_status_arrived", err);
    }
  });

  bot.action("lk_cand_filter_status_internship", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        return;
      }

      const tgId = ctx.from.id;
      const filters = getCandidateFilters(tgId);
      setCandidateFilters(tgId, {
        internshipInvited: !filters.internshipInvited,
      });
      await showCandidatesListLk(ctx, user, { edit: true });
    } catch (err) {
      logError("lk_cand_filter_status_internship", err);
    }
  });

  bot.action("lk_cand_filter_status_cancelled", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        return;
      }

      const tgId = ctx.from.id;
      const filters = getCandidateFilters(tgId);
      setCandidateFilters(tgId, { cancelled: !filters.cancelled });
      await showCandidatesListLk(ctx, user, { edit: true });
    } catch (err) {
      logError("lk_cand_filter_status_cancelled", err);
    }
  });

  // ================================
  // ОТКАЗ КАНДИДАТУ — ВЫБОР ПРИЧИНЫ
  // ================================
  bot.action(/^lk_cand_decline_reason_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const candidateId = Number(ctx.match[1]);

      // Ставим режим ожидания текстовой причины
      declineReasonStates.set(ctx.from.id, { candidateId });

      const text =
        "❓ <b>Укажите причину отказа кандидату</b>\n\n" +
        "Вы можете выбрать причину кнопкой ниже\n" +
        "или написать её текстом сообщением.";

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "🚫 не пришёл и не предупредил",
            `lk_cand_decline_apply_${candidateId}_no_show`
          ),
        ],
        [
          Markup.button.callback(
            "📩 предупредил, что не придёт",
            `lk_cand_decline_apply_${candidateId}_warned`
          ),
        ],
        [
          Markup.button.callback(
            "🤔 странное поведение",
            `lk_cand_decline_apply_${candidateId}_weird`
          ),
        ],
        [
          Markup.button.callback(
            "⬅️ Отмена",
            `lk_cand_decline_cancel_${candidateId}`
          ),
        ],
      ]);

      await ctx.editMessageText(text, {
        parse_mode: "HTML",
        reply_markup: keyboard.reply_markup,
      });
    } catch (err) {
      logError("lk_cand_decline_reason", err);
    }
  });

  bot.action(/^lk_cand_decline_cancel_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      declineReasonStates.delete(ctx.from.id);

      const candidateId = Number(ctx.match[1]);
      await showCandidateCardLk(ctx, candidateId, { edit: true });
    } catch (err) {
      logError("lk_cand_decline_cancel", err);
    }
  });

  async function applyCandidateDecline(ctx, candidateId, reason, adminDbId) {
    // 1) Обновляем кандидата (фиксируем отказ)
    await pool.query(
      `
      UPDATE candidates
         SET status = 'rejected',
             decline_reason = $2,
             declined_at = NOW(),
             is_deferred = false,
             closed_from_status = status,
             closed_by_admin_id = $3
       WHERE id = $1
    `,
      [candidateId, reason, adminDbId || null]
    );

    // 2) Пытаемся уведомить кандидата (ТОЛЬКО если есть привязанный user с telegram_id)
    try {
      const uRes = await pool.query(
        `
        SELECT telegram_id
        FROM users
        WHERE candidate_id = $1
          AND telegram_id IS NOT NULL
        ORDER BY id DESC
        LIMIT 1
      `,
        [candidateId]
      );

      const candidateTelegramId = uRes.rows[0]?.telegram_id;

      if (candidateTelegramId) {
        const text =
          "❌ К сожалению, мы не готовы продолжить с вами сотрудничество.\n\n" +
          "Спасибо, что нашли время!";

        await ctx.telegram
          .sendMessage(candidateTelegramId, text)
          .catch(() => {});
      }
    } catch (err) {
      // не валим бота, просто логируем
      console.error("[applyCandidateDecline] notify candidate error", err);
    }

    // 3) Возвращаем карточку админу
    await showCandidateCardLk(ctx, candidateId, { edit: true });
  }

  bot.action(/^lk_cand_decline_apply_(\d+)_no_show$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    declineReasonStates.delete(ctx.from.id);
    const admin = await ensureUser(ctx);
    if (!admin || (admin.role !== "admin" && admin.role !== "super_admin"))
      return;

    await applyCandidateDecline(
      ctx,
      Number(ctx.match[1]),
      "Не пришёл и не предупредил",
      admin.id
    );
  });

  bot.action(/^lk_cand_decline_apply_(\d+)_warned$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    declineReasonStates.delete(ctx.from.id);
    const admin = await ensureUser(ctx);
    if (!admin || (admin.role !== "admin" && admin.role !== "super_admin"))
      return;

    await applyCandidateDecline(
      ctx,
      Number(ctx.match[1]),
      "Предупредил, что не придёт",
      admin.id
    );
  });

  bot.action(/^lk_cand_decline_apply_(\d+)_weird$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    declineReasonStates.delete(ctx.from.id);
    const admin = await ensureUser(ctx);
    if (!admin || (admin.role !== "admin" && admin.role !== "super_admin"))
      return;

    await applyCandidateDecline(
      ctx,
      Number(ctx.match[1]),
      "Странное поведение",
      admin.id
    );
  });
  // ================================
  // ВОССТАНОВЛЕНИЕ КАНДИДАТА
  // ================================
  bot.action(/^lk_cand_restore_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin"))
        return;

      const candidateId = Number(ctx.match[1]);
      restoreModeStates.set(ctx.from.id, candidateId);

      await showCandidateCardLk(ctx, candidateId, {
        edit: true,
        restoreMode: true,
      });
    } catch (err) {
      logError("lk_cand_restore", err);
    }
  });

  bot.action(/^lk_cand_restore_cancel_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      restoreModeStates.delete(ctx.from.id);

      const candidateId = Number(ctx.match[1]);
      await showCandidateCardLk(ctx, candidateId, { edit: true });
    } catch (err) {
      logError("lk_cand_restore_cancel", err);
    }
  });

  bot.action(/^lk_cand_restore_apply_(\d+)$/, async (ctx) => {
    const admin = await ensureUser(ctx);
    if (!admin || (admin.role !== "admin" && admin.role !== "super_admin"))
      return;
    try {
      await ctx.answerCbQuery().catch(() => {});
      const candidateId = Number(ctx.match[1]);

      // берём состояние ДО апдейта
      const { rows } = await pool.query(
        "SELECT id, closed_from_status FROM candidates WHERE id = $1",
        [candidateId]
      );
      const cand = rows[0];
      if (!cand) return;

      const restoredStatus = cand.closed_from_status || "invited";

      await pool.query(
        `
      UPDATE candidates
         SET status = COALESCE(closed_from_status, 'invited'),
             closed_from_status = NULL,
             decline_reason = NULL,
             declined_at = NULL,
             is_deferred = false,
             closed_by_admin_id = NULL
       WHERE id = $1
      `,
        [candidateId]
      );

      restoreModeStates.delete(ctx.from.id);

      await showCandidateCardLk(ctx, candidateId, { edit: true });

      // ✅ Уведомление кандидату — только если НЕ interviewed
      if (restoredStatus !== "interviewed") {
        const uRes = await pool.query(
          `
  SELECT telegram_id
  FROM users
  WHERE candidate_id = $1
    AND telegram_id IS NOT NULL
  ORDER BY id DESC
  LIMIT 1
  `,
          [candidateId]
        );

        const tgId = uRes.rows[0]?.telegram_id;
        if (tgId) {
          await notifyCandidateAfterRestore(
            { candidateId, restoredStatus, candidateTelegramId: tgId },
            ctx
          );
        }
      }
    } catch (err) {
      logError("lk_cand_restore_apply", err);
    }
  });

  async function notifyCandidateAfterRestore(payload, ctx) {
    const { candidateId, restoredStatus, candidateTelegramId } = payload;

    // 1) Для interviewed — НЕ отправляем ничего
    if (restoredStatus === "interviewed") return;

    // -------------------------
    // helpers
    // -------------------------
    function formatDateRu(date) {
      if (!date) return "не указана";
      const d = new Date(date);
      if (Number.isNaN(d.getTime())) return "не указана";
      const dd = String(d.getDate()).padStart(2, "0");
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const weekday = d.toLocaleDateString("ru-RU", { weekday: "short" });
      return `${dd}.${mm} (${weekday})`;
    }

    function escapeHtml(s) {
      return String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    }

    function normalizePhone(raw) {
      if (!raw) return { display: null, href: null };
      const src = String(raw);
      let digits = src.replace(/\D+/g, "");
      if (digits.length === 11 && digits.startsWith("8")) {
        digits = "7" + digits.slice(1);
      }
      if (digits.length === 11 && digits.startsWith("7")) {
        const v = "+" + digits;
        return { display: v, href: v };
      }
      if (digits.length >= 10) {
        const v = "+" + digits;
        return { display: v, href: v };
      }
      return { display: src.trim(), href: null };
    }

    // -------------------------
    // 2) invited -> полное приглашение на собеседование
    // -------------------------
    if (restoredStatus === "invited") {
      const res = await pool.query(
        `
        SELECT
          c.id,
          c.name,
          c.age,
          c.interview_date,
          c.interview_time,
          tp.title      AS point_title,
          tp.address    AS point_address,
          tp.landmark   AS point_landmark,
          a.full_name   AS admin_name,
          a.position    AS admin_position,
          a.telegram_id AS admin_telegram_id,
          a.work_phone  AS admin_work_phone
        FROM candidates c
        LEFT JOIN trade_points tp ON tp.id = c.point_id
        LEFT JOIN users a         ON a.id = c.admin_id
        WHERE c.id = $1
      `,
        [candidateId]
      );

      const c = res.rows[0];
      if (!c) return;

      const greetingName = c.name || "Вы";
      const dateStr = formatDateRu(c.interview_date);
      const timeStr = c.interview_time || "не указано";
      const pointAddress = c.point_address || "будет добавлен позже";

      const adminName = c.admin_name || "не указан";
      const adminPosition = c.admin_position || "не указана должность";
      const responsibleLine = `Ответственный: ${adminName}, ${adminPosition}`;

      const phone = normalizePhone(c.admin_work_phone);

      let text =
        `${greetingName}, вы приглашены на собеседование в Green Rocket! 🚀\n\n` +
        "📄 Детали собеседования:\n" +
        `• Дата: ${dateStr}\n` +
        `• Время: ${timeStr}\n` +
        `• Адрес: ${pointAddress}\n` +
        `• ${responsibleLine}\n`;

      if (phone.display) {
        text += `• Телефон для связи: ${phone.display}\n`;
      }

      const keyboardRows = [];

      // Telegram ответственного
      if (c.admin_telegram_id) {
        const firstName = (adminName || "Telegram").split(" ")[0] || "Telegram";
        keyboardRows.push([
          {
            text: `✈️ Telegram ${firstName}`,
            url: `tg://user?id=${c.admin_telegram_id}`,
          },
        ]);
      }

      // Как пройти?
      keyboardRows.push([
        { text: "🧭 Как пройти?", callback_data: "lk_interview_route" },
      ]);

      // Отказаться
      keyboardRows.push([
        {
          text: "❌ Отказаться от собеседования",
          callback_data: "lk_interview_decline",
        },
      ]);

      // 2.1) сообщение кандидату
      await ctx.telegram
        .sendMessage(candidateTelegramId, text, {
          reply_markup: { inline_keyboard: keyboardRows },
        })
        .catch(() => {});

      // 2.2) короткое уведомление ответственному (оставляем как “как в приглашениях”)
      if (c.admin_telegram_id) {
        try {
          const adminTextLines = [];
          adminTextLines.push("♻️ *Восстановление кандидата (собеседование)*");
          adminTextLines.push("");
          adminTextLines.push(
            `• Кандидат: ${c.name || "без имени"}${c.age ? ` (${c.age})` : ""}`
          );
          adminTextLines.push(`• Дата: ${dateStr}`);
          adminTextLines.push(`• Время: ${timeStr}`);

          const adminKeyboard = {
            inline_keyboard: [
              [
                {
                  text: "👤 Открыть кандидата",
                  callback_data: `lk_cand_open_${candidateId}`,
                },
              ],
              [
                {
                  text: "📋 Мои собеседования",
                  callback_data: "lk_admin_my_interviews",
                },
              ],
            ],
          };

          await ctx.telegram.sendMessage(
            c.admin_telegram_id,
            adminTextLines.join("\n"),
            {
              parse_mode: "Markdown",
              reply_markup: adminKeyboard,
            }
          );
        } catch (err) {
          console.error(
            "[notifyCandidateAfterRestore] notify admin error",
            err
          );
        }
      }

      return;
    }

    // -------------------------
    // 3) internship_invited -> полное приглашение на стажировку + уведомление наставнику
    // -------------------------
    if (restoredStatus === "internship_invited") {
      const cRes = await pool.query(
        `
        SELECT
          c.id,
          c.name,
          c.age,
          c.internship_date,
          c.internship_time_from,
          c.internship_time_to,
          COALESCE(tp.title, 'не указана') AS point_title,
          COALESCE(tp.address, '') AS point_address,
          COALESCE(tp.landmark, '') AS point_landmark,
          COALESCE(u.full_name, 'не указан') AS mentor_name,
          u.position    AS mentor_position,
          u.telegram_id AS mentor_telegram_id,
          u.work_phone  AS mentor_work_phone
        FROM candidates c
        LEFT JOIN trade_points tp ON tp.id = c.internship_point_id
        LEFT JOIN users u ON u.id = c.internship_admin_id
        WHERE c.id = $1
      `,
        [candidateId]
      );

      const c = cRes.rows[0];
      if (!c) return;

      const datePart = formatDateRu(c.internship_date);
      const timeFromText = c.internship_time_from || "не указано";
      const timeToText = c.internship_time_to || "не указано";

      const pointTitle = c.point_title || "не указана";
      const pointAddress = c.point_address || "будет добавлен позже";
      const mentorName = c.mentor_name || "не указан";

      const phone = normalizePhone(c.mentor_work_phone);

      const nameForText = c.name || "Вы";

      let text =
        `${escapeHtml(
          nameForText
        )}, вы приглашены на стажировку в Green Rocket! 🚀\n\n` +
        `<b>📄 Детали стажировки</b>\n` +
        `• <b>Дата:</b> ${escapeHtml(datePart)}\n` +
        `• <b>Время:</b> с ${escapeHtml(timeFromText)} до ${escapeHtml(
          timeToText
        )}\n` +
        `• <b>Адрес:</b> ${escapeHtml(pointAddress)}\n` +
        `• <b>Наставник:</b> ${escapeHtml(mentorName)}\n`;

      if (phone.display) {
        if (phone.href) {
          text += `• <b>Телефон для связи:</b> <a href="tel:${escapeHtml(
            phone.href
          )}">${escapeHtml(phone.display)}</a>\n`;
        } else {
          text += `• <b>Телефон для связи:</b> ${escapeHtml(phone.display)}\n`;
        }
      }

      const keyboardRows = [];

      // Telegram наставника
      if (c.mentor_telegram_id) {
        const firstName =
          (mentorName || "Telegram").split(" ")[0] || "Telegram";
        keyboardRows.push([
          {
            text: `✈️ Telegram ${firstName}`,
            url: `tg://user?id=${c.mentor_telegram_id}`,
          },
        ]);
      }

      // Как пройти? + По оплате
      keyboardRows.push([
        { text: "🧭 Как пройти?", callback_data: "lk_internship_route" },
        { text: "💰 По оплате", callback_data: "lk_internship_payment" },
      ]);

      // Отказаться
      keyboardRows.push([
        {
          text: "❌ Отказаться от стажировки",
          callback_data: "lk_internship_decline",
        },
      ]);

      // 3.1) сообщение кандидату (HTML)
      await ctx.telegram
        .sendMessage(candidateTelegramId, text, {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: keyboardRows },
        })
        .catch(() => {});

      // 3.2) уведомление наставнику
      if (c.mentor_telegram_id) {
        try {
          const mentorTextLines = [];
          mentorTextLines.push("♻️ *Восстановление кандидата (стажировка)*");
          mentorTextLines.push("");
          mentorTextLines.push(
            `• Кандидат: ${c.name || "без имени"}${c.age ? ` (${c.age})` : ""}`
          );
          mentorTextLines.push(`• Дата: ${datePart}`);
          mentorTextLines.push(`• Время: с ${timeFromText} до ${timeToText}`);
          mentorTextLines.push(`• Точка: ${pointTitle}`);
          if (pointAddress) mentorTextLines.push(`• Адрес: ${pointAddress}`);

          const mentorKeyboard = {
            inline_keyboard: [
              [
                {
                  text: "👤 Открыть кандидата",
                  callback_data: `lk_cand_open_${candidateId}`,
                },
              ],
              [
                {
                  text: "📋 Мои стажировки",
                  callback_data: "lk_admin_my_internships",
                },
              ],
            ],
          };

          await ctx.telegram.sendMessage(
            c.mentor_telegram_id,
            mentorTextLines.join("\n"),
            {
              parse_mode: "Markdown",
              reply_markup: mentorKeyboard,
            }
          );
        } catch (err) {
          console.error(
            "[notifyCandidateAfterRestore] notify mentor error",
            err
          );
        }
      }

      return;
    }

    // остальные статусы пока игнорируем
  }
}

module.exports = {
  showCandidatesListLk,
  registerCandidateListHandlers,
};
