// src/bot/admin/users/candidateCard.js

const { Markup } = require("telegraf");
const pool = require("../../../db/pool");

// Функция доставки сообщений (прокидывается из index.js)
let deliverFn = null;

// состояние "📋 Открыть карточку" по tg_id
const traineeCardsExpandedByTgId = new Map();

function isTraineeCardsExpanded(tgId) {
  return traineeCardsExpandedByTgId.get(tgId) === true;
}
function toggleTraineeCardsExpanded(tgId) {
  const cur = isTraineeCardsExpanded(tgId);
  traineeCardsExpandedByTgId.set(tgId, !cur);
  return !cur;
}

// Шапка карточки кандидата по статусу
function getCandidateHeader(status) {
  switch (status) {
    case "invited":
      return "🔻 КАНДИДАТ — ОЖИДАНИЕ СОБЕСЕДОВАНИЯ (🕒)";
    case "interviewed":
      return "🔻 КАНДИДАТ — СОБЕСЕДОВАНИЕ ПРОВЕДЕНО (✔️)";
    case "internship_invited":
      return "🔻 КАНДИДАТ — ПРИГЛАШЁН НА СТАЖИРОВКУ (☑️)";
    case "cancelled":
      return "🔻 КАНДИДАТ — СОБЕСЕДОВАНИЕ ОТМЕНЕНО (❌)";
    case "rejected":
      return "🔻 КАНДИДАТ — КАНДИДАТ ОТКЛОНЁН (❌)"; // новый статус как ты описал
    default:
      return "🔻 КАНДИДАТ";
  }
}

const WEEK_DAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

// Короткий формат даты/времени: 07.12 на 11:00 (ср)
function formatDateTimeShort(isoDate, timeStr) {
  if (!isoDate && !timeStr) return "не указано";

  let datePart = "";
  let weekdayPart = "";
  let date = null;

  if (isoDate) {
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
  }

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
  return result || "не указано";
}

// Только дата + день недели: 07.12 (ср)
function formatDateWithWeekday(isoDate) {
  if (!isoDate) return "не указана";

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

  if (!date || Number.isNaN(date.getTime())) return "не указана";

  const dd = String(date.getDate()).padStart(2, "0");
  const mm = String(date.getMonth() + 1).padStart(2, "0");
  const weekday = WEEK_DAYS[date.getDay()];
  return `${dd}.${mm} (${weekday})`;
}

function buildRestoreKeyboard(candidate) {
  const buttons = [];

  buttons.push([
    Markup.button.callback(
      "✏️ Изменить общую информацию",
      `lk_cand_edit_common_${candidate.id}`
    ),
  ]);

  if (candidate.status === "rejected") {
    if (candidate.closed_from_status === "invited") {
      buttons.push([
        Markup.button.callback(
          "🗓 Изменить собеседование",
          `lk_cand_edit_interview_${candidate.id}`
        ),
      ]);
    }

    if (candidate.closed_from_status === "internship_invited") {
      buttons.push([
        Markup.button.callback(
          "🚀 Изменить стажировку",
          `lk_cand_edit_internship_${candidate.id}`
        ),
      ]);
    }
  }

  buttons.push([
    Markup.button.callback(
      "♻️ Восстановить и оповестить",
      `lk_cand_restore_apply_${candidate.id}`
    ),
  ]);

  buttons.push([
    Markup.button.callback(
      "❌ Отмена",
      `lk_cand_restore_cancel_${candidate.id}`
    ),
  ]);

  return Markup.inlineKeyboard(buttons);
}

async function getActiveShiftToday(userId) {
  const { rows } = await pool.query(
    `
    SELECT s.id, s.trade_point_id, tp.title AS point_title
    FROM shifts s
    LEFT JOIN trade_points tp ON tp.id = s.trade_point_id
    WHERE s.user_id = $1
      AND s.opened_at::date = CURRENT_DATE
      AND s.status IN ('opening_in_progress','opened')
    ORDER BY s.id DESC
    LIMIT 1
    `,
    [userId]
  );
  return rows[0] || null;
}

function escHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

// ----- Основной рендер карточки -----
async function showCandidateCardLk(ctx, candidateId, options = {}) {
  const { edit = true } = options;
  const isRestoreMode = options.restoreMode === true;
  const isEditMode = !!options.keyboardOverride && !isRestoreMode;

  const res = await pool.query(
    `
     SELECT
        c.id,
        c.name,
        c.age,
        c.phone,
        c.status,
        c.is_deferred,
        c.salary,
        c.schedule,
        c.questionnaire,
        c.comment,
        c.interview_date,
        c.interview_time,
        c.was_on_time,
        c.late_minutes,
        c.interview_comment,
        c.decline_reason,
        c.closed_from_status,
        c.internship_date,
        c.internship_time_from,
        c.internship_time_to,
        c.internship_point_id,
        c.internship_admin_id,
        COALESCE(tp_place.title, 'не указано')   AS place_title,
        COALESCE(tp_desired.title, 'не указано') AS desired_point_title,
        COALESCE(tp_intern.title, 'не указано')  AS internship_point_title,
                COALESCE(u_admin.full_name, 'не назначен')   AS admin_name,
       COALESCE(u_intern.full_name, 'не назначен')  AS internship_admin_name,
u_intern.telegram_id AS internship_admin_tg_id,
u_link.id           AS lk_user_id,
        u_link.full_name    AS lk_user_name,
        u_link.telegram_id  AS lk_user_telegram_id

FROM candidates c
        LEFT JOIN trade_points tp_place    ON c.point_id            = tp_place.id
        LEFT JOIN trade_points tp_desired  ON c.desired_point_id    = tp_desired.id
        LEFT JOIN trade_points tp_intern   ON c.internship_point_id = tp_intern.id
        LEFT JOIN users       u_admin      ON c.admin_id            = u_admin.id
        LEFT JOIN users       u_intern     ON c.internship_admin_id = u_intern.id
        LEFT JOIN users       u_link       ON u_link.candidate_id   = c.id
      WHERE c.id = $1
    `,
    [candidateId]
  );

  if (!res.rows.length) {
    await ctx.reply("Кандидат не найден.");
    return;
  }

  const cand = res.rows[0];

  // --- стажировка: активная сессия / кол-во завершённых ---
  let activeInternshipSession = null;
  let finishedInternshipCount = 0;

  if (cand.lk_user_id) {
    const sRes = await pool.query(
      `
      SELECT id, day_number, finished_at, is_canceled
      FROM internship_sessions
      WHERE user_id = $1
      ORDER BY id DESC
    `,
      [cand.lk_user_id]
    );

    const sessions = sRes.rows || [];
    finishedInternshipCount = sessions.filter(
      (s) => s.finished_at && !s.is_canceled
    ).length;

    activeInternshipSession =
      sessions.find((s) => !s.finished_at && !s.is_canceled) || null;
  }

  // режим "СТАЖЁР":
  // - для status='intern' всегда считаем стажёром
  // - для status='internship_invited' — стажёрский режим включаем только если уже есть сессии
  const isTraineeMode =
    cand.status === "intern" ||
    (cand.status === "internship_invited" &&
      (activeInternshipSession !== null || finishedInternshipCount > 0));

  // ✅ активная смена стажёра (нужна, чтобы показывать кнопку "📝 задачи смены")
  // раньше переменная activeShift использовалась ниже, но не была определена → падало.
  let activeShift = null;
  try {
    if (isTraineeMode && activeInternshipSession && cand.lk_user_id) {
      activeShift = await getActiveShiftToday(cand.lk_user_id);
    }
  } catch (e) {
    activeShift = null;
  }

  const traineeHeader = activeInternshipSession
    ? `🔻 СТАЖЁР — ДЕНЬ ${activeInternshipSession.day_number} (В ПРОЦЕССЕ)`
    : `🔻 СТАЖЁР — ВСЕГО СТАЖИРОВОК (${finishedInternshipCount})`;

  // 🔻 Заголовок в обычном режиме (как раньше, с деталями)
  const normalHeader = isTraineeMode
    ? traineeHeader
    : getCandidateHeader(cand.status);

  // 🔻 Заголовок в режиме изменения (только роль: кандидат/стажёр)
  const editHeaderBase = isTraineeMode ? "🔻 СТАЖЁР" : "🔻 КАНДИДАТ";

  const header = isRestoreMode
    ? "🔻 КАНДИДАТ — ВОССТАНОВЛЕНИЕ (♻️)"
    : isEditMode
    ? `${editHeaderBase} — РЕЖИМ ИЗМЕНЕНИЯ (✏️)`
    : normalHeader;

  // Возраст без "лет"
  const agePart = cand.age ? ` (${cand.age})` : "";

  const desiredPointTitle = cand.desired_point_title || "не указано";
  const phoneText = cand.phone || "не указан";
  const salaryText = cand.salary || "не указана";
  const scheduleText = cand.schedule || "не указан";
  const experienceText = cand.questionnaire || "не указан";
  const commentText = cand.comment || "не указан";

  const dtFull = formatDateTimeShort(cand.interview_date, cand.interview_time);
  const placeTitle = cand.place_title || "не указано";
  const adminName = cand.admin_name || "не назначен";
  const lkUserName = cand.lk_user_name || null;
  const lkUserId = cand.lk_user_id || null;
  const lkUserTgId = cand.lk_user_telegram_id || null;

  let text = "";
  text += `${header}\n`;
  text += "────────────────────────────────\n";

  text += "🔹 *Общая информация*\n";
  text += `• *Имя:* ${cand.name || "не указано"}${agePart}\n`;
  text += `• *Желаемая точка:* ${desiredPointTitle}\n`;
  text += `• *Телефон:* ${phoneText}\n`;

  if (lkUserTgId) {
    let bound = "привязан";
    if (lkUserName) bound += ` (${lkUserName})`; // если хочешь именно @username — см. примечание ниже
    text += `• *Пользователь:* ${bound}\n`;
  } else {
    text += "• *Пользователь:* не привязан\n";
  }

  text += `• *Желаемая ЗП:* ${salaryText}\n`;
  text += `• *Желаемый график:* ${scheduleText}\n`;
  text += `• *Предыдущий опыт:* ${experienceText}\n`;
  text += `• *Общий комментарий:* ${commentText}\n\n`;
  text += "────────────────────────────────\n";

  // 📅 О собеседовании / Итоги собеседования
  if (!isTraineeMode) {
    if (cand.status === "interviewed" || cand.status === "internship_invited") {
      text += "🔹 *Итоги собеседования*\n";
    } else {
      text += "🔹 *О собеседовании*\n";
    }

    text += `• *Дата/время:* ${dtFull}\n`;
    text += `• *Место собеседования:* ${placeTitle}\n`;
    text += `• *Ответственный:* ${adminName}\n\n`;
  }

  // --- Блок причины отказа для отклонённого кандидата ---
  if (cand.status === "rejected") {
    const reason = cand.decline_reason || "не указана";

    text += "────────────────────────────────\n";
    text += "ПРИЧИНА ОТКАЗА ❌\n";
    text += `Причина: ${reason}\n\n`;
  }

  if (!isTraineeMode) {
    // 🔹 Замечания — только если собес уже прошёл / стажировка
    if (cand.status === "interviewed" || cand.status === "internship_invited") {
      text += "🔹 *Замечания по собеседованию*\n";

      if (cand.was_on_time === true) {
        text += "• *Опоздание:* пришёл вовремя\n";
      } else if (cand.was_on_time === false) {
        const minutes =
          cand.late_minutes != null ? `${cand.late_minutes} мин` : "есть";
        text += `• *Опоздание:* опоздал (${minutes})\n`;
      } else {
        text += "• *Опоздание:* не указано\n";
      }

      if (cand.interview_comment) {
        text += `• *Другие замечания:* ${cand.interview_comment}\n`;
        text += "────────────────────────────────\n";
      } else {
        text += "• *Другие замечания:* замечаний нет\n";
        text += "────────────────────────────────\n";
      }
    }
  }

  // 🔹 О стажировке — когда приглашён или уже стажёр
  if (cand.status === "internship_invited" || cand.status === "intern") {
    text += "🔹 *О стажировке*\n";

    if (cand.internship_date) {
      const dateLabel = formatDateWithWeekday(cand.internship_date);
      if (cand.internship_time_from && cand.internship_time_to) {
        text += `• *Дата стажировки:* ${dateLabel} (с ${cand.internship_time_from.slice(
          0,
          5
        )} до ${cand.internship_time_to.slice(0, 5)})\n`;
      } else {
        text += `• *Дата стажировки:* ${dateLabel}\n`;
      }
    } else {
      text += "• *Дата стажировки:* не указана\n";
    }

    text += `• *Место стажировки:* ${
      cand.internship_point_title || cand.place_title || "не указано"
    }\n`;
    text += `• *Ответственный по стажировке:* ${
      cand.internship_admin_name || "не указан"
    }\n`;

    if (cand.decline_reason) {
      text += `• *Причина отказа:* ${cand.decline_reason}\n`;
    }

    text += "\n";
  }

  // Кнопки
  const rows = [];

  if (cand.status === "invited") {
    // Ещё не было собеса
    rows.push([
      Markup.button.callback(
        "✅ Собеседование пройдено",
        `lk_cand_passed_${cand.id}`
      ),
    ]);
    rows.push([
      Markup.button.callback(
        "❌ отказать кандидату",
        `lk_cand_decline_reason_${cand.id}`
      ),
    ]);
  } else if (cand.status === "interviewed") {
    // Собеседование проведено, можно пригласить на стажировку или отказать
    rows.push([
      Markup.button.callback(
        "✅ пригласить на стажировку",
        `lk_cand_invite_${cand.id}`
      ),
    ]);
    rows.push([
      Markup.button.callback(
        "❌ отказать кандидату",
        `lk_cand_decline_reason_${cand.id}`
      ),
    ]);
  } else if (cand.status === "internship_invited" || cand.status === "intern") {
    // приглашён / стажировка в процессе
    if (isTraineeMode) {
      const mentorTgId = cand.internship_admin_tg_id || null;
      const isMentor = mentorTgId && ctx.from.id === mentorTgId;

      // 1) Перейти к обучению / идёт обучение
      if (activeInternshipSession) {
        if (isMentor) {
          rows.push([
            Markup.button.url(
              "⏺️ Перейти к обучению",
              "https://t.me/baristaAcademy_GR_bot"
            ),
          ]);
        } else {
          rows.push([
            Markup.button.callback(
              "⏺️ идёт обучение",
              `lk_internship_training_locked_${cand.id}`
            ),
          ]);
        }
        if (activeShift) {
          rows.push([
            Markup.button.callback(
              "📝 задачи смены",
              `lk_intern_shift_tasks_${cand.id}`
            ),
          ]);
        }
      } else {
        // стажировка ещё не начата (но есть завершённые) — наставнику можно начать следующую
        if (isMentor) {
          rows.push([
            Markup.button.callback(
              "▶️ начать стажировку",
              `lk_cand_start_intern_${cand.id}`
            ),
          ]);
        }
        // для остальных — ничего
      }

      // 2) данные стажировок (заглушка)
      rows.push([
        Markup.button.callback(
          "▴ данные стажировок",
          `lk_internship_data_stub_${cand.id}`
        ),
      ]);

      // 3) ▾ Открыть карточку ⤵/⤴ (toggle)
      const expanded = isTraineeCardsExpanded(ctx.from.id);
      rows.push([
        Markup.button.callback(
          expanded ? "▾ Скрыть карточку" : "▴ Открыть карточку",
          `lk_internship_toggle_cards_${cand.id}`
        ),
      ]);

      // раскрытые кнопки (заглушки)
      if (expanded) {
        rows.push([
          Markup.button.callback(
            "Карточка кандидата",
            `lk_internship_card_candidate_stub_${cand.id}`
          ),
        ]);
        rows.push([
          Markup.button.callback(
            "Карточка стажёра",
            `lk_internship_card_trainee_stub_${cand.id}`
          ),
        ]);
        rows.push([
          Markup.button.callback(
            "Карточка сотрудника",
            `lk_internship_card_worker_stub_${cand.id}`
          ),
        ]);
      }

      // (пока) отказ стажёру — только если НЕ идёт процесс (по твоей логике заглушка)
      if (!activeInternshipSession) {
        rows.push([
          Markup.button.callback(
            "❌ отказать стажёру",
            `lk_internship_decline_stub_${cand.id}`
          ),
        ]);
      }
    } else {
      // старый режим: просто приглашён, ещё не начинали
      rows.push([
        Markup.button.callback(
          "▶️ начать стажировку",
          `lk_cand_start_intern_${cand.id}`
        ),
      ]);
      rows.push([
        Markup.button.callback(
          "❌ отказать кандидату",
          `lk_cand_decline_reason_${cand.id}`
        ),
      ]);
    }
  } else if (cand.status === "rejected") {
    // Кандидат отклонён
    rows.push([
      Markup.button.callback(
        "♻️ восстановить кандидата",
        `lk_cand_restore_${cand.id}`
      ),
    ]);

    if (cand.is_deferred) {
      rows.push([
        Markup.button.callback(
          "↩️🗑️ убрать из отложенных",
          `lk_cand_unpostpone_${cand.id}`
        ),
      ]);
    } else {
      rows.push([
        Markup.button.callback(
          "🗑️ перенести в отложенные",
          `lk_cand_postpone_${cand.id}`
        ),
      ]);
    }
  }

  // Общие кнопки
  rows.push([
    Markup.button.callback("⚙️ Настройки", `lk_cand_settings_${cand.id}`),
  ]);
  rows.push([
    options.backTo === "interns"
      ? Markup.button.callback("◀️ К стажёрам", "admin_users_interns")
      : Markup.button.callback("◀️ К кандидатам", "admin_users_candidates"),
  ]);

  let keyboard;

  if (isRestoreMode) {
    keyboard = buildRestoreKeyboard(cand);
  } else {
    keyboard = Markup.inlineKeyboard(rows);
  }

  // ✅ если пришла "внешняя" клавиатура (меню редактирования/выбор точки) —
  // оставляем ТЕКСТ карточки, меняем только кнопки
  if (options.keyboardOverride) {
    keyboard = options.keyboardOverride;
  }

  // ✅ если нужно отредактировать КОНКРЕТНОЕ сообщение (для bot.on("text"))
  if (
    options.forceMessage &&
    options.forceMessage.chatId &&
    options.forceMessage.messageId
  ) {
    const { chatId, messageId } = options.forceMessage;

    try {
      await ctx.telegram.editMessageText(chatId, messageId, undefined, text, {
        ...keyboard,
        parse_mode: "Markdown",
      });
    } catch (e) {
      // не падаем на "message is not modified" и т.п.
      await ctx.telegram
        .editMessageReplyMarkup(
          chatId,
          messageId,
          undefined,
          keyboard.reply_markup
        )
        .catch(() => {});
    }
    return;
  }

  // обычный путь (callback_query) — как было
  if (!deliverFn) {
    if (edit && ctx.updateType === "callback_query") {
      await ctx
        .editMessageText(text, { ...keyboard, parse_mode: "Markdown" })
        .catch(() => {});
    } else {
      await ctx.reply(text, { ...keyboard, parse_mode: "Markdown" });
    }
    return;
  }

  await deliverFn(
    ctx,
    { text, extra: { ...keyboard, parse_mode: "Markdown" } },
    { edit }
  );
}

