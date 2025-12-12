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

const declineReasonStates = new Map(); // key: tgId, value: { candidateId }

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

  if (filters.filtersExpanded) {
    rows.push([
      Markup.button.callback("🔄 Сбросить фильтры", "lk_cand_filter_reset"),
      Markup.button.callback("⬆️ Скрыть фильтр", "lk_cand_filter_toggle"),
    ]);

    rows.push([
      Markup.button.callback(
        (filters.cancelled ? "✅ " : "⚪ ") + "Отменённые",
        "lk_cand_filter_status_cancelled"
      ),
    ]);
    rows.push([
      Markup.button.callback(
        (filters.internshipInvited ? "✅ " : "⚪ ") +
          "Приглашены на стажировку",
        "lk_cand_filter_status_internship"
      ),
    ]);
    rows.push([
      Markup.button.callback(
        (filters.arrived ? "✅ " : "⚪ ") + "Собеседование проведено",
        "lk_cand_filter_status_arrived"
      ),
    ]);
    rows.push([
      Markup.button.callback(
        (filters.waiting ? "✅ " : "⚪ ") + "Ожидают собеседование",
        "lk_cand_filter_status_waiting"
      ),
    ]);
    rows.push([
      Markup.button.callback(
        filters.scope === "personal" ? "✅ Личные" : "Личные",
        "lk_cand_filter_scope_personal"
      ),
      Markup.button.callback(
        filters.scope === "all" ? "✅ Все" : "Все",
        "lk_cand_filter_scope_all"
      ),
    ]);

    rows.push([Markup.button.callback("⬅️ Назад", "lk_admin_menu")]);
  } else if (filters.historyExpanded) {
    rows.push([
      Markup.button.callback("🔼 скрыть 🔼", "lk_cand_toggle_history"),
    ]);
    rows.push([
      Markup.button.callback("📜 история кандидатов", "lk_cand_history"),
    ]);
    rows.push([Markup.button.callback("⬅️ Назад", "lk_admin_menu")]);
  } else {
    rows.push([
      Markup.button.callback("✅ Кандидаты", "admin_users_candidates"),
      Markup.button.callback("Стажёры", "admin_users_interns"),
      Markup.button.callback("Сотрудники", "admin_users_workers"),
    ]);

    rows.push([
      Markup.button.callback("+ добавить", "lk_cand_create_start"),
      Markup.button.callback("+ добавить", "lk_add_intern"),
      Markup.button.callback("+ добавить", "lk_add_worker"),
    ]);

    rows.push([
      Markup.button.callback("🔽 Фильтр 🔽", "lk_cand_filter_toggle"),
      Markup.button.callback("🔽 раскрыть 🔽", "lk_cand_toggle_history"),
    ]);

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

      await applyCandidateDecline(ctx, st.candidateId, reason);
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
      setCandidateFilters(tgId, {
        historyExpanded: !filters.historyExpanded,
        filtersExpanded: false,
      });

      await showCandidatesListLk(ctx, user, { edit: true });
    } catch (err) {
      logError("lk_cand_toggle_history", err);
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

  // Заглушка для истории
  bot.action("lk_cand_history", async (ctx) => {
    try {
      await ctx
        .answerCbQuery("История кандидатов пока в разработке.")
        .catch(() => {});
    } catch (err) {
      logError("lk_cand_history", err);
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
      const candidateId = Number(ctx.match[1]);

      await showCandidateCardLk(ctx, candidateId, { edit: true });
    } catch (err) {
      logError("lk_cand_decline_cancel", err);
    }
  });

  async function applyCandidateDecline(ctx, candidateId, reason) {
    await pool.query(
      `
      UPDATE candidates
         SET status = 'rejected',
             decline_reason = $2,
             closed_from_status = status,
             declined_at = NOW()
       WHERE id = $1
    `,
      [candidateId, reason]
    );

    await showCandidateCardLk(ctx, candidateId, { edit: true });
  }

  bot.action(/^lk_cand_decline_apply_(\d+)_no_show$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    declineReasonStates.delete(ctx.from.id);

    await applyCandidateDecline(
      ctx,
      Number(ctx.match[1]),
      "Не пришёл и не предупредил"
    );
  });

  bot.action(/^lk_cand_decline_apply_(\d+)_warned$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    declineReasonStates.delete(ctx.from.id);

    await applyCandidateDecline(
      ctx,
      Number(ctx.match[1]),
      "Предупредил, что не придёт"
    );
  });

  bot.action(/^lk_cand_decline_apply_(\d+)_weird$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    declineReasonStates.delete(ctx.from.id);

    await applyCandidateDecline(
      ctx,
      Number(ctx.match[1]),
      "Странное поведение"
    );
  });
  // ================================
  // ВОССТАНОВЛЕНИЕ КАНДИДАТА
  // ================================
  bot.action(/^lk_cand_restore_confirm_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const candidateId = Number(ctx.match[1]);

      const text =
        "Вы уверены, что хотите восстановить кандидата?\n\n" +
        "Кандидат вернётся в статус до отказа.";

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "✅ Да, восстановить",
            `lk_cand_restore_yes_${candidateId}`
          ),
        ],
        [
          Markup.button.callback(
            "⬅️ Отмена",
            `lk_cand_restore_cancel_${candidateId}`
          ),
        ],
      ]);

      await ctx.editMessageText(text, keyboard);
    } catch (err) {
      logError("lk_cand_restore_confirm", err);
    }
  });

  bot.action(/^lk_cand_restore_cancel_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const candidateId = Number(ctx.match[1]);
      await showCandidateCardLk(ctx, candidateId, { edit: true });
    } catch (err) {
      logError("lk_cand_restore_cancel", err);
    }
  });

  bot.action(/^lk_cand_restore_yes_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const candidateId = Number(ctx.match[1]);

      // Возвращаем в статус до отказа (если он сохранён), иначе invited
      await pool.query(
        `
      UPDATE candidates
         SET status = COALESCE(closed_from_status, 'invited'),
             decline_reason = NULL,
             declined_at = NULL,
             closed_from_status = NULL
       WHERE id = $1
      `,
        [candidateId]
      );

      await showCandidateCardLk(ctx, candidateId, { edit: true });
    } catch (err) {
      logError("lk_cand_restore_yes", err);
    }
  });
}

module.exports = {
  showCandidatesListLk,
  registerCandidateListHandlers,
};
