// src/bot/admin/users/candidateCreate.js

const { Markup } = require("telegraf");
const pool = require("../../../db/pool");
const { showCandidatesListLk } = require("./candidateList");
const { showCandidateCardLk } = require("./candidateCard");

// Храним состояние сценария по tg_id
const candidateCreateStates = new Map();

function getState(tgId) {
  return candidateCreateStates.get(tgId) || null;
}
function setState(tgId, state) {
  candidateCreateStates.set(tgId, state);
}
function clearState(tgId) {
  candidateCreateStates.delete(tgId);
}
// ---------------------
// ХЕЛПЕРЫ ДЛЯ ПРИВЯЗКИ К ПОЛЬЗОВАТЕЛЮ ЛК
// ---------------------

function formatDateRu(date) {
  if (!date) return "не указана";

  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "не указана";

  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const weekday = d.toLocaleDateString("ru-RU", { weekday: "short" });

  return `${dd}.${mm} (${weekday})`;
}

/**
 * Показываем список пользователей из lk_waiting_users,
 * чтобы привязать к этому кандидату (для уведомления о СОБЕСЕДОВАНИИ).
 */
async function showLinkUserForInterview(ctx, candidateId) {
  const res = await pool.query(
    `
      SELECT id, full_name, age, phone, created_at
        FROM lk_waiting_users
       WHERE linked_user_id IS NULL
       ORDER BY created_at DESC
       LIMIT 20
    `
  );

  const users = res.rows;

  const intro =
    "👥 Теперь нужно связать кандидата с пользователем ЛК.\n\n" +
    "Это нужно, чтобы этому человеку пришло уведомление о собеседовании.\n\n";

  if (!users.length) {
    await ctx.reply(
      intro +
        "Сейчас нет пользователей в режиме ожидания.\n" +
        "Привязку можно будет сделать позже из карточки кандидата."
    );

    // сразу показываем карточку, раз привязки сейчас не будет
    await showCandidateCardLk(ctx, candidateId, { edit: false });
    return;
  }

  let text =
    intro + "Выберите пользователя, которого привязываем к собеседованию:\n\n";

  const buttons = users.map((u) => {
    const created = u.created_at
      ? new Date(u.created_at).toLocaleDateString("ru-RU", {
          day: "2-digit",
          month: "2-digit",
        })
      : "";
    const agePart = u.age ? ` (${u.age})` : "";
    const phonePart = u.phone ? ` ${u.phone}` : "";
    const label = `${created} ${
      u.full_name || "Без имени"
    }${agePart}${phonePart}`;
    return [
      Markup.button.callback(
        label,
        `lk_cand_linkuser_select_${candidateId}_${u.id}`
      ),
    ];
  });

  buttons.push([
    Markup.button.callback(
      "⏳ Привяжу позже",
      `lk_cand_linkuser_later_${candidateId}`
    ),
  ]);

  const keyboard = Markup.inlineKeyboard(buttons);

  await ctx.reply(text, keyboard);
}

/**
 * Отправляем приглашение на СОБЕСЕДОВАНИЕ пользователю ЛК.
 */