// регистрируем хендлеры, связанные с карточкой
function registerCandidateCard(bot, ensureUser, logError, deliver) {
  deliverFn = deliver;

  // открыть карточку кандидата по кнопке из списка
  bot.action(/^lk_cand_open_(\d+)$/, async (ctx) => {
    try {
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        await ctx.answerCbQuery("Нет доступа.").catch(() => {});
        return;
      }
      const candidateId = Number(ctx.match[1]);
      await ctx.answerCbQuery().catch(() => {});
      await showCandidateCardLk(ctx, candidateId, { edit: true });
    } catch (err) {
      logError("lk_cand_open", err);
    }
  });

  // меню "Настройки" в карточке
  bot.action(/^lk_cand_settings_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin"))
        return;

      const candidateId = Number(ctx.match[1]);

      // берём статус, чтобы решить: "о собеседовании" / "о стажировке" / ничего
      const r = await pool.query(
        `SELECT status FROM candidates WHERE id = $1`,
        [candidateId]
      );
      if (!r.rows.length) return;

      const status = r.rows[0].status;

      const rows = [];

      // 1) Общая информация (переиспользуем существующий редактор)
      rows.push([
        Markup.button.callback(
          "Общая информация (изменить)",
          `lk_cand_edit_common_${candidateId}`
        ),
      ]);

      // 2) Условная кнопка
      if (status === "invited") {
        rows.push([
          Markup.button.callback(
            "О собеседовании (изменить)",
            `lk_cand_edit_interview_${candidateId}`
          ),
        ]);
      } else if (status === "internship_invited") {
        rows.push([
          Markup.button.callback(
            "О стажировке (изменить)",
            `lk_cand_edit_internship_${candidateId}`
          ),
        ]);
      }
      // если status === "interviewed" — ничего не добавляем (как ты и просил)

      // 3) Другие (пока заглушка)
      rows.push([
        Markup.button.callback(
          "Другое (изменить)",
          `lk_cand_settings_other_${candidateId}`
        ),
      ]);

      // Назад в обычные кнопки карточки
      rows.push([
        Markup.button.callback(
          "⬅️ Назад",
          `lk_cand_settings_back_${candidateId}`
        ),
      ]);

      const kb = Markup.inlineKeyboard(rows);

      // ✅ текст карточки оставляем, меняем только кнопки
      await showCandidateCardLk(ctx, candidateId, {
        edit: true,
        keyboardOverride: kb,
      });
    } catch (err) {
      logError("lk_cand_settings_menu", err);
    }
  });

  bot.action(/^lk_cand_settings_back_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin"))
        return;

      const candidateId = Number(ctx.match[1]);
      await showCandidateCardLk(ctx, candidateId, { edit: true });
    } catch (err) {
      logError("lk_cand_settings_back", err);
    }
  });

  bot.action(/^lk_cand_settings_other_(\d+)$/, async (ctx) => {
    try {
      await ctx
        .answerCbQuery("Раздел «Другие» пока в разработке.")
        .catch(() => {});
    } catch (err) {
      logError("lk_cand_settings_other", err);
    }
  });

  // "идёт обучение" — тост
  bot.action(/^lk_internship_training_locked_(\d+)$/, async (ctx) => {
    try {
      await ctx
        .answerCbQuery("Обучение идёт, доступно наставнику", {
          show_alert: false,
        })
        .catch(() => {});
    } catch (err) {
      logError("lk_internship_training_locked", err);
    }
  });

  // данные стажировок — заглушка
  bot.action(/^lk_internship_data_stub_(\d+)$/, async (ctx) => {
    try {
      await ctx
        .answerCbQuery("Данные стажировок — в разработке.")
        .catch(() => {});
    } catch (err) {
      logError("lk_internship_data_stub", err);
    }
  });

  bot.action(/^lk_intern_shift_tasks_(\d+)$/, async (ctx) => {
    const candId = Number(ctx.match[1]);
    await ctx.answerCbQuery().catch(() => {});

    // достаём lk_user_id стажёра (который в users)
    const cRes = await pool.query(
      `
    SELECT u.id AS lk_user_id, COALESCE(u.full_name,'Без имени') AS full_name
    FROM candidates c
    LEFT JOIN users u ON u.candidate_id = c.id
    WHERE c.id = $1
    LIMIT 1
    `,
      [candId]
    );

    const lkUserId = cRes.rows[0]?.lk_user_id || null;
    const fullName = cRes.rows[0]?.full_name || "Без имени";

    if (!lkUserId) {
      await ctx.editMessageText(
        "⚠️ У стажёра нет привязанного пользователя ЛК."
      );
      return;
    }

    const activeShift = await getActiveShiftToday(lkUserId);
    if (!activeShift) {
      await ctx.editMessageText(
        "⚠️ У пользователя нет активной смены сегодня."
      );
      return;
    }

    // задачи на сегодня (instances)
    const tRes = await pool.query(
      `
    SELECT
      ti.id,
      ti.status,
      tt.title,
      tt.answer_type,
      last_ans.answer_text,
      last_ans.answer_number,
      last_ans.file_type,
      last_ans.file_id
    FROM task_instances ti
    JOIN task_templates tt ON tt.id = ti.template_id
    LEFT JOIN LATERAL (
      SELECT a.*
      FROM task_instance_answers a
      WHERE a.task_instance_id = ti.id
      ORDER BY a.created_at DESC
      LIMIT 1
    ) last_ans ON TRUE
    WHERE ti.user_id = $1
      AND ti.for_date = CURRENT_DATE
    ORDER BY ti.id
    `,
      [lkUserId]
    );

    let text = `📝 <b>Задачи смены</b>\n\n`;
    text += `👤 <b>${escHtml(fullName)}</b>\n`;
    text += `📍 Точка: <b>${escHtml(
      activeShift.point_title || "не указано"
    )}</b>\n\n`;

    if (!tRes.rows.length) {
      text += `⚠️ На сегодня задач нет.\n`;
    } else {
      text += `<b>Список задач на сегодня:</b>\n`;
      for (let i = 0; i < tRes.rows.length; i++) {
        const r = tRes.rows[i];
        const done = r.status === "done";
        const icon = done ? "✅" : "▫️";
        text += `${i + 1}. ${icon} ${escHtml(r.title)}\n`;
      }
    }

    const rows = [];

    // "+ создать ещё задачу" → в ваш существующий админский экран по точке
    rows.push([
      Markup.button.callback(
        "➕ создать ещё задачу",
        `admin_shift_tasks_point_${activeShift.trade_point_id}`
      ),
    ]);

    rows.push([Markup.button.callback("⬅️ Назад", `lk_cand_open_${candId}`)]);

    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard(rows),
    });
  });

  // toggle "📋 Открыть карточку"
  bot.action(/^lk_internship_toggle_cards_(\d+)$/, async (ctx) => {
    try {
      const candidateId = Number(ctx.match[1]);
      toggleTraineeCardsExpanded(ctx.from.id);
      await ctx.answerCbQuery().catch(() => {});
      await showCandidateCardLk(ctx, candidateId, { edit: true });
    } catch (err) {
      logError("lk_internship_toggle_cards", err);
    }
  });

  // заглушки карточек
  bot.action(/^lk_internship_card_candidate_stub_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery("Карточка кандидата — позже.").catch(() => {});
  });
  bot.action(/^lk_internship_card_trainee_stub_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery("Карточка стажёра — позже.").catch(() => {});
  });
  bot.action(/^lk_internship_card_worker_stub_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery("Карточка сотрудника — позже.").catch(() => {});
  });

  bot.action(/^lk_internship_decline_stub_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery("Отказ стажёру — пока заглушка.").catch(() => {});
  });
}

module.exports = registerCandidateCard;
module.exports.showCandidateCardLk = showCandidateCardLk;
