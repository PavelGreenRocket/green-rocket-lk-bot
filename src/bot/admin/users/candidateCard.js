// src/bot/admin/users/candidateCard.js

const { Markup } = require("telegraf");
const pool = require("../../../db/pool");

// Функция доставки сообщений (прокидывается из index.js)
let deliverFn = null;
let ensureUserFn = null;

// состояние "📋 Открыть карточку" по tg_id
const traineeCardsExpandedByTgId = new Map();

// текущий выбранный экран в меню карточек: 'candidate' | 'trainee'
const traineeCardsViewByTgId = new Map();

// состояние экрана 🌱 Данные стажировок (по tg_id)
// { candId, mode: 'parts'|'days'|'day'|'part', selectedDay?: number, selectedPartId?: number }
const internshipDataStateByTgId = new Map();

const internEditStates = new Map();

function getTraineeCardsView(tgId) {
  return traineeCardsViewByTgId.get(tgId) || "trainee";
}
function setTraineeCardsView(tgId, view) {
  traineeCardsViewByTgId.set(tgId, view);
}

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
      `lk_cand_edit_common_${candidate.id}`,
    ),
  ]);

  if (candidate.status === "rejected") {
    if (candidate.closed_from_status === "invited") {
      buttons.push([
        Markup.button.callback(
          "🗓 Изменить собеседование",
          `lk_cand_edit_interview_${candidate.id}`,
        ),
      ]);
    }

    if (candidate.closed_from_status === "internship_invited") {
      buttons.push([
        Markup.button.callback(
          "🚀 Изменить стажировку",
          `lk_cand_edit_internship_${candidate.id}`,
        ),
      ]);
    }
  }

  buttons.push([
    Markup.button.callback(
      "♻️ Восстановить и оповестить",
      `lk_cand_restore_apply_${candidate.id}`,
    ),
  ]);

  buttons.push([
    Markup.button.callback(
      "❌ Отмена",
      `lk_cand_restore_cancel_${candidate.id}`,
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
    [userId],
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

  // Режим изменения включаем только когда явно просим (например, "Настройки"),
  // а не когда просто временно меняем клавиатуру (например, меню "карточки").
  const isEditMode = options.editMode === true && !isRestoreMode;

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
        u_link.telegram_id  AS lk_user_telegram_id,
         COALESCE(u_link.lk_enabled, false) AS lk_user_lk_enabled


FROM candidates c
        LEFT JOIN trade_points tp_place    ON c.point_id            = tp_place.id
        LEFT JOIN trade_points tp_desired  ON c.desired_point_id    = tp_desired.id
        LEFT JOIN trade_points tp_intern   ON c.internship_point_id = tp_intern.id
        LEFT JOIN users       u_admin      ON c.admin_id            = u_admin.id
        LEFT JOIN users       u_intern     ON c.internship_admin_id = u_intern.id
        LEFT JOIN users       u_link       ON u_link.candidate_id   = c.id
      WHERE c.id = $1
    `,
    [candidateId],
  );

  if (!res.rows.length) {
    await ctx.reply("Кандидат не найден.");
    return;
  }

  const cand = res.rows[0];

  const isInternshipScheduled =
    !!cand.internship_date &&
    !!cand.internship_time_from &&
    !!cand.internship_time_to &&
    !!cand.internship_point_id &&
    !!cand.internship_admin_id;

  const me = ensureUserFn ? await ensureUserFn(ctx) : null;
  const isAdmin = me && (me.role === "admin" || me.role === "super_admin");

  // ✅ отметка о завершении курса (ставится Академией в users.training_completed_at)
  let trainingCompletedAt = null;
  if (cand.lk_user_id) {
    try {
      const tr = await pool.query(
        `SELECT training_completed_at FROM users WHERE id = $1 LIMIT 1`,
        [cand.lk_user_id],
      );
      trainingCompletedAt = tr.rows[0]?.training_completed_at || null;
    } catch (_) {
      trainingCompletedAt = null;
    }
  }

  // Когда открываем карточку кандидата через переключатель со стажёра/сотрудника,
  // хотим показывать текст как на этапе "приглашён на стажировку" (скрин 3).
  const displayStatus = options.forceCandidateStatus || cand.status;

  // --- стажировка: активная сессия / кол-во завершённых / план из schedules ---
  let activeInternshipSession = null;
  let finishedInternshipCount = 0;
  let schedule = null; // started → planned fallback

  if (cand.lk_user_id) {
    const sRes = await pool.query(
      `
      SELECT id, day_number, finished_at, is_canceled
      FROM internship_sessions
      WHERE user_id = $1
      ORDER BY id DESC
      `,
      [cand.lk_user_id],
    );

    const sessions = sRes.rows || [];
    finishedInternshipCount = sessions.filter(
      (s) => s.finished_at && !s.is_canceled,
    ).length;

    activeInternshipSession =
      sessions.find((s) => !s.finished_at && !s.is_canceled) || null;

    const schRes = await pool.query(
      `
      SELECT
        s.*,
        tp.title AS point_title,
        um.full_name AS mentor_name
      FROM internship_schedules s
      LEFT JOIN trade_points tp ON tp.id = s.trade_point_id
      LEFT JOIN users um ON um.id = s.mentor_user_id
     WHERE s.candidate_id = $1
  AND (
    ($2::bigint IS NOT NULL AND s.session_id = $2)
    OR ($2::bigint IS NULL AND s.status = 'planned')
  )
ORDER BY
  CASE
    WHEN $2::bigint IS NOT NULL AND s.session_id = $2 THEN 0
    WHEN s.status = 'planned' THEN 1
    ELSE 2
  END,
  s.id DESC
LIMIT 1

      `,
      [candidateId, activeInternshipSession?.id ?? null],
    );

    schedule = schRes.rows[0] || null;
  }

  // режим "СТАЖЁР":
  // - для status='intern' всегда считаем стажёром
  // - для status='internship_invited' — стажёрский режим включаем только если уже есть сессии
  let isTraineeMode =
    cand.status === "intern" ||
    (cand.status === "internship_invited" &&
      (activeInternshipSession !== null || finishedInternshipCount > 0));

  // ✅ форсируем режим карточки, когда открываем через переключатель "📋 открыть другую карточку"
  // options.forceMode: 'candidate' | 'trainee'
  if (options.forceMode === "candidate") isTraineeMode = false;
  if (options.forceMode === "trainee") isTraineeMode = true;

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
    : getCandidateHeader(displayStatus);

  // 🔻 Заголовок в режиме изменения (только роль: кандидат/стажёр)
  const editHeaderBase = isTraineeMode ? "🔻 СТАЖЁР" : "🔻 КАНДИДАТ";

  let header = isRestoreMode
    ? "🔻 КАНДИДАТ — ВОССТАНОВЛЕНИЕ (♻️)"
    : isEditMode
      ? `${editHeaderBase} — РЕЖИМ ИЗМЕНЕНИЯ (✏️)`
      : normalHeader;

  // ✅ если нужно переопределить заголовок (например "ЭТАП ПРОЙДЕН")
  if (options.headerOverride) header = options.headerOverride;

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
  text += "────────────────────────\n";

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
  text += "────────────────────────\n";

  // 📅 О собеседовании / Итоги собеседования
  if (!isTraineeMode) {
    if (displayStatus === "internship_invited" || displayStatus === "intern") {
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

    text += "────────────────────────\n";
    text += "ПРИЧИНА ОТКАЗА ❌\n";
    text += `Причина: ${reason}\n\n`;
  }

  if (!isTraineeMode) {
    // 🔹 Замечания — только если собес уже прошёл / стажировка
    if (
      displayStatus === "interviewed" ||
      displayStatus === "internship_invited"
    ) {
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
        text += "────────────────────────\n";
      } else {
        text += "• *Другие замечания:* замечаний нет\n";
        text += "────────────────────────\n";
      }
    }
  }

  // 🔹 О стажировке:
  // - в режиме СТАЖЁР: показываем либо активную стажировку (как раньше),
  //   либо итоговую сводку (пройдено X, следующая назначена/не назначена)
  // - в режиме КАНДИДАТ: как раньше, но НЕ в режиме "этап пройден"
  const isPassedCandidateView =
    options.forceMode === "candidate" &&
    options.headerOverride === "🔻 КАНДИДАТ — (ЭТАП ПРОЙДЕН)";

  if (isTraineeMode) {
    text += "🔹 *О стажировке*\n";

    if (activeInternshipSession) {
      // идёт стажировка — берём данные из internship_schedules (started → planned fallback)
      const planDate = schedule?.planned_date || cand.internship_date || null;
      const planFrom =
        schedule?.planned_time_from || cand.internship_time_from || null;
      const planTo =
        schedule?.planned_time_to || cand.internship_time_to || null;

      const planPointTitle =
        schedule?.point_title ||
        cand.internship_point_title ||
        cand.place_title ||
        "не указано";

      const planMentorName =
        schedule?.mentor_name || cand.internship_admin_name || "не указан";

      if (planDate) {
        const dateLabel = formatDateWithWeekday(planDate);
        if (planFrom && planTo) {
          text += `• *Дата стажировки:* ${dateLabel} (с ${String(
            planFrom,
          ).slice(0, 5)} до ${String(planTo).slice(0, 5)})\n`;
        } else {
          text += `• *Дата стажировки:* ${dateLabel}\n`;
        }
      } else {
        text += "• *Дата стажировки:* не указана\n";
      }

      text += `• *Место стажировки:* ${planPointTitle}\n`;
      text += `• *Ответственный по стажировке:* ${planMentorName}\n\n`;
    } else {
      // стажировка завершена (нет активной сессии)
      text += `• *Пройденных стажировок:* ${finishedInternshipCount}\n\n`;

      // общий % изученного (как в "данные стажировок")
      if (lkUserId) {
        try {
          const userMetaRes = await pool.query(
            `SELECT training_completed_at, post_training_can_work_under_control
       FROM users WHERE id = $1`,
            [lkUserId],
          );
          const trainingCompletedAt =
            userMetaRes.rows[0]?.training_completed_at || null;
          const canWorkUnderControl =
            userMetaRes.rows[0]?.post_training_can_work_under_control; // boolean|null

          const totalStepsRes = await pool.query(
            `SELECT COUNT(*)::int AS cnt FROM internship_steps`,
          );
          const totalSteps = totalStepsRes.rows[0]?.cnt || 0;

          let overallPercent = 0;
          if (totalSteps > 0) {
            const passedAllRes = await pool.query(
              `
        SELECT COUNT(DISTINCT r.step_id)::int AS cnt
        FROM internship_step_results r
        JOIN internship_sessions s ON s.id = r.session_id
        WHERE s.user_id = $1
          AND s.is_canceled = FALSE
          AND r.is_passed = TRUE
        `,
              [lkUserId],
            );
            const passedAll = passedAllRes.rows[0]?.cnt || 0;
            overallPercent = Math.round((passedAll / totalSteps) * 100);
          }

          // если академия уже поставила метку завершения — считаем курс пройденным
          if (trainingCompletedAt) overallPercent = 100;

          text += `• *общий % изученного:* ${overallPercent}%\n`;

          if (overallPercent >= 100) {
            if (canWorkUnderControl === false) {
              text += `• *Курс пройден, но стажёр пока не может работать самостоятельно под контролем*\n`;
            } else if (canWorkUnderControl === true) {
              text += `• *Курс пройден: работа самостоятельно под контролем*\n`;
            } else {
              text += `• *Курс пройден, но режим контроля не выбран наставником*\n`;
            }
          }

          text += `\n`;
        } catch (e) {
          // не ломаем карточку, если где-то нет таблиц/данных
        }
      }

      // Следующая стажировка показывается ТОЛЬКО если есть planned в internship_schedules
      const nextDate =
        schedule?.status === "planned" ? schedule?.planned_date : null;
      const nextFrom =
        schedule?.status === "planned" ? schedule?.planned_time_from : null;
      const nextTo =
        schedule?.status === "planned" ? schedule?.planned_time_to : null;

      if (nextDate) {
        const dateLabel = formatDateWithWeekday(nextDate);

        const placeTitle = schedule?.point_title || "не указано";
        const mentorName = schedule?.mentor_name || "не указан";

        text += `*Следующая стажировка:*\n`;

        if (nextFrom && nextTo) {
          text += `• *Дата стажировки:* ${dateLabel} (с ${String(
            nextFrom,
          ).slice(0, 5)} до ${String(nextTo).slice(0, 5)})\n`;
        } else {
          text += `• *Дата стажировки:* ${dateLabel}\n`;
        }

        text += `• *Место стажировки:* ${placeTitle}\n`;
        text += `• *Ответственный по стажировке:* ${mentorName}\n`;
      } else {
        text += "*Следующая стажировка:*\n• _пока не назначена_\n";
      }

      text +=
        "\n_Чтобы узнать подробнее о предыдущих\nстажировках, нажмите:_\n|📊*успеваемость*|➔|🌱*данные стаж..*|\n";
    }
  } else {
    // Кандидатская карточка (как раньше), но НЕ "этап пройден"
    if (
      !isPassedCandidateView &&
      (displayStatus === "internship_invited" || displayStatus === "intern")
    ) {
      text += "🔹 *О стажировке*\n";
      // Вариант B: если следующая стажировка уже назначена — показываем её
      if (isInternshipScheduled) {
        const dateLabel = formatDateWithWeekday(cand.internship_date);
        if (cand.internship_time_from && cand.internship_time_to) {
          text += `• *Дата стажировки:* ${dateLabel} (с ${cand.internship_time_from.slice(
            0,
            5,
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
  }

  // Кнопки
  const rows = [];
  // Если мы открыли кандидатскую карточку через меню карточек,

  // --- SUBSCREEN: настройки стажёра ---
  if (options.internSubscreen === "settings") {
    rows.push([
      Markup.button.callback(
        "⬆️ Повысить до сотрудника",
        `lk_intern_settings_promote_${cand.id}`,
      ),
    ]);

    const lkEnabled = !!cand.lk_user_lk_enabled;

    rows.push([
      Markup.button.callback(
        lkEnabled ? "🔒 Закрыть доступ в ЛК" : "🔓 Открыть доступ в ЛК",
        lkEnabled
          ? `lk_intern_settings_close_lk_${cand.id}`
          : `lk_intern_settings_open_lk_${cand.id}`,
      ),
    ]);

    rows.push([
      Markup.button.callback(
        "✏️ Изменить карточку",
        `lk_intern_settings_edit_${cand.id}`,
      ),
    ]);

    rows.push([
      Markup.button.callback(
        "❌ Отказать стажёру",
        `lk_intern_settings_decline_${cand.id}`,
      ),
    ]);

    rows.push([
      Markup.button.callback(
        "📋 Открыть другую карточку",
        `lk_internship_open_cards_${cand.id}`,
      ),
    ]);

    rows.push([
      Markup.button.callback(
        "⬅️ Назад к карточке",
        `lk_intern_settings_back_${cand.id}`,
      ),
    ]);

    const kb = Markup.inlineKeyboard(rows);

    // доставляем карточку с текущим текстом, но с новым меню настроек
    if (!deliverFn) {
      if (edit && ctx.updateType === "callback_query") {
        await ctx
          .editMessageText(text, { ...kb, parse_mode: "Markdown" })

          .catch(() => {});
      } else {
        await ctx.reply(text, { ...kb, parse_mode: "Markdown" });
      }
      return;
    }

    await deliverFn(
      ctx,
      { text, extra: { ...kb, parse_mode: "Markdown" } },
      { edit },
    );

    return;
  }

  // и меню сейчас раскрыто — показываем именно меню (2 строки).
  const cardsExpanded = isTraineeCardsExpanded(ctx.from.id);
  const viewMode = options.cardsViewMode || "trainee";

  const isCardsSwitcherView =
    cardsExpanded &&
    (options.forceMode === "candidate" || options.forceMode === "trainee");

  if (isCardsSwitcherView) {
    const candBtnText = viewMode === "candidate" ? "✅ Кандидат" : "Кандидат";
    const trBtnText = viewMode === "trainee" ? "✅ Стажёр" : "Стажёр";

    rows.push([
      Markup.button.callback(
        "▾карточки (скрыть)",
        `lk_internship_toggle_cards_${cand.id}`,
      ),
    ]);

    rows.push([
      Markup.button.callback(
        candBtnText,
        `lk_cards_switch_candidate_${cand.id}`,
      ),
      Markup.button.callback(trBtnText, `lk_cards_switch_trainee_${cand.id}`),
      Markup.button.callback("Сотрудник", `lk_cards_switch_worker_${cand.id}`),
    ]);

    // IMPORTANT: дальше НЕ добавляем остальные кнопки (начать/отказать/настройки),
    // но "Настройки" и "К кандидатам" ты хочешь видеть при скрытии, не здесь.
    // Поэтому просто пропускаем основной блок кнопок:
  } else {
    if (cand.status === "invited") {
      // Ещё не было собеса
      rows.push([
        Markup.button.callback(
          "✅ Собеседование пройдено",
          `lk_cand_passed_${cand.id}`,
        ),
      ]);
      rows.push([
        Markup.button.callback(
          "❌ отказать кандидату",
          `lk_cand_decline_reason_${cand.id}`,
        ),
      ]);
    } else if (cand.status === "interviewed") {
      // Собеседование проведено, можно пригласить на стажировку или отказать
      rows.push([
        Markup.button.callback(
          "✅ пригласить на стажировку",
          `lk_cand_invite_${cand.id}`,
        ),
      ]);
      rows.push([
        Markup.button.callback(
          "❌ отказать кандидату",
          `lk_cand_decline_reason_${cand.id}`,
        ),
      ]);
    } else if (
      displayStatus === "internship_invited" ||
      displayStatus === "intern"
    ) {
      // приглашён / стажировка в процессе
      if (isTraineeMode) {
        const mentorTgIdRaw = cand.internship_admin_tg_id;
        const mentorTgId =
          mentorTgIdRaw === null || mentorTgIdRaw === undefined
            ? null
            : Number(mentorTgIdRaw);

        const isMentor =
          isAdmin &&
          // если назначен конкретный наставник — пускаем только его
          (cand.internship_admin_id
            ? me.id === cand.internship_admin_id
            : true);

        // 1) Перейти к обучению / ⏺️ завершить стажировку / идёт обучение
        if (activeInternshipSession) {
          if (isMentor) {
            // если курс уже пройден — завершаем стажировку прямо в ЛК-боте
            if (trainingCompletedAt) {
              rows.push([
                Markup.button.callback(
                  "⏺️ завершить стажировку",
                  `lk_internship_finish_${cand.id}`,
                ),
              ]);
            } else {
              rows.push([
                Markup.button.url(
                  "⏺️ Перейти к обучению",
                  "https://t.me/baristaAcademy_GR_bot",
                ),
              ]);
            }
          } else {
            rows.push([
              Markup.button.callback(
                "⏺️ идёт обучение",
                `lk_internship_training_locked_${cand.id}`,
              ),
            ]);
          }
          if (activeShift) {
            rows.push([
              Markup.button.callback(
                "📝 задачи смены",
                `lk_intern_shift_tasks_${cand.id}`,
              ),
            ]);
          }
        } else {
          // Итоговая карточка: либо назначаем, либо начинаем (но не обе кнопки сразу)
          // Решаем только по internship_schedules.status='planned' (без candidates.internship_*)
          const hasPlannedNext =
            schedule?.status === "planned" && !!schedule?.planned_date;

          if (!hasPlannedNext) {
            rows.push([
              Markup.button.callback(
                "🗓 назначить стажировку",
                `lk_cand_invite_${cand.id}`,
              ),
            ]);
          } else if (isMentor) {
            rows.push([
              Markup.button.callback(
                "▶️ начать стажировку",
                `lk_cand_start_intern_${cand.id}`,
              ),
            ]);
          }
        }

        // 2) 📊 успеваемость (заглушка-экран)

        rows.push([
          Markup.button.callback("📊 успеваемость", `lk_perf_menu_${cand.id}`),
        ]);
      } else {
        // Если это кандидатская карточка, открытая через "открыть другую карточку" (этап пройден),
        // то не показываем "начать стажировку/отказать" — оставляем только переходы.
        const isPassedCandidateView =
          options.forceMode === "candidate" &&
          options.headerOverride === "🔻 КАНДИДАТ — (ЭТАП ПРОЙДЕН)";

        if (isPassedCandidateView) {
          // вместо кандидата-экшнов — только "открыть другую карточку"
          rows.push([
            Markup.button.callback(
              "📋 открыть другую карточку",
              `lk_internship_open_cards_${cand.id}`,
            ),
          ]);
        } else {
          // старый режим: просто приглашён, ещё не начинали
          rows.push([
            Markup.button.callback(
              "▶️ начать стажировку",
              `lk_cand_start_intern_${cand.id}`,
            ),
          ]);
          rows.push([
            Markup.button.callback(
              "❌ отказать кандидату",
              `lk_cand_decline_reason_${cand.id}`,
            ),
          ]);
        }
      }
    } else if (cand.status === "rejected") {
      // Кандидат отклонён
      rows.push([
        Markup.button.callback(
          "♻️ восстановить кандидата",
          `lk_cand_restore_${cand.id}`,
        ),
      ]);

      if (cand.is_deferred) {
        rows.push([
          Markup.button.callback(
            "↩️🗑️ убрать из отложенных",
            `lk_cand_unpostpone_${cand.id}`,
          ),
        ]);
      } else {
        rows.push([
          Markup.button.callback(
            "🗑️ перенести в отложенные",
            `lk_cand_postpone_${cand.id}`,
          ),
        ]);
      }
    }
  }

  // Общие кнопки
  rows.push([
    isTraineeMode
      ? Markup.button.callback("⚙️ настройки", `lk_intern_settings_${cand.id}`)
      : Markup.button.callback("⚙️ Настройки", `lk_cand_settings_${cand.id}`),
  ]);
  rows.push([
    // если карточка сейчас в режиме стажёра — всегда возвращаем "к стажёрам"
    isTraineeMode
      ? Markup.button.callback("◀️ К стажёрам", "admin_users_interns")
      : options.backTo === "interns"
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
          keyboard.reply_markup,
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
    { edit },
  );
}

// регистрируем хендлеры, связанные с карточкой
function registerCandidateCard(bot, ensureUser, logError, deliver) {
  deliverFn = deliver;
  ensureUserFn = ensureUser;

  // 📋 открыть другую карточку -> раскрываем меню карточек (используем общий toggle)
  bot.action(/^lk_internship_open_cards_(\d+)$/, async (ctx) => {
    try {
      const candId = Number(ctx.match[1]);
      traineeCardsExpandedByTgId.set(ctx.from.id, true);
      // ничего не меняем: текущий view остаётся прежним (по умолчанию trainee)
      await ctx.answerCbQuery().catch(() => {});
      const view = getTraineeCardsView(ctx.from.id);
      if (view === "candidate") {
        await showCandidateCardLk(ctx, candId, {
          edit: true,
          forceMode: "candidate",
          headerOverride: "🔻 КАНДИДАТ — (ЭТАП ПРОЙДЕН)",
          forceCandidateStatus: "internship_invited",
          cardsViewMode: "candidate",
        });
      } else {
        await showCandidateCardLk(ctx, candId, {
          edit: true,
          forceMode: "trainee",
          cardsViewMode: "trainee",
        });
      }
    } catch (err) {
      logError("lk_internship_open_cards", err);
    }
  });

  // ▾карточки (скрыть) -> сворачиваем меню карточек
  bot.action(/^lk_internship_toggle_cards_(\d+)$/, async (ctx) => {
    try {
      const candidateId = Number(ctx.match[1]);
      toggleTraineeCardsExpanded(ctx.from.id);

      await ctx.answerCbQuery().catch(() => {});

      const view = getTraineeCardsView(ctx.from.id);

      if (view === "candidate") {
        await showCandidateCardLk(ctx, candidateId, {
          edit: true,
          forceMode: "candidate",
          headerOverride: "🔻 КАНДИДАТ — (ЭТАП ПРОЙДЕН)",
          forceCandidateStatus: "internship_invited",
          cardsViewMode: "candidate",
        });
      } else {
        await showCandidateCardLk(ctx, candidateId, {
          edit: true,
          forceMode: "trainee",
          cardsViewMode: "trainee",
        });
      }
    } catch (err) {
      logError("lk_internship_toggle_cards", err);
    }
  });

  // выбрать Кандидат/Стажёр/Сотрудник в меню карточек
  bot.action(
    /^lk_cards_switch_(candidate|trainee|worker)_(\d+)$/,
    async (ctx) => {
      try {
        const mode = ctx.match[1];
        const candId = Number(ctx.match[2]);
        await ctx.answerCbQuery().catch(() => {});

        if (mode === "worker") {
          await ctx
            .answerCbQuery("Пользователь ещё на этапе стажировки", {
              show_alert: false,
            })
            .catch(() => {});
          return;
        }

        // остаёмся в режиме меню карточек (не скрываем)
        traineeCardsExpandedByTgId.set(ctx.from.id, true);
        setTraineeCardsView(
          ctx.from.id,
          mode === "candidate" ? "candidate" : "trainee",
        );

        if (mode === "candidate") {
          await showCandidateCardLk(ctx, candId, {
            edit: true,
            forceMode: "candidate",
            headerOverride: "🔻 КАНДИДАТ — (ЭТАП ПРОЙДЕН)",
            // чтобы текст был как "приглашён на стажировку" (скрин 3)
            forceCandidateStatus: "internship_invited",
            cardsViewMode: "candidate",
          });
          return;
        }

        // mode === "trainee"
        await showCandidateCardLk(ctx, candId, {
          edit: true,
          forceMode: "trainee",
          cardsViewMode: "trainee",
        });
      } catch (err) {
        logError("lk_cards_switch", err);
      }
    },
  );

  // 📊 успеваемость вынесена в отдельный модуль (src/bot/admin/users/performance.js)

  // ⚙️ Настройки стажёра (отдельный экран)
  bot.action(/^lk_intern_settings_(\d+)$/, async (ctx) => {
    try {
      const candidateId = Number(ctx.match[1]);
      await ctx.answerCbQuery().catch(() => {});
      await showCandidateCardLk(ctx, candidateId, {
        edit: true,
        forceMode: "trainee",
        internSubscreen: "settings",
      });
    } catch (err) {
      logError("lk_intern_settings", err);
    }
  });

  // ✏️ Изменить карточку (включаем режим изменения и показываем старые кнопки редактирования)
  bot.action(/^lk_intern_settings_edit_(\d+)$/, async (ctx) => {
    try {
      const candidateId = Number(ctx.match[1]);
      await ctx.answerCbQuery().catch(() => {});
      internEditStates.set(ctx.from.id, candidateId);
      const kb0 = await buildEditSectionsKeyboard(candidateId);

      // заменим последнюю кнопку "назад" на возврат в меню стажёрских настроек
      const rows = kb0.reply_markup.inline_keyboard;
      rows[rows.length - 1] = [
        Markup.button.callback(
          "⬅️ Назад",
          `lk_intern_settings_back_${candidateId}`,
        ),
      ];
      const kb = Markup.inlineKeyboard(rows);

      await showCandidateCardLk(ctx, candidateId, {
        edit: true,
        forceMode: "trainee",
        keyboardOverride: kb,
        editMode: true,
      });
    } catch (err) {
      logError("lk_intern_settings_edit", err);
    }
  });

  // ❌ Отказать стажёру (пока заглушка)
  bot.action(/^lk_intern_settings_decline_(\d+)$/, async (ctx) => {
    try {
      await ctx
        .answerCbQuery("Отказ стажёру — добавим позже", { show_alert: false })
        .catch(() => {});
    } catch (err) {
      logError("lk_intern_settings_decline", err);
    }
  });

  // ⬅️ Назад из настроек -> карточка стажёра
  bot.action(/^lk_intern_settings_back_(\d+)$/, async (ctx) => {
    try {
      const candidateId = Number(ctx.match[1]);
      await ctx.answerCbQuery().catch(() => {});
      await showCandidateCardLk(ctx, candidateId, {
        edit: true,
        forceMode: "trainee",
      });
    } catch (err) {
      logError("lk_intern_settings_back", err);
    }
  });

  bot.action(/^lk_intern_settings_open_lk_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin"))
        return;

      const candidateId = Number(ctx.match[1]);

      // найдём привязанного юзера (стажёра)
      const r = await pool.query(
        `
        SELECT u.id AS user_id, u.telegram_id
        FROM users u
        WHERE u.candidate_id = $1
        LIMIT 1
        `,
        [candidateId],
      );

      const u = r.rows[0];
      if (!u?.user_id || !u?.telegram_id) {
        await ctx.reply("❌ Не найден привязанный пользователь (telegram_id).");
        return;
      }

      // ✅ включаем доступ в ЛК
      await pool.query(`UPDATE users SET lk_enabled = true WHERE id = $1`, [
        u.user_id,
      ]);

      // уведомление стажёру
      await ctx.telegram.sendMessage(
        Number(u.telegram_id),
        "✅ Доступ в личный кабинет открыт.\n\nНажмите кнопку ниже или отправьте /start.",
        Markup.inlineKeyboard([
          [
            Markup.button.callback(
              "🏠 Перейти в личный кабинет",
              "lk_open_menu",
            ),
          ],
        ]),
      );

      await ctx
        .answerCbQuery("✅ Доступ в ЛК открыт", { show_alert: false })
        .catch(() => {});

      // обновим экран настроек (остаемся в карточке стажёра → настройки)
      await showCandidateCardLk(ctx, candidateId, {
        edit: true,
        forceMode: "trainee",
        internSubscreen: "settings",
      });
    } catch (err) {
      logError("lk_intern_settings_open_lk", err);
    }
  });

  bot.action(/^lk_intern_settings_close_lk_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin"))
        return;

      const candidateId = Number(ctx.match[1]);

      const r = await pool.query(
        `
      SELECT u.id AS user_id, u.telegram_id
      FROM users u
      WHERE u.candidate_id = $1
      LIMIT 1
      `,
        [candidateId],
      );

      const u = r.rows[0];
      if (!u?.user_id) {
        await ctx
          .answerCbQuery("❌ Не найден привязанный пользователь", {
            show_alert: false,
          })
          .catch(() => {});
        return;
      }

      await pool.query(`UPDATE users SET lk_enabled = false WHERE id = $1`, [
        u.user_id,
      ]);

      if (u.telegram_id) {
        await ctx.telegram
          .sendMessage(
            Number(u.telegram_id),
            "🔒 Доступ в личный кабинет закрыт.",
          )
          .catch(() => {});
      }

      await ctx
        .answerCbQuery("🔒 Доступ в ЛК закрыт", { show_alert: false })
        .catch(() => {});

      await showCandidateCardLk(ctx, candidateId, {
        edit: true,
        forceMode: "trainee",
        internSubscreen: "settings",
      });
    } catch (err) {
      logError("lk_intern_settings_close_lk", err);
    }
  });

  bot.action(/^lk_intern_settings_promote_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin"))
        return;

      const candidateId = Number(ctx.match[1]);

      const text =
        "⬆️ Повышение до сотрудника\n\n" +
        "Повышаем только тогда, когда стажёр уже может работать полностью самостоятельно без контроля наставника.\n\n" +
        "⚠️ Важно: если курс стажёра в Академии не завершён — повысить нельзя.\n" +
        "⚠️ Важно: если сейчас идёт активная сессия стажировки — повысить нельзя.";

      await deliver(
        ctx,
        {
          text,
          extra: Markup.inlineKeyboard([
            [
              Markup.button.callback(
                "⬆️ Повысить",
                `lk_intern_settings_promote_apply_${candidateId}`,
              ),
            ],
            [
              Markup.button.callback(
                "⬅️ Назад",
                `lk_intern_settings_back_${candidateId}`,
              ),
            ],
          ]),
        },
        { edit: true },
      );
    } catch (err) {
      logError("lk_intern_settings_promote", err);
    }
  });

  function phoneForTelegramLocal(raw) {
    const s = String(raw || "").trim();
    if (!s) return null;
    let cleaned = s.replace(/[^\d+]/g, "");
    if (/^8\d{10}$/.test(cleaned)) cleaned = "+7" + cleaned.slice(1);
    if (/^7\d{10}$/.test(cleaned)) cleaned = "+7" + cleaned.slice(1);
    return cleaned;
  }

  async function renderWorkerCardAfterPromote(ctx, workerId) {
    const res = await pool.query(
      `
      SELECT
        u.id,
        u.full_name,
        u.role,
        u.staff_status,
        u.position,
        u.work_phone,
        u.username,
        c.age AS age
      FROM users u
      LEFT JOIN candidates c ON c.id = u.candidate_id
      WHERE u.id = $1
      LIMIT 1
      `,
      [workerId],
    );

    if (!res.rows.length) {
      await ctx
        .answerCbQuery("✅ Повышено, но карточка сотрудника не найдена", {
          show_alert: false,
        })
        .catch(() => {});
      return;
    }

    const u = res.rows[0];

    const roleLabels = {
      super_admin: "супер-админ",
      admin: "админ",
      worker: "сотрудник",
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
    const positionText = u.position || "бариста";
    const normalizedPhone = phoneForTelegramLocal(u.work_phone);
    const phoneText = normalizedPhone || u.work_phone || "не указан";
    const usernameText = u.username ? `@${u.username}` : "не указан";

    const header = (statusLabels[u.staff_status] || "сотрудник").toUpperCase();
    const sep = "────────────────────────────";

    const nameWithAge = `${u.full_name || "не указано"}${
      u.age ? ` (${u.age})` : ""
    }`;

    const text =
      `🔻 <b>${escHtml(header)}</b>\n${sep}\n` +
      `🔹 <b>Общая информация</b>\n` +
      `• <b>Имя:</b> ${escHtml(nameWithAge)}\n` +
      `• <b>Роль:</b> ${escHtml(roleText)}\n` +
      `• <b>Статус:</b> ${escHtml(statusText)}\n` +
      `• <b>Должность:</b> ${escHtml(positionText)}\n` +
      `• <b>Телефон:</b> ${escHtml(phoneText)}\n` +
      `• <b>Username:</b> ${escHtml(usernameText)}\n` +
      `${sep}\n` +
      `🔹 <b>О работе</b>\n` +
      `• <b>Следующая смена:</b> в разработке`;

    const rows = [
      [Markup.button.callback("💼 Работа", `lk_worker_work_stub_${u.id}`)],
      [
        Markup.button.callback(
          "📊 успеваемость",
          `lk_worker_performance_${u.id}`,
        ),
      ],
      [Markup.button.callback("⚙️ Настройки", `admin_worker_settings_${u.id}`)],
      [Markup.button.callback("⬅️ К сотрудникам", "admin_users_workers")],
    ];

    await deliver(
      ctx,
      { text, extra: { ...Markup.inlineKeyboard(rows), parse_mode: "HTML" } },
      { edit: true },
    );
  }

  bot.action(/^lk_intern_settings_promote_apply_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin"))
        return;

      const candidateId = Number(ctx.match[1]);

      // 1) находим связанного пользователя
      const r = await pool.query(
        `
        SELECT id AS user_id, telegram_id, staff_status, training_completed_at
        FROM users
        WHERE candidate_id = $1
        LIMIT 1
        `,
        [candidateId],
      );
      const u = r.rows[0];
      if (!u?.user_id) {
        await ctx
          .answerCbQuery("❌ Не найден привязанный пользователь", {
            show_alert: false,
          })
          .catch(() => {});
        return;
      }

      // уже сотрудник
      if (u.staff_status === "employee") {
        await renderWorkerCardAfterPromote(ctx, u.user_id);
        return;
      }

      // 2) нельзя повышать, если идёт активная сессия стажировки
      const act = await pool.query(
        `
        SELECT id
        FROM internship_sessions
        WHERE user_id = $1
          AND finished_at IS NULL
          AND is_canceled = FALSE
        ORDER BY id DESC
        LIMIT 1
        `,
        [u.user_id],
      );
      if (act.rows.length) {
        await ctx
          .answerCbQuery(
            "❌ Нельзя повысить: сейчас идёт активная стажировка",
            {
              show_alert: false,
            },
          )
          .catch(() => {});
        return;
      }

      // 3) нельзя повышать, пока не завершён курс стажёра
      if (!u.training_completed_at) {
        await ctx
          .answerCbQuery(
            "❌ Нельзя повысить: сначала нужно пройти курс стажёра в Академии",
            { show_alert: false },
          )
          .catch(() => {});
        return;
      }

      // 4) повышаем
      await pool.query(
        `UPDATE users SET staff_status = 'employee' WHERE id = $1`,
        [u.user_id],
      );

      if (u.telegram_id) {
        await ctx.telegram
          .sendMessage(
            Number(u.telegram_id),
            "🎉 Вы повышены до сотрудника!\n\nДоступ к функциям сотрудника открыт.",
          )
          .catch(() => {});
      }

      await ctx
        .answerCbQuery("✅ Повышен до сотрудника", { show_alert: false })
        .catch(() => {});

      // 5) сразу открываем карточку сотрудника
      await renderWorkerCardAfterPromote(ctx, u.user_id);
    } catch (err) {
      logError("lk_intern_settings_promote_apply", err);
    }
  });

  // не кликабельные заголовки меню
  bot.action(/^lk_noop$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
  });

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

  async function buildEditSectionsKeyboard(candidateId) {
    const r = await pool.query(`SELECT status FROM candidates WHERE id = $1`, [
      candidateId,
    ]);
    if (!r.rows.length)
      return Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "⬅️ Назад",
            `lk_cand_settings_back_${candidateId}`,
          ),
        ],
      ]);

    const status = r.rows[0].status;
    const rows = [];

    rows.push([
      Markup.button.callback(
        "Общая информация (изменить)",
        `lk_cand_edit_common_${candidateId}`,
      ),
    ]);

    if (status === "invited") {
      rows.push([
        Markup.button.callback(
          "О собеседовании (изменить)",
          `lk_cand_edit_interview_${candidateId}`,
        ),
      ]);
    } else if (status === "internship_invited" || status === "intern") {
      rows.push([
        Markup.button.callback(
          "О стажировке (изменить)",
          `lk_cand_edit_internship_${candidateId}`,
        ),
      ]);
    }

    rows.push([
      Markup.button.callback(
        "Другое (изменить)",
        `lk_cand_settings_other_${candidateId}`,
      ),
    ]);

    // универсальный "назад": для стажёра будем использовать lk_intern_settings_back
    rows.push([
      Markup.button.callback(
        "⬅️ Назад",
        `lk_cand_settings_back_${candidateId}`,
      ),
    ]);

    return Markup.inlineKeyboard(rows);
  }

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
        [candidateId],
      );

      const kb = await buildEditSectionsKeyboard(candidateId);
      await showCandidateCardLk(ctx, candidateId, {
        edit: true,
        keyboardOverride: kb,
        editMode: true,
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

  // ⏺️ завершить стажировку (для наставника, когда курс уже пройден)
  bot.action(/^lk_internship_finish_(\d+)$/, async (ctx) => {
    try {
      const candId = Number(ctx.match[1]);
      await ctx.answerCbQuery().catch(() => {});

      const me = await ensureUser(ctx);
      if (!me || (me.role !== "admin" && me.role !== "super_admin")) return;

      const text =
        "⏺️ Завершение стажировки\n\n" +
        "Подтвердите завершение активной сессии стажировки.";

      const kb = Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "✅ завершить",
            `lk_internship_finish_confirm_${candId}`,
          ),
        ],
        [Markup.button.callback("⬅️ отмена", `lk_cand_open_${candId}`)],
      ]);

      await deliver(ctx, { text, extra: kb }, { edit: true });
    } catch (err) {
      logError("lk_internship_finish", err);
    }
  });

  bot.action(/^lk_internship_finish_confirm_(\d+)$/, async (ctx) => {
    try {
      const candId = Number(ctx.match[1]);
      await ctx.answerCbQuery().catch(() => {});

      const me = await ensureUser(ctx);
      if (!me || (me.role !== "admin" && me.role !== "super_admin")) return;

      // user_id по кандидату
      const ur = await pool.query(
        `SELECT id FROM users WHERE candidate_id = $1 LIMIT 1`,
        [candId],
      );
      const userId = ur.rows[0]?.id;
      if (!userId) {
        await ctx
          .answerCbQuery("❌ Пользователь не привязан", { show_alert: false })
          .catch(() => {});
        await showCandidateCardLk(ctx, candId, {
          edit: true,
          forceMode: "trainee",
        });
        return;
      }

      // активная сессия
      const sr = await pool.query(
        `
        SELECT id
        FROM internship_sessions
        WHERE user_id = $1
          AND finished_at IS NULL
          AND is_canceled = FALSE
        ORDER BY id DESC
        LIMIT 1
        `,
        [userId],
      );

      const sessionId = sr.rows[0]?.id;
      if (!sessionId) {
        await ctx
          .answerCbQuery("⚠️ Активная стажировка не найдена", {
            show_alert: false,
          })
          .catch(() => {});
        await showCandidateCardLk(ctx, candId, {
          edit: true,
          forceMode: "trainee",
        });
        return;
      }

      // закрываем
      await pool.query(
        `UPDATE internship_sessions SET finished_at = NOW() WHERE id = $1`,
        [sessionId],
      );

      // помечаем schedule завершённым (если есть)
      await pool.query(
        `UPDATE internship_schedules SET status = 'finished' WHERE session_id = $1`,
        [sessionId],
      );

      await ctx
        .answerCbQuery("✅ Стажировка завершена", { show_alert: false })
        .catch(() => {});

      await showCandidateCardLk(ctx, candId, {
        edit: true,
        forceMode: "trainee",
      });
    } catch (err) {
      logError("lk_internship_finish_confirm", err);
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

  // 🌱 данные стажировок — основной экран (части) + переключение в дни
  bot.action(/^lk_internship_data_(\d+)$/, async (ctx) => {
    try {
      const candId = Number(ctx.match[1]);
      await ctx.answerCbQuery().catch(() => {});

      internshipDataStateByTgId.set(ctx.from.id, {
        candId,
        mode: "parts",
        selectedDay: null,
        selectedPartId: null,
      });

      await renderLkInternshipData(ctx, candId, { edit: true });
    } catch (err) {
      logError("lk_internship_data", err);
    }
  });

  bot.action(/^lk_internship_data_back_(\d+)$/, async (ctx) => {
    try {
      const candId = Number(ctx.match[1]);
      await ctx.answerCbQuery().catch(() => {});
      await showCandidateCardLk(ctx, candId, { edit: true });
    } catch (err) {
      logError("lk_internship_data_back", err);
    }
  });

  // ▾/▴ Подробнее по дням (toggle)
  bot.action(/^lk_internship_data_toggle_days_(\d+)$/, async (ctx) => {
    try {
      const candId = Number(ctx.match[1]);
      await ctx.answerCbQuery().catch(() => {});
      const st = internshipDataStateByTgId.get(ctx.from.id) || {
        candId,
        mode: "parts",
      };

      const nextMode =
        st.mode === "days" || st.mode === "day" ? "parts" : "days";
      internshipDataStateByTgId.set(ctx.from.id, {
        ...st,
        candId,
        mode: nextMode,
        selectedPartId: null,
      });

      await renderLkInternshipData(ctx, candId, { edit: true });
    } catch (err) {
      logError("lk_internship_data_toggle_days", err);
    }
  });

  // выбор дня (внутри режима "days") — меняем ТЕКСТ на данные дня, но кнопки дней остаются
  bot.action(/^lk_internship_data_day_(\d+)_(\d+)$/, async (ctx) => {
    try {
      const candId = Number(ctx.match[1]);
      const dayNumber = Number(ctx.match[2]);
      await ctx.answerCbQuery().catch(() => {});

      const st = internshipDataStateByTgId.get(ctx.from.id) || {
        candId,
        mode: "days",
      };
      internshipDataStateByTgId.set(ctx.from.id, {
        ...st,
        candId,
        mode: "day",
        selectedDay: dayNumber,
        selectedPartId: null,
      });

      await renderLkInternshipData(ctx, candId, { edit: true });
    } catch (err) {
      logError("lk_internship_data_day", err);
    }
  });

  // выбор части — режим просмотра этапов (view-only)
  bot.action(/^lk_internship_data_part_(\d+)_(\d+)$/, async (ctx) => {
    try {
      const candId = Number(ctx.match[1]);
      const partId = Number(ctx.match[2]);
      await ctx.answerCbQuery().catch(() => {});

      const st = internshipDataStateByTgId.get(ctx.from.id) || {
        candId,
        mode: "parts",
      };
      internshipDataStateByTgId.set(ctx.from.id, {
        ...st,
        candId,
        mode: "part",
        selectedPartId: partId,
      });

      await renderLkInternshipData(ctx, candId, { edit: true });
    } catch (err) {
      logError("lk_internship_data_part", err);
    }
  });

  // ⬅️ к списку частей
  bot.action(/^lk_internship_data_part_back_(\d+)$/, async (ctx) => {
    try {
      const candId = Number(ctx.match[1]);
      await ctx.answerCbQuery().catch(() => {});
      const st = internshipDataStateByTgId.get(ctx.from.id) || {
        candId,
        mode: "parts",
      };

      internshipDataStateByTgId.set(ctx.from.id, {
        ...st,
        candId,
        mode: "parts",
        selectedPartId: null,
      });

      await renderLkInternshipData(ctx, candId, { edit: true });
    } catch (err) {
      logError("lk_internship_data_part_back", err);
    }
  });

  // клик по этапу в режиме просмотра части
  // клик по этапу в режиме просмотра части
  bot.action(/^lk_internship_data_step_(\d+)_(\d+)_(\d+)$/, async (ctx) => {
    try {
      const stepId = Number(ctx.match[1]);
      const candId = Number(ctx.match[2]);
      const partId = Number(ctx.match[3]);
      // достаём user_id по кандидату
      const uRes = await pool.query(
        `
        SELECT u.id AS user_id
        FROM candidates c
        LEFT JOIN users u ON u.candidate_id = c.id
        WHERE c.id = $1
        LIMIT 1
        `,
        [candId],
      );
      const userId = uRes.rows[0]?.user_id;
      if (!userId) {
        await ctx
          .answerCbQuery("Пользователь не привязан", { show_alert: false })
          .catch(() => {});
        return;
      }

      // тип шага
      const stRes = await pool.query(
        `SELECT id, step_type FROM internship_steps WHERE id = $1 LIMIT 1`,
        [stepId],
      );
      const stepType = stRes.rows[0]?.step_type;

      // найдём "факт выполнения" по пользователю (overall): если когда-либо passed=true
      const rRes = await pool.query(
        `
        SELECT r.is_passed, r.media_file_id
        FROM internship_step_results r
        JOIN internship_sessions s ON s.id = r.session_id
        WHERE s.user_id = $1
          AND s.is_canceled = FALSE
          AND r.step_id = $2
        ORDER BY r.is_passed DESC, r.checked_at DESC
        LIMIT 1
        `,
        [userId, stepId],
      );

      const row = rRes.rows[0] || null;
      const isPassed = row?.is_passed === true;

      if (!isPassed) {
        await ctx
          .answerCbQuery("этап ещё не пройден", { show_alert: false })
          .catch(() => {});
        return;
      }

      if (stepType === "photo" || stepType === "video") {
        const fileId = row?.media_file_id;

        // если медиа не прикреплено — просто тост
        if (!fileId) {
          await ctx
            .answerCbQuery("медиа не прикреплено", { show_alert: false })
            .catch(() => {});
          return;
        }

        // fallback: если вдруг сюда попали (URL-кнопка не отрисовалась), покажем ссылку
        const academyUser =
          process.env.ACADEMY_BOT_USERNAME || "barista_academy_bot";
        const url = `https://t.me/${academyUser}?start=media_${candId}_${stepId}`;

        const kb = Markup.inlineKeyboard([
          [Markup.button.url("📎 Открыть медиа в академии", url)],
          [
            Markup.button.callback(
              "⬅️ Назад к этапам",
              `lk_internship_data_part_${candId}_${partId}`,
            ),
          ],
          [
            Markup.button.callback(
              "⬅️ Назад в карточку",
              `lk_internship_data_back_${candId}`,
            ),
          ],
        ]);

        await ctx.answerCbQuery().catch(() => {});
        await ctx
          .reply("📎 Медиа доступно в академии. Нажмите кнопку ниже:", {
            ...kb,
          })
          .catch(() => {});
        return;
      }

      // simple
      await ctx
        .answerCbQuery("этот этап пройден", { show_alert: false })
        .catch(() => {});
    } catch (err) {
      logError("lk_internship_data_step", err);
      await ctx.answerCbQuery("ошибка", { show_alert: false }).catch(() => {});
    }
  });

  // -------- helpers --------
  function escapeHtml(s) {
    return String(s || "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  async function renderLkInternshipData(ctx, candId, { edit = true } = {}) {
    // 1) кандидат + user_id
    const candRes = await pool.query(
      `
      SELECT
        c.id,
        c.name,
        c.age,
        c.phone,
        u.id AS user_id,
u.post_training_can_work_under_control,
u.training_completed_at
      FROM candidates c
      LEFT JOIN users u ON u.candidate_id = c.id
      WHERE c.id = $1
      LIMIT 1
      `,
      [candId],
    );

    if (!candRes.rows.length) {
      await ctx.reply("Кандидат не найден.");
      return;
    }

    const cand = candRes.rows[0];
    const userId = cand.user_id;

    const st = internshipDataStateByTgId.get(ctx.from.id) || {
      candId,
      mode: "parts",
    };
    const mode = st.mode || "parts";

    // 2) завершённые дни (только finished, без canceled)
    let finishedDays = [];
    if (userId) {
      const sRes = await pool.query(
        `
        SELECT day_number, finished_at, is_canceled
        FROM internship_sessions
        WHERE user_id = $1
        ORDER BY day_number ASC, id ASC
        `,
        [userId],
      );

      const set = new Set();
      for (const s of sRes.rows || []) {
        if (s.is_canceled) continue;
        if (s.finished_at) set.add(Number(s.day_number));
      }
      finishedDays = Array.from(set).sort((a, b) => a - b);
    }

    const finishedCount = finishedDays.length;

    // 3) общий процент изученного (по всем шагам)
    const totalStepsRes = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM internship_steps`,
    );
    const totalSteps = totalStepsRes.rows[0]?.cnt || 0;

    let overallPercent = 0;
    if (userId && totalSteps > 0) {
      const passedAllRes = await pool.query(
        `
        SELECT COUNT(DISTINCT r.step_id)::int AS cnt
        FROM internship_step_results r
        JOIN internship_sessions s ON s.id = r.session_id
        WHERE s.user_id = $1
          AND s.is_canceled = FALSE
          AND r.is_passed = TRUE
        `,
        [userId],
      );
      const passedAll = passedAllRes.rows[0]?.cnt || 0;
      overallPercent = Math.round((passedAll / totalSteps) * 100);
    }

    const agePart = cand.age ? ` (${cand.age})` : "";
    const phonePart = cand.phone ? ` ${escapeHtml(cand.phone)}` : "";

    let internshipName = "🌱 Данные стажировок";

    if (mode === "day") {
      internshipName = `🌱 Данные стажировок — день ${st.selectedDay}`;
    }
    let text =
      `<u><b>${internshipName}</b></u>\n\n` +
      `• Имя: ${escapeHtml(cand.name || "—")}${agePart}${phonePart}\n` +
      `• Всего завершённых стажировок (дней): ${finishedCount}\n`;
    const canWorkUnderControl = cand.post_training_can_work_under_control; // boolean | null

    const overallLine =
      overallPercent >= 100
        ? `• общий процент изученного: 100% ✅\n`
        : `• общий процент изученного: ${overallPercent}%\n`;

    text += overallLine;

    if (overallPercent >= 100) {
      if (canWorkUnderControl === false) {
        text += `• стажёр всё ещё не может работать самостоятельно (полный контроль)\n`;
      } else if (canWorkUnderControl === true) {
        text += `• работа самостоятельно под контролем\n`;
      } else {
        // null — наставник ещё не выбрал режим
        text += `• режим контроля не выбран наставником\n`;
      }
    }

    text += `────────────────────────\n\n`;

    // 4) строим клавиатуру по режимам
    const buttons = [];

    // ---- MODE: parts (дашборд) ----
    if (mode === "parts") {
      text += `Выбери часть, чтобы посмотреть этапы:\n`;

      // список частей с прогрессом done/total по overall
      const partsRes = await pool.query(
        `SELECT id, title, order_index FROM internship_parts ORDER BY order_index ASC, id ASC`,
      );

      for (const p of partsRes.rows || []) {
        const totalRes = await pool.query(
          `SELECT COUNT(*)::int AS cnt FROM internship_steps WHERE part_id = $1`,
          [p.id],
        );
        const total = totalRes.rows[0]?.cnt || 0;

        let done = 0;
        if (userId && total > 0) {
          const doneRes = await pool.query(
            `
            SELECT COUNT(DISTINCT r.step_id)::int AS cnt
            FROM internship_step_results r
            JOIN internship_sessions s ON s.id = r.session_id
            JOIN internship_steps st ON st.id = r.step_id
            WHERE s.user_id = $1
              AND s.is_canceled = FALSE
              AND r.is_passed = TRUE
              AND st.part_id = $2
            `,
            [userId, p.id],
          );
          done = doneRes.rows[0]?.cnt || 0;
        }

        const pct = total > 0 ? Math.round((done / total) * 100) : 0;
        const icon =
          total > 0 && done === total ? "✅" : done > 0 ? "🟡" : "⚪";

        buttons.push([
          Markup.button.callback(
            `${icon} Часть: ${p.title} — ${done}/${total} этапов (${pct}%)`,
            `lk_internship_data_part_${candId}_${p.id}`,
          ),
        ]);
      }

      buttons.push([
        Markup.button.callback(
          "▾ Подробнее по дням",
          `lk_internship_data_toggle_days_${candId}`,
        ),
      ]);

      buttons.push([
        Markup.button.callback(
          "⬅️ назад в карточку",
          `lk_internship_data_back_${candId}`,
        ),
      ]);
    }

    // ---- MODE: days list (раскрытие) ----
    if (mode === "days") {
      // в этом режиме подсказка про части исчезает (как ты просил)
      buttons.push([
        Markup.button.callback(
          "▴ Подробнее по дням",
          `lk_internship_data_toggle_days_${candId}`,
        ),
      ]);

      // кнопки дней (по 3 в ряд)
      const dayBtns = finishedDays.map((d) =>
        Markup.button.callback(
          `${d}дн`,
          `lk_internship_data_day_${candId}_${d}`,
        ),
      );

      for (let i = 0; i < dayBtns.length; i += 3) {
        buttons.push(dayBtns.slice(i, i + 3));
      }

      buttons.push([
        Markup.button.callback(
          "⬅️ назад в карточку",
          `lk_internship_data_back_${candId}`,
        ),
      ]);
    }

    // ---- MODE: конкретный день (текст дня + дни остаются) ----
    if (mode === "day") {
      const dayNumber = Number(st.selectedDay);

      // 1) session выбранного дня
      let session = null;
      if (userId) {
        const sesRes = await pool.query(
          `
          SELECT
            s.*,
            tp.title AS trade_point_title,
            mentor.full_name AS mentor_name,
            mentor.username AS mentor_username
          FROM internship_sessions s
          LEFT JOIN trade_points tp ON tp.id = s.trade_point_id
          LEFT JOIN users mentor ON mentor.id = s.started_by
          WHERE s.user_id = $1
            AND s.day_number = $2
            AND s.is_canceled = FALSE
          ORDER BY s.id DESC
          LIMIT 1
          `,
          [userId, dayNumber],
        );
        session = sesRes.rows[0] || null;
      }

      if (!session) {
        text += `<b>Данные дня ${dayNumber}</b>\n`;
        text += `• День не найден или ещё не завершён\n\n`;
      } else {
        // 2) Комментарии по сессии
        const comRes = await pool.query(
          `
          SELECT id, comment
          FROM internship_session_comments
          WHERE session_id = $1
          ORDER BY id ASC
          `,
          [session.id],
        );

        // 3) план времени из internship_schedules по session_id (fallback на candidates)
        let planTimeText = "не указано";
        try {
          const schRes = await pool.query(
            `
            SELECT planned_time_from, planned_time_to
            FROM internship_schedules
            WHERE session_id = $1
            ORDER BY id DESC
            LIMIT 1
            `,
            [session.id],
          );
          const sch = schRes.rows[0] || null;
          const from = sch?.planned_time_from || cand.internship_time_from;
          const to = sch?.planned_time_to || cand.internship_time_to;
          if (from && to) {
            planTimeText = `с ${String(from).slice(0, 5)} до ${String(to).slice(
              0,
              5,
            )}`;
          }
        } catch (_) {}

        // 4) итог времени
        const fmtTime = (d) =>
          d
            ? new Date(d).toLocaleTimeString("ru-RU", {
                hour: "2-digit",
                minute: "2-digit",
              })
            : "не указано";

        const fmtDate = (d) =>
          d
            ? new Date(d).toLocaleDateString("ru-RU", {
                day: "2-digit",
                month: "2-digit",
              })
            : "не указано";

        const factFrom = session.started_at
          ? fmtTime(session.started_at)
          : "не указано";
        const factTo = session.finished_at
          ? fmtTime(session.finished_at)
          : "не указано";
        const dateLabel = session.started_at
          ? fmtDate(session.started_at)
          : "не указано";

        // 5) наставник
        let mentorLine = session.mentor_name || "не указан";
        if (session.mentor_username)
          mentorLine += ` (@${session.mentor_username})`;

        // 6) % по плану дня N (накопительно)
        const sectionsRes = await pool.query(
          `
          SELECT s.id, s.duration_days, s.order_index, p.order_index AS part_order
          FROM internship_sections s
          JOIN internship_parts p ON p.id = s.part_id
          WHERE s.duration_days IS NOT NULL
          ORDER BY p.order_index ASC, s.order_index ASC
          `,
        );

        const dayToSteps = new Map(); // day -> [step_id]
        let cursorDay = 1;

        for (const sec of sectionsRes.rows) {
          const dur = Number(sec.duration_days || 0);
          if (!dur || dur < 1) continue;

          const stepsRes = await pool.query(
            `
            SELECT id
            FROM internship_steps
            WHERE section_id = $1
            ORDER BY order_index ASC, id ASC
            `,
            [sec.id],
          );
          const stepIds = stepsRes.rows.map((r) => Number(r.id));

          const k = dur;
          const n = stepIds.length;
          let idx = 0;

          for (let i = 0; i < k; i++) {
            const remaining = n - idx;
            const remainingBuckets = k - i;
            const take =
              remainingBuckets > 0
                ? Math.ceil(remaining / remainingBuckets)
                : remaining;

            const chunk = stepIds.slice(idx, idx + take);
            idx += take;

            const d = cursorDay;
            const prev = dayToSteps.get(d) || [];
            dayToSteps.set(d, prev.concat(chunk));

            cursorDay += 1;
          }
        }

        const plannedStepIds = (dayToSteps.get(dayNumber) || []).filter(
          Boolean,
        );
        const plannedTotal = plannedStepIds.length;

        let plannedPassed = 0;
        if (userId && plannedTotal > 0) {
          const passPlanRes = await pool.query(
            `
            SELECT COUNT(DISTINCT r.step_id)::int AS cnt
            FROM internship_step_results r
            JOIN internship_sessions s ON s.id = r.session_id
            WHERE s.user_id = $1
              AND s.is_canceled = FALSE
              AND r.is_passed = TRUE
              AND r.step_id = ANY($2::int[])
            `,
            [userId, plannedStepIds],
          );
          plannedPassed = passPlanRes.rows[0]?.cnt || 0;
        }

        const planPercent =
          plannedTotal > 0
            ? Math.round((plannedPassed / plannedTotal) * 100)
            : 0;
        const planIcon = planPercent >= 100 ? "📈" : "📉";

        // 7) Текст (HTML) — как “старый экран дня”, но внутри 🌱 Данные стажировок
        text += `<b>О стажировке</b>\n`;
        text += `<b>Дата и время стажировки:</b>\n`;
        text += `  • <b>план:</b> ${escapeHtml(dateLabel)} (${escapeHtml(
          planTimeText,
        )})\n`;
        text += `  • <b>итог:</b> ${escapeHtml(dateLabel)} (с ${escapeHtml(
          factFrom,
        )} до ${escapeHtml(factTo)})\n\n`;

        text += `<b>Место стажировки:</b>\n`;
        text += `  • ${escapeHtml(
          session.trade_point_title || "не указано",
        )}\n\n`;

        text += `<b>Ответственный по стажировке:</b>\n`;
        text += `  • ${escapeHtml(mentorLine)}\n\n`;

        text += `<b>Успеваемость стажировки:</b>\n`;
        text += `  • <b>общий процент изученного:</b> ${overallPercent}%\n`;
        if (overallPercent < 100) {
          text += `  • <b>процент по плану дня ${dayNumber}:</b> ${planPercent}% ${planIcon}\n\n`;
        }
        text += `<b>Комментарии по стажировке ${dayNumber}:</b>\n`;
        if (!comRes.rows.length) {
          text += `  — пока нет\n`;
        } else {
          let i = 1;
          for (const c of comRes.rows) {
            text += `  ${i}. ${escapeHtml(c.comment)}\n`;
            i += 1;
          }
        }
        text += `\n`;
      }

      // кнопки (дни остаются + ✅ на выбранном)
      buttons.push([
        Markup.button.callback(
          "▴ Подробнее по дням",
          `lk_internship_data_toggle_days_${candId}`,
        ),
      ]);

      const dayBtns = finishedDays.map((d) => {
        const label = d === dayNumber ? `✅${d}дн` : `${d}дн`;
        return Markup.button.callback(
          label,
          `lk_internship_data_day_${candId}_${d}`,
        );
      });

      for (let i = 0; i < dayBtns.length; i += 3) {
        buttons.push(dayBtns.slice(i, i + 3));
      }

      buttons.push([
        Markup.button.callback(
          "⬅️ назад в карточку",
          `lk_internship_data_back_${candId}`,
        ),
      ]);
    }

    // ---- MODE: выбранная часть (просмотр этапов) ----
    if (mode === "part") {
      const partId = Number(st.selectedPartId);

      const partRes = await pool.query(
        `SELECT id, title FROM internship_parts WHERE id = $1 LIMIT 1`,
        [partId],
      );
      const partTitle = partRes.rows[0]?.title || `#${partId}`;

      text += `часть: <b>${escapeHtml(partTitle)}</b>\n`;

      // список шагов части + кто/когда отметил (overall)
      const stepsRes = await pool.query(
        `
        SELECT id, title, step_type, order_index
        FROM internship_steps
        WHERE part_id = $1
        ORDER BY order_index ASC, id ASC
        `,
        [partId],
      );

      const academyUser =
        process.env.ACADEMY_BOT_USERNAME || "barista_academy_bot";

      for (const s of stepsRes.rows || []) {
        // находим лучший факт по пользователю: TRUE приоритетнее, затем по времени
        let passedRow = null;
        if (userId) {
          const rRes = await pool.query(
            `
            SELECT
              r.is_passed,
              r.checked_at,
              r.media_file_id,
              u.full_name AS checker_name
            FROM internship_step_results r
            JOIN internship_sessions ses ON ses.id = r.session_id
            LEFT JOIN users u ON u.id = r.checked_by
            WHERE ses.user_id = $1
              AND ses.is_canceled = FALSE
              AND r.step_id = $2
            ORDER BY r.is_passed DESC, r.checked_at DESC
            LIMIT 1
            `,
            [userId, s.id],
          );
          passedRow = rRes.rows[0] || null;
        }

        const isPassed = passedRow?.is_passed === true;

        const typeIcon =
          s.step_type === "photo" ? "📷" : s.step_type === "video" ? "🎥" : ".";
        const statusIcon = isPassed ? "✅" : "❌";

        let suffix = "";
        if (isPassed && passedRow?.checker_name && passedRow?.checked_at) {
          const dt = new Date(passedRow.checked_at);
          const dd = String(dt.getDate()).padStart(2, "0");
          const mm = String(dt.getMonth() + 1).padStart(2, "0");
          const hh = String(dt.getHours()).padStart(2, "0");
          const mi = String(dt.getMinutes()).padStart(2, "0");
          suffix = ` (${escapeHtml(
            passedRow.checker_name,
          )}, ${dd}.${mm}, ${hh}:${mi})`;
        }

        const label = `${statusIcon} ${typeIcon} ${s.title}${suffix}`;
        const isMedia = s.step_type === "photo" || s.step_type === "video";
        const hasMedia = Boolean(passedRow?.media_file_id);

        // ✅ photo/video + пройдено + есть media_file_id → сразу URL на академию
        if (isPassed && isMedia && hasMedia) {
          const url = `https://t.me/${academyUser}?start=media_${candId}_${s.id}`;
          buttons.push([Markup.button.url(label, url)]);
        } else {
          // всё остальное остаётся callback (тосты/проверки)
          buttons.push([
            Markup.button.callback(
              label,
              `lk_internship_data_step_${s.id}_${candId}_${partId}`,
            ),
          ]);
        }
      }

      buttons.push([
        Markup.button.callback(
          "⬅️ к списку частей",
          `lk_internship_data_part_back_${candId}`,
        ),
      ]);
      buttons.push([
        Markup.button.callback(
          "⬅️ назад в карточку",
          `lk_internship_data_back_${candId}`,
        ),
      ]);
    }

    const kb = Markup.inlineKeyboard(buttons);

    if (edit) {
      await ctx.editMessageText(text, { parse_mode: "HTML", ...kb });
    } else {
      await ctx.reply(text, { parse_mode: "HTML", ...kb });
    }
  }

  // клик по завершённому дню — экран деталей дня стажировки
  bot.action(/^lk_internship_day_(\d+)_(\d+)$/, async (ctx) => {
    try {
      const candId = Number(ctx.match[1]);
      const dayNumber = Number(ctx.match[2]);
      await ctx.answerCbQuery().catch(() => {});

      // 1) кандидат + привязанный user_id
      const candRes = await pool.query(
        `
  SELECT
    c.*,
    u.id       AS lk_user_id,
    u.username AS lk_username
  FROM candidates c
  LEFT JOIN users u ON u.candidate_id = c.id
  WHERE c.id = $1
  LIMIT 1
  `,
        [candId],
      );

      if (!candRes.rows.length) {
        await ctx.reply("Кандидат не найден.");
        return;
      }

      const cand = candRes.rows[0];
      const userId = cand.lk_user_id;

      if (!userId) {
        await ctx.reply("⚠️ Пользователь не привязан.");
        return;
      }

      // 2) session выбранного дня
      const sesRes = await pool.query(
        `
      SELECT
  s.*,
  tp.title AS trade_point_title,
  mentor.full_name AS mentor_name,
  mentor.username AS mentor_username,
  mentor.telegram_id AS mentor_tg_id
FROM internship_sessions s
LEFT JOIN trade_points tp ON tp.id = s.trade_point_id
LEFT JOIN users mentor ON mentor.id = s.started_by
WHERE s.user_id = $1
  AND s.day_number = $2
  AND s.is_canceled = FALSE
ORDER BY s.id DESC
LIMIT 1
        `,
        [userId, dayNumber],
      );

      if (!sesRes.rows.length) {
        await ctx.reply("День стажировки не найден.");
        return;
      }

      const session = sesRes.rows[0];

      // 3) Комментарии по сессии
      const comRes = await pool.query(
        `
        SELECT
          c.id,
          c.comment,
          c.created_at,
          u.full_name AS author_name
        FROM internship_session_comments c
        LEFT JOIN users u ON u.id = c.author_id
        WHERE c.session_id = $1
        ORDER BY c.id ASC
        `,
        [session.id],
      );

      // 4) Общий % изученного (накопительно по всем дням)
      const totalStepsRes = await pool.query(
        `SELECT COUNT(*)::int AS cnt FROM internship_steps`,
      );
      const totalSteps = totalStepsRes.rows[0]?.cnt || 0;

      const passedAllRes = await pool.query(
        `
        SELECT COUNT(DISTINCT r.step_id)::int AS cnt
        FROM internship_step_results r
        JOIN internship_sessions s ON s.id = r.session_id
        WHERE s.user_id = $1
          AND s.is_canceled = FALSE
          AND r.is_passed = TRUE
        `,
        [userId],
      );
      const passedAll = passedAllRes.rows[0]?.cnt || 0;

      const overallPercent =
        totalSteps > 0 ? Math.round((passedAll / totalSteps) * 100) : 0;

      // 5) % по плану дня N
      // строим мапу day_number -> planned step_ids
      const sectionsRes = await pool.query(
        `
        SELECT
          p.order_index AS part_order,
          s.id,
          s.title,
          s.duration_days,
          s.order_index
        FROM internship_sections s
        JOIN internship_parts p ON p.id = s.part_id
        WHERE s.duration_days IS NOT NULL
        ORDER BY p.order_index ASC, s.order_index ASC
        `,
      );

      const dayToSteps = new Map(); // day -> [step_id]
      let cursorDay = 1;

      for (const sec of sectionsRes.rows) {
        const dur = Number(sec.duration_days || 0);
        if (!dur || dur < 1) continue;

        const stepsRes = await pool.query(
          `
          SELECT id
          FROM internship_steps
          WHERE section_id = $1
          ORDER BY order_index ASC, id ASC
          `,
          [sec.id],
        );
        const stepIds = stepsRes.rows.map((r) => Number(r.id));

        // делим шаги секции на dur частей (равномерно по order_index)
        const k = dur;
        const n = stepIds.length;
        let idx = 0;

        for (let i = 0; i < k; i++) {
          const remaining = n - idx;
          const remainingBuckets = k - i;
          const take =
            remainingBuckets > 0
              ? Math.ceil(remaining / remainingBuckets)
              : remaining;

          const chunk = stepIds.slice(idx, idx + take);
          idx += take;

          const d = cursorDay;
          const prev = dayToSteps.get(d) || [];
          dayToSteps.set(d, prev.concat(chunk));

          cursorDay += 1;
        }
      }

      const plannedStepIds = (dayToSteps.get(dayNumber) || []).filter(Boolean);
      const plannedTotal = plannedStepIds.length;

      let plannedPassed = 0;
      if (plannedTotal > 0) {
        const passPlanRes = await pool.query(
          `
          SELECT COUNT(DISTINCT r.step_id)::int AS cnt
          FROM internship_step_results r
          JOIN internship_sessions s ON s.id = r.session_id
          WHERE s.user_id = $1
            AND s.is_canceled = FALSE
            AND r.is_passed = TRUE
            AND r.step_id = ANY($2::int[])
          `,
          [userId, plannedStepIds],
        );

        plannedPassed = passPlanRes.rows[0]?.cnt || 0;
      }

      const planPercent =
        plannedTotal > 0 ? Math.round((plannedPassed / plannedTotal) * 100) : 0;

      const planIcon = planPercent >= 100 ? "📈" : "📉";

      // Fallback — старые поля candidates.internship_* (на случай, если schedules ещё не связали).
      // 6) План времени (берём из internship_schedules по session_id, fallback на candidates)
      let planTimeText = "не указано";

      try {
        const schRes = await pool.query(
          `
          SELECT planned_time_from, planned_time_to
          FROM internship_schedules
          WHERE session_id = $1
          ORDER BY id DESC
          LIMIT 1
          `,
          [session.id],
        );

        const sch = schRes.rows[0] || null;
        const from = sch?.planned_time_from || cand.internship_time_from;
        const to = sch?.planned_time_to || cand.internship_time_to;

        if (from && to) {
          planTimeText = `с ${String(from).slice(0, 5)} до ${String(to).slice(
            0,
            5,
          )}`;
        }
      } catch (_) {
        // оставляем "не указано"
      }

      // 7) Итог времени
      const fmtTime = (d) =>
        d
          ? new Date(d).toLocaleTimeString("ru-RU", {
              hour: "2-digit",
              minute: "2-digit",
            })
          : "не указано";

      const fmtDate = (d) =>
        d
          ? new Date(d).toLocaleDateString("ru-RU", {
              day: "2-digit",
              month: "2-digit",
            })
          : "не указано";

      const factFrom = session.started_at
        ? fmtTime(session.started_at)
        : "не указано";
      const factTo = session.finished_at
        ? fmtTime(session.finished_at)
        : "не указано";

      const dateLabel = session.started_at
        ? `${fmtDate(session.started_at)}`
        : "не указано";

      // 8) Наставник строка (username если есть, иначе телефон)
      let mentorLine = session.mentor_name || "не указан";
      if (session.mentor_username) {
        mentorLine += ` (@${session.mentor_username})`;
      } else if (session.mentor_tg_id) {
        mentorLine += ` (tg_id: ${session.mentor_tg_id})`;
      }

      // 9) Общая инфа (username если есть, иначе телефон)
      const agePart = cand.age ? ` (${cand.age})` : "";
      const who = cand.lk_username
        ? `@${cand.lk_username}`
        : cand.phone
          ? cand.phone
          : "—";

      let text =
        `🔹 *Общая информация*\n` +
        `Имя: ${cand.name || "—"}${agePart} ${who}\n` +
        "────────────────────────\n" +
        `🔹 *О стажировке ${dayNumber}*\n` +
        `*Дата и время стажировки:*\n` +
        `  • *план:* ${dateLabel} (${planTimeText})\n` +
        `  • *итог:* ${dateLabel} (с ${factFrom} до ${factTo})\n\n` +
        `*Место стажировки:*\n` +
        `  • ${session.trade_point_title || "не указано"}\n\n` +
        `*Ответственный по стажировке:*\n` +
        `  • ${mentorLine}\n\n` +
        `*Успеваемость стажировки:*\n` +
        `  • *общий процент изученного:* ${overallPercent}%\n` +
        `  • *процент по плану дня ${dayNumber}:* ${planPercent}% ${planIcon}\n\n` +
        `*Комментарии по стажировке ${dayNumber}:*\n`;

      if (!comRes.rows.length) {
        text += "  — пока нет\n";
      } else {
        let i = 1;
        for (const c of comRes.rows) {
          text += `  ${i}. ${c.comment}\n`;
          i += 1;
        }
      }

      const kb = Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "⬅️ Назад к дням",
            `lk_internship_data_${candId}`,
          ),
        ],
      ]);

      await deliver(
        ctx,
        {
          text,
          extra: { ...kb, parse_mode: "Markdown" },
        },
        { edit: true },
      );
    } catch (err) {
      logError("lk_internship_day", err);
      await ctx.reply("⚠️ Ошибка. Попробуйте позже.");
    }
  });

  // клик по 🎓 дню — тост
  bot.action(/^lk_internship_day_active_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx
        .answerCbQuery(
          "Идёт процесс обучения, данные появятся после завершения",
          { show_alert: false },
        )
        .catch(() => {});
    } catch (err) {
      logError("lk_internship_day_active", err);
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
      [candId],
    );

    const lkUserId = cRes.rows[0]?.lk_user_id || null;
    const fullName = cRes.rows[0]?.full_name || "Без имени";

    if (!lkUserId) {
      await ctx.editMessageText(
        "⚠️ У стажёра нет привязанного пользователя ЛК.",
      );
      return;
    }

    const activeShift = await getActiveShiftToday(lkUserId);
    if (!activeShift) {
      await ctx.editMessageText(
        "⚠️ У пользователя нет активной смены сегодня.",
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
      [lkUserId],
    );

    let text = `📝 <b>Задачи смены</b>\n\n`;
    text += `👤 <b>${escHtml(fullName)}</b>\n`;
    text += `📍 Точка: <b>${escHtml(
      activeShift.point_title || "не указано",
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
        `admin_shift_tasks_point_${activeShift.trade_point_id}`,
      ),
    ]);

    rows.push([Markup.button.callback("⬅️ Назад", `lk_cand_open_${candId}`)]);

    await ctx.editMessageText(text, {
      parse_mode: "HTML",
      ...Markup.inlineKeyboard(rows),
    });
  });

  bot.action(/^lk_internship_decline_stub_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery("Отказ стажёру — пока заглушка.").catch(() => {});
  });
}

module.exports = registerCandidateCard;
module.exports.showCandidateCardLk = showCandidateCardLk;