// Отправляем приглашение на СОБЕСЕДОВАНИЕ пользователю ЛК.
// Приглашение на СОБЕСЕДОВАНИЕ пользователю ЛК
async function sendInterviewInvitation(telegram, chatId, candidateId) {
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
        a.username    AS admin_username,
        a.work_phone  AS admin_work_phone
      FROM candidates c
      LEFT JOIN trade_points tp ON tp.id = c.point_id
      LEFT JOIN users a         ON a.id = c.admin_id
      WHERE c.id = $1
    `,
    [candidateId]
  );

  if (!res.rows.length) {
    return;
  }

  const c = res.rows[0];

  const dateStr = formatDateRu(c.interview_date);
  const timeStr = c.interview_time || "не указано";

  const pointTitle = c.point_title || "не указана";
  const pointAddress = c.point_address || "будет добавлен позже";
  const pointLandmark = c.point_landmark || "будет добавлен позже";

  const adminName = c.admin_name || "не указан";
  const adminPosition = c.admin_position || "не указана должность";

  // username нам тут больше не нужен в тексте, только для кнопки (ниже)
  const responsibleLine = `Ответственный: ${adminName}, ${adminPosition}`;

  // Подготовим телефон для отображения в кликабельном формате
  let phoneDisplay = null;
  if (c.admin_work_phone) {
    const raw = String(c.admin_work_phone);
    let digits = raw.replace(/\D+/g, "");

    // Простейшая нормализация под РФ: 8XXXXXXXXXXX -> +7XXXXXXXXXXX
    if (digits.length === 11 && digits.startsWith("8")) {
      digits = "7" + digits.slice(1);
    }

    if (digits.length === 11 && digits.startsWith("7")) {
      phoneDisplay = "+" + digits;
    } else if (digits.length >= 10) {
      phoneDisplay = "+" + digits;
    } else {
      phoneDisplay = raw.trim(); // fallback
    }
  }

  const greetingName = c.name || "Вы";

  let text =
    `${greetingName}, вы приглашены на собеседование в Green Rocket! 🚀\n\n` +
    "📄 Детали собеседования:\n" +
    `• Дата: ${dateStr}\n` +
    `• Время: ${timeStr}\n` +
    `• Адрес: ${pointAddress}\n` +
    `• ${responsibleLine}\n`;

  if (phoneDisplay) {
    text += `• Телефон для связи: ${phoneDisplay}\n`;
  }

  const buttons = [];

  // Кнопка "✈️ Telegram Имя" — ссылка на аккаунт ответственного
  if (c.admin_telegram_id) {
    const firstName = adminName.split(" ")[0] || adminName || "Telegram";
    buttons.push([
      Markup.button.url(
        `✈️ Telegram ${firstName}`,
        `tg://user?id=${c.admin_telegram_id}`
      ),
    ]);
  }

  // Кнопка "🧭 Как пройти?"
  buttons.push([
    Markup.button.callback("🧭 Как пройти?", "lk_interview_route"),
  ]);

  // Кнопка "Отказаться"
  buttons.push([
    Markup.button.callback(
      "❌ Отказаться от собеседования",
      "lk_interview_decline"
    ),
  ]);

  const keyboard = Markup.inlineKeyboard(buttons);

  // 1) Сообщение кандидату
  await telegram.sendMessage(chatId, text, {
    reply_markup: keyboard.reply_markup,
  });

  // 2) Короткое уведомление ответственному
  if (c.admin_telegram_id) {
    try {
      const adminTextLines = [];

      adminTextLines.push("🕒 *Новое запланированное собеседование*");
      adminTextLines.push("");
      adminTextLines.push(
        `• Кандидат: ${c.name || "без имени"}${c.age ? ` (${c.age})` : ""}`
      );
      adminTextLines.push(`• Дата: ${dateStr}`);
      adminTextLines.push(`• Время: ${timeStr}`);
      adminTextLines.push(`• Точка: ${pointTitle}`);
      if (pointAddress) {
        adminTextLines.push(`• Адрес: ${pointAddress}`);
      }

      const adminText = adminTextLines.join("\n");

      const adminKeyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "👤 Открыть кандидата",
            `lk_cand_open_${c.id}`
          ),
        ],
        [
          Markup.button.callback(
            "📋 Мои собеседования",
            "lk_admin_my_interviews"
          ),
        ],
      ]);

      await telegram.sendMessage(c.admin_telegram_id, adminText, {
        reply_markup: adminKeyboard.reply_markup,
        parse_mode: "Markdown",
      });
    } catch (err) {
      console.error("[sendInterviewInvitation] notify admin error", err);
    }
  }
}

// --- утилиты парсинга даты/времени ---

const WEEK_DAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

function parseDateToISO(input) {
  if (!input) return null;
  const text = input.trim().toLowerCase();

  const m = text.match(/^(\d{1,2})[.\-/](\d{1,2})(?:[.\-/](\d{2,4}))?$/);
  if (!m) return null;

  let day = parseInt(m[1], 10);
  let month = parseInt(m[2], 10);
  let year = m[3] ? parseInt(m[3], 10) : new Date().getFullYear();

  if (year < 100) year += 2000;
  if (month < 1 || month > 12) return null;
  if (day < 1 || day > 31) return null;

  const d = new Date(year, month - 1, day);
  if (Number.isNaN(d.getTime())) return null;

  const dd = String(day).padStart(2, "0");
  const mm = String(month).padStart(2, "0");
  return `${year}-${mm}-${dd}`;
}

function parseTime(input) {
  if (!input) return null;
  const m = input.trim().match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

function formatDateWithWeekday(isoDate, timeStr) {
  if (!isoDate && !timeStr) return "не указана";

  let datePart = "";
  let weekdayPart = "";

  if (isoDate) {
    const [year, month, day] = isoDate.split("-").map((x) => parseInt(x, 10));
    if (
      Number.isFinite(year) &&
      Number.isFinite(month) &&
      Number.isFinite(day)
    ) {
      const d = new Date(year, month - 1, day);
      if (!Number.isNaN(d.getTime())) {
        const dd = String(d.getDate()).padStart(2, "0");
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        datePart = `${dd}.${mm}`;
        weekdayPart = WEEK_DAYS[d.getDay()];
      }
    }
  }

  if (!datePart && !timeStr) return "не указана";

  let result = "";
  if (datePart) result += datePart;
  if (timeStr) result += (result ? " в " : "") + timeStr;
  if (weekdayPart) result += ` (${weekdayPart})`;
  return result || "не указана";
}

// --- Шаги опроса (сообщения) ---

function canEdit(ctx, edit) {
  return edit && ctx.updateType === "callback_query";
}

async function stepAskName(ctx, edit = false) {
  const text = "👤 Введи имя кандидата одним сообщением:";
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("⬅️ Отмена", "lk_cand_create_cancel")],
  ]);

  if (canEdit(ctx, edit)) {
    await ctx.editMessageText(text, keyboard);
  } else {
    await ctx.reply(text, keyboard);
  }
}

