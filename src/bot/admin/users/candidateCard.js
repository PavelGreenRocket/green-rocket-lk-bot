// src/bot/admin/users/candidateCard.js

const { Markup } = require("telegraf");
const pool = require("../../../db/pool");

// Функция доставки сообщений (прокидывается из index.js)
let deliverFn = null;

// Шапка карточки кандидата по статусу
function getCandidateHeader(status) {
  switch (status) {
    case "invited":
      // ждет собеседования
      return "🔻 КАНДИДАТ — ОЖИДАНИЕ СОБЕСЕДОВАНИЯ (🕒)";
    case "interviewed":
      // собеседование уже проведено, ждет решения
      return "🔻 КАНДИДАТ — СОБЕСЕДОВАНИЕ ПРОВЕДЕНО (✔️)";
    case "internship_invited":
      // приглашен на стажировку
      return "🔻 КАНДИДАТ — ПРИГЛАШЁН НА СТАЖИРОВКУ (☑️)";
    case "cancelled":
      return "🔻 КАНДИДАТ — СОБЕСЕДОВАНИЕ ОТМЕНЕНО (❌)";
    case "declined":
      return "🔻 КАНДИДАТ — ОТКАЗАНО (❌)";
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

// ----- Основной рендер карточки -----
async function showCandidateCardLk(ctx, candidateId, { edit = true } = {}) {
  const res = await pool.query(
    `
     SELECT
        c.id,
        c.name,
        c.age,
        c.phone,
        c.status,
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

  // 🔻 Статус в шапке
  const header = getCandidateHeader(cand.status);

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
    text += `• *Пользователь:* tg://user?id=${lkUserTgId}\n`;
  } else {
    text += "• *Пользователь:* не привязан\n";
  }

  text += `• *Желаемая ЗП:* ${salaryText}\n`;
  text += `• *Желаемый график:* ${scheduleText}\n`;
  text += `• *Предыдущий опыт:* ${experienceText}\n`;
  text += `• *Общий комментарий:* ${commentText}\n\n`;

  // 📅 О собеседовании / Итоги собеседования
  if (cand.status === "interviewed" || cand.status === "internship_invited") {
    text += "📅 *Итоги собеседования*\n";
  } else {
    text += "📅 *О собеседовании*\n";
  }

  text += `• *Дата/время:* ${dtFull}\n`;
  text += `• *Место собеседования:* ${placeTitle}\n`;
  text += `• *Ответственный:* ${adminName}\n\n`;

  // 🔹 Замечания — только если собес уже прошёл / стажировка
  if (cand.status === "interviewed" || cand.status === "internship_invited") {
    text += "🔹 *Замечания*\n";

    if (cand.was_on_time === true) {
      text += "• *Опоздание:* пришёл вовремя\n";
    } else if (cand.was_on_time === false) {
      const minutes =
        cand.late_minutes != null ? `${cand.late_minutes} мин` : "есть";
      text += `• *Опоздание:* опоздал (${minutes})\n`;
    } else {
      text += "• *Опоздание:* не указано\n";
    }

    // 🔹 О стажировке — когда уже приглашён
    if (cand.status === "internship_invited") {
      text += "\n📌 *О стажировке*\n";

      if (cand.internship_date) {
        const dateLabel = formatDateWithWeekday(cand.internship_date);
        if (cand.internship_time_from && cand.internship_time_to) {
          text += `• Дата стажировки: ${dateLabel} (с ${cand.internship_time_from.slice(
            0,
            5
          )} до ${cand.internship_time_to.slice(0, 5)})\n`;
        } else {
          text += `• Дата стажировки: ${dateLabel}\n`;
        }
      } else {
        text += "• Дата стажировки: не указана\n";
      }

      text += `• Место стажировки: ${
        cand.internship_point_title || cand.place_title || "не указано"
      }\n`;
      text += `• Ответственный по стажировке: ${
        cand.internship_admin_name || "не указан"
      }\n`;
    }

    if (cand.interview_comment) {
      text += `• *Комментарий собеседования:* ${cand.interview_comment}\n`;
    } else {
      text += "• *Комментарий собеседования:* не указан\n";
    }

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
        `lk_cand_decline_${cand.id}`
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
        `lk_cand_decline_${cand.id}`
      ),
    ]);
  } else if (cand.status === "internship_invited") {
    // Уже приглашён на стажировку
    rows.push([
      Markup.button.callback(
        "🚀 начать стажировку",
        `lk_cand_start_intern_${cand.id}`
      ),
    ]);
    rows.push([
      Markup.button.callback(
        "❌ отказать кандидату",
        `lk_cand_decline_${cand.id}`
      ),
    ]);
  }

  // Общие кнопки
  rows.push([
    Markup.button.callback("⚙️ Настройки", `lk_cand_settings_${cand.id}`),
  ]);
  rows.push([Markup.button.callback("◀️ К кандидатам", "lk_cand_list")]);

  const keyboard = Markup.inlineKeyboard(rows);

  if (!deliverFn) {
    // fallback, если по какой-то причине deliver ещё не прокинут
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
    {
      text,
      extra: { ...keyboard, parse_mode: "Markdown" },
    },
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

  // заглушка "Настройки кандидата"
  bot.action(/^lk_cand_settings_(\d+)$/, async (ctx) => {
    try {
      await ctx
        .answerCbQuery("Настройки кандидата пока в разработке.")
        .catch(() => {});
    } catch (err) {
      logError("lk_cand_settings", err);
    }
  });
}

module.exports = registerCandidateCard;
module.exports.showCandidateCardLk = showCandidateCardLk;