async function stepAskAge(ctx, edit = false) {
  const text =
    "🎂 Укажите возраст кандидата числом.\n" +
    "Если возраст неизвестен — нажмите «ℹ️ не указано».";
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("ℹ️ не указано", "lk_cand_age_not_specified")],
    [Markup.button.callback("⬅️ Отмена", "lk_cand_create_cancel")],
  ]);

  if (canEdit(ctx, edit)) {
    await ctx.editMessageText(text, keyboard);
  } else {
    await ctx.reply(text, keyboard);
  }
}

async function stepAskPhone(ctx, edit = false) {
  const text = "📞 Введи контактный телефон кандидата:";
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("⬅️ Отмена", "lk_cand_create_cancel")],
  ]);

  if (canEdit(ctx, edit)) {
    await ctx.editMessageText(text, keyboard);
  } else {
    await ctx.reply(text, keyboard);
  }
}

async function stepAskPlacePoint(ctx, edit = false) {
  const res = await pool.query(
    "SELECT id, title FROM trade_points WHERE is_active = TRUE ORDER BY id"
  );
  if (!res.rows.length) {
    await ctx.reply(
      "Нет доступных торговых точек. Добавь точку в настройках и попробуй снова."
    );
    return;
  }

  const rows = res.rows.map((row) => [
    Markup.button.callback(row.title, `lk_cand_place_point_${row.id}`),
  ]);

  rows.push([Markup.button.callback("⬅️ Отмена", "lk_cand_create_cancel")]);

  const text = "📍 Выберите место собеседования (торговую точку):";
  const keyboard = Markup.inlineKeyboard(rows);

  if (canEdit(ctx, edit)) {
    await ctx.editMessageText(text, keyboard);
  } else {
    await ctx.reply(text, keyboard);
  }
}

async function stepAskDesiredPoints(ctx, tgId, edit = false) {
  const state = getState(tgId);
  if (!state) return;

  const res = await pool.query(
    "SELECT id, title FROM trade_points WHERE is_active = TRUE ORDER BY id"
  );
  if (!res.rows.length) {
    await ctx.reply(
      "Нет доступных торговых точек. Добавь точку в настройках и попробуй снова."
    );
    return;
  }

  const selectedIds = new Set(state.data.desiredPointIds || []);

  const rows = res.rows.map((row) => {
    const selected = selectedIds.has(row.id);
    const label = selected ? `✅ ${row.title}` : row.title;
    return [Markup.button.callback(label, `lk_cand_desired_toggle_${row.id}`)];
  });

  rows.push([
    Markup.button.callback("ℹ️ не указано", "lk_cand_desired_not_specified"),
  ]);
  rows.push([Markup.button.callback("➡️ дальше", "lk_cand_desired_next")]);
  rows.push([Markup.button.callback("⬅️ Отмена", "lk_cand_create_cancel")]);

  const text =
    "📌 Выберите желаемую точку для кандидата.\n" +
    "Если желаемая точка не указана — нажмите «ℹ️ не указано».\n\n" +
    "Можно выбрать несколько точек, затем нажать «➡️ дальше».";
  const keyboard = Markup.inlineKeyboard(rows);

  if (canEdit(ctx, edit)) {
    await ctx.editMessageText(text, keyboard);
  } else {
    await ctx.reply(text, keyboard);
  }
}

function buildSalaryKeyboard(state) {
  const period = state?.data?.salaryPeriod || "month";
  const monthActive = period === "month";
  const dayActive = period === "day";

  const monthLabel = monthActive ? "✅ в месяц" : "в месяц";
  const dayLabel = dayActive ? "✅ в день" : "в день";

  return Markup.inlineKeyboard([
    [
      Markup.button.callback(monthLabel, "lk_cand_salary_period_month"),
      Markup.button.callback(dayLabel, "lk_cand_salary_period_day"),
    ],
    [Markup.button.callback("ℹ️ Не указано", "lk_cand_salary_not_specified")],
    [Markup.button.callback("⬅️ Отмена", "lk_cand_create_cancel")],
  ]);
}

async function stepAskSalary(ctx, tgId, edit = false) {
  const state = getState(tgId);
  if (!state) return;

  const keyboard = buildSalaryKeyboard(state);
  const text =
    "💰 Укажи желаемую зарплату кандидата.\n\n" +
    "Отправь сумму одним сообщением, например: 60000";

  if (canEdit(ctx, edit)) {
    await ctx.editMessageText(text, keyboard);
  } else {
    await ctx.reply(text, keyboard);
  }
}

async function stepAskSchedule(ctx, edit = false) {
  const text =
    "⌛ Выберите желаемый график работы кандидата.\n\n" +
    "Если нет подходящего варианта — введите его текстом.\n" +
    "Если график не указан, нажмите «ℹ️ не указано».";
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback("2/2", "lk_cand_schedule_2_2"),
      Markup.button.callback("3/3", "lk_cand_schedule_3_3"),
      Markup.button.callback("5/2", "lk_cand_schedule_5_2"),
    ],
    [Markup.button.callback("ℹ️ не указано", "lk_cand_schedule_not_spec")],
    [Markup.button.callback("⬅️ Отмена", "lk_cand_create_cancel")],
  ]);

  if (canEdit(ctx, edit)) {
    await ctx.editMessageText(text, keyboard);
  } else {
    await ctx.reply(text, keyboard);
  }
}

async function stepAskExperience(ctx, edit = false) {
  const text =
    "📝 Отправьте краткое описание предыдущего опыта работы кандидата.\n" +
    "Если опыта нет или он не важен — нажмите «ℹ️ не указано».";
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("ℹ️ не указано", "lk_cand_exp_not_spec")],
    [Markup.button.callback("⬅️ Отмена", "lk_cand_create_cancel")],
  ]);

  if (canEdit(ctx, edit)) {
    await ctx.editMessageText(text, keyboard);
  } else {
    await ctx.reply(text, keyboard);
  }
}

async function stepAskComment(ctx, edit = false) {
  const text =
    "💬 Напишите комментарий по кандидату (например, от кого рекомендация).\n" +
    "Если комментария нет — нажмите «ℹ️ не указано».";
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("ℹ️ не указано", "lk_cand_comment_not_spec")],
    [Markup.button.callback("⬅️ Отмена", "lk_cand_create_cancel")],
  ]);

  if (canEdit(ctx, edit)) {
    await ctx.editMessageText(text, keyboard);
  } else {
    await ctx.reply(text, keyboard);
  }
}

async function stepAskDate(ctx, edit = false) {
  const text =
    "📅 Укажите дату собеседования в формате ДД.ММ (например, 03.12).\n\n" +
    "Или выберите «сегодня» / «завтра» кнопками ниже.";
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback("сегодня", "lk_cand_date_today"),
      Markup.button.callback("завтра", "lk_cand_date_tomorrow"),
    ],
    [Markup.button.callback("⬅️ Отмена", "lk_cand_create_cancel")],
  ]);

  if (canEdit(ctx, edit)) {
    await ctx.editMessageText(text, keyboard);
  } else {
    await ctx.reply(text, keyboard);
  }
}

async function stepAskTime(ctx, edit = false) {
  const text =
    "⏰ Укажите время собеседования в формате ЧЧ:ММ (например, 12:30).\n" +
    "Если точное время пока неизвестно — напишите «не указано».";
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("⬅️ Отмена", "lk_cand_create_cancel")],
  ]);

  if (canEdit(ctx, edit)) {
    await ctx.editMessageText(text, keyboard);
  } else {
    await ctx.reply(text, keyboard);
  }
}

async function stepAskAdmin(ctx, edit = false) {
  const res = await pool.query(
    "SELECT id, full_name FROM users WHERE role IN ('admin','super_admin') ORDER BY full_name"
  );

  const rows = res.rows.map((row) => [
    Markup.button.callback(
      row.full_name ? `👤 ${row.full_name}` : `👤 Админ #${row.id}`,
      `lk_cand_admin_${row.id}`
    ),
  ]);

  rows.push([
    Markup.button.callback("⌛ Назначу позже", "lk_cand_admin_later"),
  ]);
  rows.push([Markup.button.callback("⬅️ Отмена", "lk_cand_create_cancel")]);

  const text =
    "👤 Выберите ответственного, который будет проводить собеседование.\n" +
    "Если решите позже — нажмите «⌛ Назначу позже».";
  const keyboard = Markup.inlineKeyboard(rows);

  if (canEdit(ctx, edit)) {
    await ctx.editMessageText(text, keyboard);
  } else {
    await ctx.reply(text, keyboard);
  }
}

// --- сохранение кандидата в БД ---

async function createCandidateFromState(ctx, user, adminIdOverride = null) {
  const tgId = ctx.from.id;
  const state = getState(tgId);
  if (!state) return null;

  const d = state.data;

  const desiredIds = d.desiredPointIds || [];
  const primaryDesiredId =
    desiredIds.length > 0 ? desiredIds[0] : d.desiredPointId || null;

  // Раньше тут в questionnaire подмешивались "Желаемые точки: ...".
  // Оставляем ТОЛЬКО текст, который реально ввёл пользователь.
  const questionnaire = d.experience || null;

  const salaryText =
    d.salaryAmount && d.salaryPeriod
      ? `${d.salaryAmount} ${d.salaryPeriod === "month" ? "в месяц" : "в день"}`
      : null;

  const adminId = adminIdOverride || d.responsibleAdminId || null;

  const result = await pool.query(
    `
      INSERT INTO candidates
        (name, age, phone, status, salary, schedule, questionnaire,
         interview_date, interview_time, comment, point_id, desired_point_id,
         admin_id)
      VALUES
        ($1, $2, $3, 'invited', $4, $5, $6,
         $7, $8, $9, $10, $11, $12)
      RETURNING id
    `,
    [
      d.name,
      d.age || null,
      d.phone || null,
      salaryText,
      d.schedule || null,
      questionnaire,
      d.interviewDateISO || null,
      d.interviewTime || null,
      d.comment || null,
      d.placePointId || null,
      primaryDesiredId,
      adminId,
    ]
  );

  const candidateId = result.rows[0]?.id;
  clearState(tgId);

  if (!candidateId) return null;
  return candidateId;
}

// --- основной регистратор ---

function registerCandidateCreate(bot, ensureUser, logError, deliver) {
  // Глобальный обработчик текстов для шагов сценария
  bot.on("text", async (ctx, next) => {
    try {
      const tgId = ctx.from.id;
      const state = getState(tgId);
      if (!state) return next();

      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        clearState(tgId);
        return next();
      }

      const text = (ctx.message.text || "").trim();

      // 1. Имя
      if (state.step === "name") {
        if (!text || text.length < 2) {
          await ctx.reply("Имя слишком короткое, попробуй ещё раз.");
          return;
        }
        state.data.name = text;
        state.step = "age";
        setState(tgId, state);
        await stepAskAge(ctx);
        return;
      }

      // 2. Возраст
      if (state.step === "age") {
        if (/^не указано$/i.test(text)) {
          state.data.age = null;
        } else {
          const age = parseInt(text, 10);
          if (!Number.isFinite(age) || age < 10 || age > 80) {
            await ctx.reply(
              "Возраст должен быть числом от 10 до 80 или напиши «не указано»."
            );
            return;
          }
          state.data.age = age;
        }
        state.step = "phone";
        setState(tgId, state);
        await stepAskPhone(ctx);
        return;
      }

      // 3. Телефон
      if (state.step === "phone") {
        if (!text || text.length < 5) {
          await ctx.reply("Телефон выглядит странно, попробуй ещё раз.");
          return;
        }
        state.data.phone = text;
        state.step = "place_point";
        setState(tgId, state);
        await stepAskPlacePoint(ctx);
        return;
      }

      // 6. Зарплата
      if (state.step === "salary") {
        if (/^не указано$/i.test(text)) {
          state.data.salaryAmount = null;
          state.data.salaryPeriod = null;
          state.step = "schedule";
          setState(tgId, state);
          await stepAskSchedule(ctx);
          return;
        }

        const amount = parseInt(text.replace(/\s+/g, ""), 10);
        if (!Number.isFinite(amount) || amount <= 0) {
          await ctx.reply(
            "Не понял сумму. Введи число, например: 60000, или напиши «не указано»."
          );
          return;
        }

        state.data.salaryAmount = amount;
        if (!state.data.salaryPeriod) state.data.salaryPeriod = "month";
        state.step = "schedule";
        setState(tgId, state);
        await stepAskSchedule(ctx);
        return;
      }

      // 7. График
      if (state.step === "schedule") {
        if (/^не указано$/i.test(text)) {
          state.data.schedule = null;
        } else {
          state.data.schedule = text;
        }
        state.step = "experience";
        setState(tgId, state);
        await stepAskExperience(ctx);
        return;
      }

      // 8. Опыт
      if (state.step === "experience") {
        if (!/^не указано$/i.test(text)) {
          state.data.experience = text;
        } else {
          state.data.experience = null;
        }
        state.step = "comment";
        setState(tgId, state);
        await stepAskComment(ctx);
        return;
      }

      // 9. Комментарий
      if (state.step === "comment") {
        if (!/^не указано$/i.test(text)) {
          state.data.comment = text;
        } else {
          state.data.comment = null;
        }
        state.step = "date";
        setState(tgId, state);
        await stepAskDate(ctx);
        return;
      }

      // 10. Дата
      if (state.step === "date") {
        const iso = parseDateToISO(text);
        if (!iso) {
          await ctx.reply(
            "Не понял дату. Введи в формате ДД.ММ или ДД.ММ.ГГГГ, например: 07.12."
          );
          return;
        }
        state.data.interviewDateISO = iso;
        state.step = "time";
        setState(tgId, state);
        await stepAskTime(ctx);
        return;
      }

      // 11. Время
      if (state.step === "time") {
        if (/^не указано$/i.test(text)) {
          state.data.interviewTime = null;
        } else {
          const t = parseTime(text);
          if (!t) {
            await ctx.reply(
              "Не понял время. Введи, пожалуйста, в формате ЧЧ:ММ, например 12:30, или «не указано»."
            );
            return;
          }
          state.data.interviewTime = t;
        }
        state.step = "admin";
        setState(tgId, state);
        await stepAskAdmin(ctx);
        return;
      }

      return next();
    } catch (err) {
      logError("lk_cand_create_text", err);
      return next();
    }
  });

  // Старт сценария — КНОПКА "➕ Добавить кандидата"
  bot.action("lk_cand_create_start", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin"))
        return;

      const tgId = ctx.from.id;
      setState(tgId, { step: "name", data: {} });

      await stepAskName(ctx, true);
    } catch (err) {
      logError("lk_cand_create_start", err);
    }
  });

  bot.action("lk_cand_create_cancel", async (ctx) => {
    try {
      // Показываем тост вместо отдельного сообщения
      await ctx
        .answerCbQuery("Создание кандидата отменено.", { show_alert: false })
        .catch(() => {});

      const tgId = ctx.from.id;
      clearState(tgId);

      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin"))
        return;

      // Просто показываем список кандидатов, без лишнего текста в чате
      await showCandidatesListLk(ctx, user, { edit: true });
    } catch (err) {
      logError("lk_cand_create_cancel", err);
    }
  });

  // Возраст "не указано"
  bot.action("lk_cand_age_not_specified", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const tgId = ctx.from.id;
      const state = getState(tgId);
      if (!state || state.step !== "age") return;

      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        clearState(tgId);
        return;
      }

      state.data.age = null;
      state.step = "phone";
      setState(tgId, state);
      await stepAskPhone(ctx, true);
    } catch (err) {
      logError("lk_cand_age_not_specified", err);
    }
  });

  // Место собеседования
  bot.action(/^lk_cand_place_point_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const tgId = ctx.from.id;
      const state = getState(tgId);
      if (!state || state.step !== "place_point") return;

      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        clearState(tgId);
        return;
      }

      const pointId = parseInt(ctx.match[1], 10);
      const res = await pool.query(
        "SELECT title FROM trade_points WHERE id = $1",
        [pointId]
      );
      const title = res.rows[0]?.title || `точка #${pointId}`;

      state.data.placePointId = pointId;
      state.data.placePointTitle = title;
      state.step = "desired_points";
      setState(tgId, state);

      await stepAskDesiredPoints(ctx, tgId, true);
    } catch (err) {
      logError("lk_cand_place_point", err);
    }
  });

  // Мультивыбор желаемых точек
  bot.action(/^lk_cand_desired_toggle_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const tgId = ctx.from.id;
      const state = getState(tgId);
      if (!state || state.step !== "desired_points") return;

      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        clearState(tgId);
        return;
      }

      const pointId = parseInt(ctx.match[1], 10);
      let ids = state.data.desiredPointIds || [];
      let titles = state.data.desiredPointTitles || [];

      const res = await pool.query(
        "SELECT title FROM trade_points WHERE id = $1",
        [pointId]
      );
      const title = res.rows[0]?.title || `точка #${pointId}`;

      if (ids.includes(pointId)) {
        ids = ids.filter((id) => id !== pointId);
        titles = titles.filter((t) => t !== title);
      } else {
        ids.push(pointId);
        titles.push(title);
      }

      state.data.desiredPointIds = ids;
      state.data.desiredPointTitles = titles;
      setState(tgId, state);

      await stepAskDesiredPoints(ctx, tgId, true);
    } catch (err) {
      logError("lk_cand_desired_toggle", err);
    }
  });

  bot.action("lk_cand_desired_not_specified", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const tgId = ctx.from.id;
      const state = getState(tgId);
      if (!state || state.step !== "desired_points") return;

      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        clearState(tgId);
        return;
      }

      state.data.desiredPointIds = [];
      state.data.desiredPointTitles = [];
      state.step = "salary";
      setState(tgId, state);

      await stepAskSalary(ctx, tgId, true);
    } catch (err) {
      logError("lk_cand_desired_not_specified", err);
    }
  });

  bot.action("lk_cand_desired_next", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const tgId = ctx.from.id;
      const state = getState(tgId);
      if (!state || state.step !== "desired_points") return;

      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        clearState(tgId);
        return;
      }

      state.step = "salary";
      setState(tgId, state);
      await stepAskSalary(ctx, tgId, true);
    } catch (err) {
      logError("lk_cand_desired_next", err);
    }
  });

  // Период зарплаты
  bot.action("lk_cand_salary_period_month", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const tgId = ctx.from.id;
      const state = getState(tgId);
      if (!state || state.step !== "salary") return;

      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        clearState(tgId);
        return;
      }

      state.data.salaryPeriod = "month";
      setState(tgId, state);
      await stepAskSalary(ctx, tgId, true);
    } catch (err) {
      logError("lk_cand_salary_period_month", err);
    }
  });

  bot.action("lk_cand_salary_period_day", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const tgId = ctx.from.id;
      const state = getState(tgId);
      if (!state || state.step !== "salary") return;

      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        clearState(tgId);
        return;
      }

      state.data.salaryPeriod = "day";
      setState(tgId, state);
      await stepAskSalary(ctx, tgId, true);
    } catch (err) {
      logError("lk_cand_salary_period_day", err);
    }
  });

  bot.action("lk_cand_salary_not_specified", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const tgId = ctx.from.id;
      const state = getState(tgId);
      if (!state || state.step !== "salary") return;

      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        clearState(tgId);
        return;
      }

      state.data.salaryAmount = null;
      state.data.salaryPeriod = null;
      state.step = "schedule";
      setState(tgId, state);
      await stepAskSchedule(ctx, true);
    } catch (err) {
      logError("lk_cand_salary_not_specified", err);
    }
  });

  // График кнопками
  bot.action("lk_cand_schedule_2_2", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const tgId = ctx.from.id;
      const state = getState(tgId);
      if (!state || state.step !== "schedule") return;

      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        clearState(tgId);
        return;
      }

      state.data.schedule = "2/2";
      state.step = "experience";
      setState(tgId, state);
      await stepAskExperience(ctx, true);
    } catch (err) {
      logError("lk_cand_schedule_2_2", err);
    }
  });

  bot.action("lk_cand_schedule_3_3", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const tgId = ctx.from.id;
      const state = getState(tgId);
      if (!state || state.step !== "schedule") return;

      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        clearState(tgId);
        return;
      }

      state.data.schedule = "3/3";
      state.step = "experience";
      setState(tgId, state);
      await stepAskExperience(ctx, true);
    } catch (err) {
      logError("lk_cand_schedule_3_3", err);
    }
  });

  bot.action("lk_cand_schedule_5_2", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const tgId = ctx.from.id;
      const state = getState(tgId);
      if (!state || state.step !== "schedule") return;

      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        clearState(tgId);
        return;
      }

      state.data.schedule = "5/2";
      state.step = "experience";
      setState(tgId, state);
      await stepAskExperience(ctx, true);
    } catch (err) {
      logError("lk_cand_schedule_5_2", err);
    }
  });

  bot.action("lk_cand_schedule_not_spec", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const tgId = ctx.from.id;
      const state = getState(tgId);
      if (!state || state.step !== "schedule") return;

      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        clearState(tgId);
        return;
      }

      state.data.schedule = null;
      state.step = "experience";
      setState(tgId, state);
      await stepAskExperience(ctx, true);
    } catch (err) {
      logError("lk_cand_schedule_not_spec", err);
    }
  });

  // Опыт "не указано"
  bot.action("lk_cand_exp_not_spec", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const tgId = ctx.from.id;
      const state = getState(tgId);
      if (!state || state.step !== "experience") return;

      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        clearState(tgId);
        return;
      }

      state.data.experience = null;
      state.step = "comment";
      setState(tgId, state);
      await stepAskComment(ctx, true);
    } catch (err) {
      logError("lk_cand_exp_not_spec", err);
    }
  });

  // Комментарий "не указано"
  bot.action("lk_cand_comment_not_spec", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const tgId = ctx.from.id;
      const state = getState(tgId);
      if (!state || state.step !== "comment") return;

      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        clearState(tgId);
        return;
      }

      state.data.comment = null;
      state.step = "date";
      setState(tgId, state);
      await stepAskDate(ctx, true);
    } catch (err) {
      logError("lk_cand_comment_not_spec", err);
    }
  });

  // Дата — "сегодня"/"завтра"
  bot.action("lk_cand_date_today", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});

      const tgId = ctx.from.id;
      const state = getState(tgId);
      if (!state || state.step !== "date") return;

      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        clearState(tgId);
        return;
      }

      const now = new Date();
      const year = now.getFullYear();
      const month = now.getMonth() + 1;
      const day = now.getDate();
      const iso = `${year}-${String(month).padStart(2, "0")}-${String(
        day
      ).padStart(2, "0")}`;

      state.data.interviewDateISO = iso;
      state.step = "time";
      setState(tgId, state);
      await stepAskTime(ctx, true);
    } catch (err) {
      logError("lk_cand_date_today", err);
    }
  });

  bot.action("lk_cand_date_tomorrow", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});

      const tgId = ctx.from.id;
      const state = getState(tgId);
      if (!state || state.step !== "date") return;

      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        clearState(tgId);
        return;
      }

      const now = new Date();
      now.setDate(now.getDate() + 1);
      const year = now.getFullYear();
      const month = now.getMonth() + 1;
      const day = now.getDate();
      const iso = `${year}-${String(month).padStart(2, "0")}-${String(
        day
      ).padStart(2, "0")}`;

      state.data.interviewDateISO = iso;
      state.step = "time";
      setState(tgId, state);
      await stepAskTime(ctx, true);
    } catch (err) {
      logError("lk_cand_date_tomorrow", err);
    }
  });

  // Выбор ответственного
  bot.action(/^lk_cand_admin_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});

      const tgId = ctx.from.id;
      const state = getState(tgId);
      if (!state || state.step !== "admin") return;

      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        clearState(tgId);
        return;
      }

      const adminId = parseInt(ctx.match[1], 10);
      state.data.responsibleAdminId = adminId;
      setState(tgId, state);

      const candidateId = await createCandidateFromState(ctx, user, adminId);
      if (!candidateId) {
        await ctx
          .answerCbQuery("Не удалось создать кандидата.", { show_alert: true })
          .catch(() => {});
        return;
      }

      await ctx
        .answerCbQuery("✅ Кандидат создан.", { show_alert: false })
        .catch(() => {});

      // сразу переходим к шагу привязки
      await showLinkUserForInterview(ctx, candidateId);
    } catch (err) {
      logError("lk_cand_admin_select", err);
    }
  });

  bot.action("lk_cand_admin_later", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});

      const tgId = ctx.from.id;
      const state = getState(tgId);
      if (!state || state.step !== "admin") return;

      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        clearState(tgId);
        return;
      }

      const candidateId = await createCandidateFromState(ctx, user, null);
      if (!candidateId) {
        await ctx
          .answerCbQuery("Не удалось создать кандидата.", { show_alert: true })
          .catch(() => {});
        return;
      }

      await ctx
        .answerCbQuery(
          "✅ Кандидат создан (ответственный будет назначен позже).",
          { show_alert: false }
        )
        .catch(() => {});

      // и тут — сразу к привязке
      await showLinkUserForInterview(ctx, candidateId);
    } catch (err) {
      logError("lk_cand_admin_later", err);
    }
  });

  // -------------------------
  // ПРИВЯЗКА К ПОЛЬЗОВАТЕЛЮ ЛК (СОБЕСЕДОВАНИЕ)
  // -------------------------

  // Выбор конкретного пользователя из lk_waiting_users
  bot.action(/^lk_cand_linkuser_select_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin")) {
        return;
      }

      const candidateId = Number(ctx.match[1]);
      const waitingId = Number(ctx.match[2]);

      const wRes = await pool.query(
        "SELECT * FROM lk_waiting_users WHERE id = $1",
        [waitingId]
      );
      if (!wRes.rows.length) {
        await ctx.reply(
          "Не удалось найти этого пользователя в списке ожидания."
        );
        return;
      }
      const w = wRes.rows[0];

      // создаём / обновляем пользователя ЛК по telegram_id
      const uRes = await pool.query(
        `
          INSERT INTO users (telegram_id, full_name, role, staff_status, candidate_id)
          VALUES ($1, $2, 'user', 'candidate', $3)
          ON CONFLICT (telegram_id) DO UPDATE
            SET full_name   = EXCLUDED.full_name,
                staff_status = 'candidate',
                candidate_id = $3
          RETURNING id, telegram_id, full_name
        `,
        [w.telegram_id, w.full_name, candidateId]
      );
      const linkedUser = uRes.rows[0];

      // помечаем запись ожидания как привязанную
      await pool.query(
        `
    UPDATE lk_waiting_users
       SET linked_user_id = $2,
           linked_at      = NOW()
     WHERE id = $1
  `,
        [waitingId, linkedUser.id]
      );

      // Пытаемся отправить приглашение, но не падаем, если не получилось
      try {
        await sendInterviewInvitation(
          ctx.telegram,
          linkedUser.telegram_id,
          candidateId
        );
      } catch (err) {
        logError("lk_cand_linkuser_select_sendInvitation", err);
      }

      await ctx.reply(
        `Пользователь «${
          linkedUser.full_name || "без имени"
        }» привязан к кандидату и (скорее всего 😄) получил уведомление о собеседовании.`
      );

      // и только теперь показываем карточку
      await showCandidateCardLk(ctx, candidateId, { edit: false });
    } catch (err) {
      logError("lk_cand_linkuser_select", err);
      await ctx.reply(
        "Произошла ошибка при отправке уведомления, но привязка, возможно, уже выполнена. Проверь карточку кандидата."
      );
    }
  });

  //   // Берём телеграм админа + ФИО и данные по кандидату
  //   const res = await pool.query(
  //     `
  //     SELECT
  //       a.telegram_id       AS admin_telegram_id,
  //       a.full_name         AS admin_name,
  //       c.name              AS cand_name,
  //       c.interview_date    AS interview_date,
  //       c.interview_time    AS interview_time,
  //       tp.title            AS point_title
  //     FROM users a
  //     JOIN candidates c   ON c.admin_id = a.id
  //     LEFT JOIN trade_points tp ON tp.id = c.point_id
  //     WHERE a.id = $1 AND c.id = $2
  //   `,
  //     [adminId, candidateId]
  //   );

  //   if (!res.rows.length) return;

  //   const row = res.rows[0];
  //   if (!row.admin_telegram_id) return; // нечего слать

  //   const candName = row.cand_name || "кандидат";
  //   const dateStr = formatDateRu(row.interview_date);
  //   const timeStr = row.interview_time || "не указано";
  //   const pointTitle = row.point_title || "не указана";

  //   const text =
  //     `Вам назначено собеседование.\n\n` +
  //     `• Кандидат: ${candName}\n` +
  //     `• Дата: ${dateStr}\n` +
  //     `• Время: ${timeStr}\n` +
  //     `• Точка: ${pointTitle}\n`;

  //   await telegram.sendMessage(row.admin_telegram_id, text);
  // }

  // «Привяжу позже»
  bot.action(/^lk_cand_linkuser_later_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const candidateId = Number(ctx.match[1]);

      await ctx.reply(
        "Ок, кандидата можно будет привязать к пользователю ЛК позже из его карточки."
      );

      await showCandidateCardLk(ctx, candidateId, { edit: false });
    } catch (err) {
      logError("lk_cand_linkuser_later", err);
    }
  });
}

module.exports = {
  registerCandidateCreate,
  sendInterviewInvitation,
};
