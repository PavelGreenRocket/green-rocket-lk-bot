// src/bot/admin/users/candidateInternship.js

const { Markup } = require("telegraf");
const pool = require("../../../db/pool");
const { showCandidateCardLk } = require("./candidateCard");

// состояние сценария по tg_id
const internshipStateByTgId = new Map();
// состояние "старт стажировки" (вопрос: вовремя/опоздал)
const startInternshipStates = new Map(); // mentorTelegramId -> { candidateId, internUserId, tradePointId }

function getState(tgId) {
  return internshipStateByTgId.get(tgId) || null;
}
function setState(tgId, patch) {
  const cur = internshipStateByTgId.get(tgId) || {};
  internshipStateByTgId.set(tgId, { ...cur, ...patch });
}
function clearState(tgId) {
  internshipStateByTgId.delete(tgId);
}

function formatDateForNotification(dateIso) {
  if (!dateIso) return "";
  const parts = String(dateIso).split("-");
  if (parts.length !== 3) return String(dateIso);
  const [year, month, day] = parts;
  return `${day}.${month}.${year}`;
}

function parseRuDateToIso(ddmm) {
  const m = ddmm.match(/^(\d{1,2})\.(\d{1,2})$/);
  if (!m) return null;
  let [, ddStr, mmStr] = m;
  const dd = parseInt(ddStr, 10);
  const mm = parseInt(mmStr, 10);
  if (!Number.isFinite(dd) || !Number.isFinite(mm)) return null;
  if (dd < 1 || dd > 31 || mm < 1 || mm > 12) return null;

  const now = new Date();
  const yyyy = now.getFullYear();
  const date = new Date(yyyy, mm - 1, dd);
  if (Number.isNaN(date.getTime())) return null;

  const y = date.getFullYear();
  const m2 = String(date.getMonth() + 1).padStart(2, "0");
  const d2 = String(date.getDate()).padStart(2, "0");
  return `${y}-${m2}-${d2}`;
}

function parseTimeHHMM(str) {
  const m = str.match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const hh = parseInt(m[1], 10);
  const mm = parseInt(m[2], 10);
  if (!Number.isFinite(hh) || !Number.isFinite(mm)) return null;
  if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
  return `${String(hh).padStart(2, "0")}:${String(mm).padStart(2, "0")}`;
}

async function askDate(ctx, candidateId) {
  const text =
    "📅 Укажите дату стажировки в формате ДД.ММ (например, 05.12)\n\n" +
    "Или выберите «сегодня» / «завтра».";

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "Сегодня",
        `lk_cand_invite_date_today_${candidateId}`
      ),
      Markup.button.callback(
        "Завтра",
        `lk_cand_invite_date_tomorrow_${candidateId}`
      ),
    ],
    [
      Markup.button.callback(
        "❌ Отмена",
        `lk_cand_invite_cancel_${candidateId}`
      ),
    ],
  ]);

  if (ctx.updateType === "callback_query") {
    await ctx
      .editMessageText(text, { ...keyboard, parse_mode: "Markdown" })
      .catch(() => {});
  } else {
    await ctx.reply(text, { ...keyboard, parse_mode: "Markdown" });
  }
}

async function askTimeFrom(ctx, candidateId) {
  const text =
    "⏰ С какого времени начинается стажировка?\n\n" +
    "Укажите время в формате ЧЧ:ММ (например, 11:00).";

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "❌ Отмена",
        `lk_cand_invite_cancel_${candidateId}`
      ),
    ],
  ]);

  await ctx
    .editMessageText(text, { ...keyboard, parse_mode: "Markdown" })
    .catch(async () => {
      await ctx.reply(text, { ...keyboard, parse_mode: "Markdown" });
    });
}

async function askTimeTo(ctx, candidateId) {
  const text =
    "⏰ До какого времени длится стажировка?\n\n" +
    "Укажите время в формате ЧЧ:ММ (например, 16:00).";

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "❌ Отмена",
        `lk_cand_invite_cancel_${candidateId}`
      ),
    ],
  ]);

  await ctx
    .editMessageText(text, { ...keyboard, parse_mode: "Markdown" })
    .catch(async () => {
      await ctx.reply(text, { ...keyboard, parse_mode: "Markdown" });
    });
}

async function askPoint(ctx, candidateId) {
  const { rows } = await pool.query(
    `SELECT id, title FROM trade_points WHERE is_active = TRUE ORDER BY id`
  );

  if (!rows.length) {
    await ctx.reply(
      "Нет активных торговых точек. Добавьте точку в настройках и повторите."
    );
    clearState(ctx.from.id);
    return;
  }

  const buttons = rows.map((p) => [
    Markup.button.callback(p.title, `lk_cand_invite_point_${p.id}`),
  ]);

  buttons.push([
    Markup.button.callback(
      "Назначу позже",
      `lk_cand_invite_point_later_${candidateId}`
    ),
  ]);
  buttons.push([
    Markup.button.callback("❌ Отмена", `lk_cand_invite_cancel_${candidateId}`),
  ]);

  const keyboard = Markup.inlineKeyboard(buttons);

  const text = "📍 Выберите точку стажировки:";

  await ctx
    .editMessageText(text, { ...keyboard, parse_mode: "Markdown" })
    .catch(async () => {
      await ctx.reply(text, { ...keyboard, parse_mode: "Markdown" });
    });
}

async function askAdmin(ctx, candidateId) {
  const { rows } = await pool.query(
    `
      SELECT id, full_name, role
        FROM users
       WHERE role IN ('admin','super_admin','worker','intern')
       ORDER BY role, full_name
    `
  );

  if (!rows.length) {
    await ctx.reply(
      "Нет доступных наставников. Добавьте сотрудников и повторите."
    );
    clearState(ctx.from.id);
    return;
  }

  const buttons = rows.map((u) => [
    Markup.button.callback(
      `${u.full_name || "Без имени"} (${u.role})`,
      `lk_cand_invite_admin_${u.id}`
    ),
  ]);

  buttons.push([
    Markup.button.callback(
      "Назначу позже",
      `lk_cand_invite_admin_later_${candidateId}`
    ),
  ]);
  buttons.push([
    Markup.button.callback("❌ Отмена", `lk_cand_invite_cancel_${candidateId}`),
  ]);

  const keyboard = Markup.inlineKeyboard(buttons);

  const text = "👤 Выберите ответственного по стажировке:";

  await ctx
    .editMessageText(text, { ...keyboard, parse_mode: "Markdown" })
    .catch(async () => {
      await ctx.reply(text, { ...keyboard, parse_mode: "Markdown" });
    });
}

async function askLinkUser(ctx, candidateId) {
  const text =
    "👥 Теперь нужно связать кандидата с пользователем ЛК.\n\n" +
    "Это нужно, чтобы этому человеку приходили уведомления о стажировке.\n\n" +
    "Выберите способ:";

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "🔗 Привязать существующего пользователя",
        `lk_cand_invite_link_existing_${candidateId}`
      ),
    ],
    [
      Markup.button.callback(
        "⏳ Привяжу позже",
        `lk_cand_invite_link_later_${candidateId}`
      ),
    ],
  ]);

  await ctx
    .editMessageText(text, { ...keyboard, parse_mode: "Markdown" })
    .catch(async () => {
      await ctx.reply(text, { ...keyboard, parse_mode: "Markdown" });
    });
}

async function askLinkUserOrFinish(ctx, candidateId) {
  // проверяем, есть ли уже пользователь, привязанный к этому кандидату
  const res = await pool.query(
    `
      SELECT id
      FROM users
      WHERE candidate_id = $1
      LIMIT 1
    `,
    [candidateId]
  );

  const st = getState(ctx.from.id);
  if (!st) return;

  if (res.rows.length) {
    // пользователь уже привязан — сразу заканчиваем приглашение
    const existingUserId = res.rows[0].id;
    await finishInternshipInvite(ctx, ctx.from.id, {
      linkUserId: existingUserId,
    });
  } else {
    // пользователя ещё нет — показываем экран выбора способа привязки
    await askLinkUser(ctx, candidateId);
  }
}

async function showExistingUsersForLink(ctx, candidateId) {
  const { rows } = await pool.query(
    `
      SELECT id, full_name, age, phone, created_at
      FROM lk_waiting_users
      WHERE status = 'new'
      ORDER BY created_at DESC
    `
  );

  if (!rows.length) {
    await ctx.reply(
      "Пока нет новых пользователей, которые вошли в Личный кабинет.\n" +
        "Можно будет привязать человека позже из настроек кандидата."
    );
    await finishInternshipInvite(ctx, ctx.from.id, { linkUserId: null });
    return;
  }

  const buttons = rows.map((u) => {
    const created = u.created_at ? new Date(u.created_at) : null;
    let dateLabel = "";
    if (created && !Number.isNaN(created.getTime())) {
      const dd = String(created.getDate()).padStart(2, "0");
      const mm = String(created.getMonth() + 1).padStart(2, "0");
      dateLabel = `${dd}.${mm}`;
    }

    const agePart = u.age ? ` (${u.age})` : "";
    const phonePart = u.phone ? ` ${u.phone}` : "";

    const label = `${dateLabel ? dateLabel + " " : ""}${
      u.full_name || "Без имени"
    }${agePart}${phonePart}`;

    return [
      Markup.button.callback(
        label,
        // В КОЛБЭК передаём id записи из lk_waiting_users
        `lk_cand_invite_link_select_${candidateId}_${u.id}`
      ),
    ];
  });

  buttons.push([
    Markup.button.callback(
      "⏳ Привязать позже",
      `lk_cand_invite_link_later_${candidateId}`
    ),
  ]);

  const keyboard = Markup.inlineKeyboard(buttons);

  const text =
    "Выберите пользователя, которого привязываем к этой стажировке:\n\n" +
    "Показываются только новые люди, которые недавно вошли в Личный кабинет.";

  await ctx
    .editMessageText(text, { parse_mode: "Markdown", ...keyboard })
    .catch(async () => {
      await ctx.reply(text, { parse_mode: "Markdown", ...keyboard });
    });
}

async function pushOutboxEvent(destination, eventType, payload) {
  await pool.query(
    `
    INSERT INTO outbox_events (destination, event_type, payload)
    VALUES ($1, $2, $3::jsonb)
    `,
    [destination, eventType, JSON.stringify(payload)]
  );
}

async function finishInternshipInvite(ctx, tgId, options = {}) {
  const state = getState(tgId);
  if (!state) return;

  const { candidateId, dateIso, timeFrom, timeTo, pointId, adminId } = state;

  // 1. Обновляем кандидата как приглашённого на стажировку
  await pool.query(
    `
      UPDATE candidates
         SET status = 'internship_invited',
             internship_date = $2,
             internship_time_from = $3,
             internship_time_to = $4,
             internship_point_id = $5,
             internship_admin_id = $6
       WHERE id = $1
    `,
    [candidateId, dateIso, timeFrom, timeTo, pointId, adminId]
  );

  let linkedUserId = null;
  let linkedTelegramId = null;
  let linkedName = null;

  // 2а. Старый вариант: привязка к уже существующему пользователю users.id
  if (options.linkUserId) {
    const res = await pool.query(
      `
        UPDATE users
           SET candidate_id = $1,
               staff_status = COALESCE(staff_status, 'candidate')
         WHERE id = $2
         RETURNING id, telegram_id, full_name
      `,
      [candidateId, options.linkUserId]
    );

    if (res.rows.length) {
      linkedUserId = res.rows[0].id;
      linkedTelegramId = res.rows[0].telegram_id;
      linkedName = res.rows[0].full_name;
    }
  }

  // 2б. Новый вариант: привязка из lk_waiting_users
  if (options.waitingId) {
    const wRes = await pool.query(
      `
        SELECT id, telegram_id, full_name, age, phone
        FROM lk_waiting_users
        WHERE id = $1
      `,
      [options.waitingId]
    );

    if (wRes.rows.length) {
      const w = wRes.rows[0];

      const userRes = await pool.query(
        `
          INSERT INTO users (telegram_id, full_name, role, staff_status, position, candidate_id)
          VALUES ($1, $2, 'user', 'candidate', NULL, $3)
          ON CONFLICT (telegram_id) DO UPDATE
            SET full_name = EXCLUDED.full_name,
                staff_status = 'candidate',
                candidate_id = $3
          RETURNING id, telegram_id, full_name
        `,
        [w.telegram_id, w.full_name, candidateId]
      );

      const u = userRes.rows[0];

      linkedUserId = u.id;
      linkedTelegramId = u.telegram_id;
      linkedName = u.full_name;

      await pool.query(
        `
          UPDATE lk_waiting_users
             SET status = 'linked',
                 linked_user_id = $2,
                 linked_at = NOW()
           WHERE id = $1
        `,
        [w.id, u.id]
      );
    }
  }

  clearState(tgId);

  // 3. Если мы кого-то привязали — отправляем ему уведомление
  if (linkedUserId && linkedTelegramId) {
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
      u.username    AS mentor_username,
      u.telegram_id AS mentor_telegram_id,
      u.work_phone  AS mentor_work_phone
    FROM candidates c
    LEFT JOIN trade_points tp ON tp.id = c.internship_point_id
    LEFT JOIN users u ON u.id = c.internship_admin_id
    WHERE c.id = $1
  `,
      [candidateId]
    );
    if (!cRes.rows.length) return;
    const c = cRes.rows[0];

    let datePart = "не указана";
    if (c && c.internship_date) {
      const d = new Date(c.internship_date);
      if (!Number.isNaN(d.getTime())) {
        const dd = String(d.getDate()).padStart(2, "0");
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const weekday = d.toLocaleDateString("ru-RU", { weekday: "short" });
        datePart = `${dd}.${mm} (${weekday})`;
      }
    }

    const timeFromText = c?.internship_time_from || "не указано";
    const timeToText = c?.internship_time_to || "не указано";

    const pointTitle = c?.point_title || "не указана";
    const mentorName = c?.mentor_name || "не указан";

    const nameForText = c?.name || "Вы";

    function escapeHtml(s) {
      return String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    }

    // Нормализация телефона (как в приглашении на собеседование)
    let phoneDisplay = null;
    let phoneHref = null;
    if (c?.mentor_work_phone) {
      const raw = String(c.mentor_work_phone);
      let digits = raw.replace(/\D+/g, "");

      if (digits.length === 11 && digits.startsWith("8")) {
        digits = "7" + digits.slice(1);
      }

      if (digits.length === 11 && digits.startsWith("7")) {
        phoneHref = "+" + digits;
        phoneDisplay = "+" + digits;
      } else if (digits.length >= 10) {
        phoneHref = "+" + digits;
        phoneDisplay = "+" + digits;
      } else {
        phoneDisplay = raw.trim();
      }
    }

    const pointAddress = c?.point_address || "будет добавлен позже";
    const pointLandmark = c?.point_landmark || "будет добавлен позже";
    const mentorPosition = c?.mentor_position || "";
    const mentorUsername = c?.mentor_username ? `@${c.mentor_username}` : "";

    let mentorLine = escapeHtml(mentorName);

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
      `• <b>Наставник:</b> ${mentorLine}\n`;

    if (phoneDisplay) {
      if (phoneHref) {
        text += `• <b>Телефон для связи:</b> <a href="tel:${escapeHtml(
          phoneHref
        )}">${escapeHtml(phoneDisplay)}</a>\n`;
      } else {
        text += `• <b>Телефон для связи:</b> ${escapeHtml(phoneDisplay)}\n`;
      }
    }

    const keyboardRows = [];

    // Telegram кнопка наставника (если есть telegram_id)
    if (c?.mentor_telegram_id) {
      const firstName = (mentorName || "Telegram").split(" ")[0] || "Telegram";
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

    await ctx.telegram
      .sendMessage(linkedTelegramId, text, {
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: keyboardRows },
      })
      .catch(() => {});

    // Короткое уведомление наставнику
    if (c?.mentor_telegram_id) {
      try {
        const adminTextLines = [];
        adminTextLines.push("🕒 *Новая запланированная стажировка*");
        adminTextLines.push("");
        adminTextLines.push(
          `• Кандидат: ${c.name || "без имени"}${c.age ? ` (${c.age})` : ""}`
        );
        adminTextLines.push(`• Дата: ${datePart}`);
        adminTextLines.push(
          `• Время: с ${timeFromText || "не указано"} до ${
            timeToText || "не указано"
          }`
        );
        adminTextLines.push(`• Точка: ${pointTitle}`);
        if (pointAddress) adminTextLines.push(`• Адрес: ${pointAddress}`);

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
                text: "📋 Мои стажировки",
                callback_data: "lk_admin_my_internships",
              },
            ],
          ],
        };

        await ctx.telegram.sendMessage(
          c.mentor_telegram_id,
          adminTextLines.join("\n"),
          {
            parse_mode: "Markdown",
            reply_markup: adminKeyboard,
          }
        );
      } catch (err) {
        console.error("[finishInternshipInvite] notify mentor error", err);
      }
    }
  }
  // 4. Возвращаемся к карточке кандидата админу
  await showCandidateCardLk(ctx, candidateId, { edit: true });
}

// ------------- РЕГИСТРАЦИЯ ХЕНДЛЕРОВ -------------

function registerCandidateInternship(bot, ensureUser, logError) {
  // Старт сценария: "✅ пригласить на стажировку"
  bot.action(/^lk_cand_invite_(\d+)$/, async (ctx) => {
    try {
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        await ctx.answerCbQuery("Нет доступа").catch(() => {});
        return;
      }

      const candidateId = Number(ctx.match[1]);
      setState(ctx.from.id, {
        candidateId,
        step: "date",
        dateIso: null,
        timeFrom: null,
        timeTo: null,
        pointId: null,
        adminId: null,
      });

      await ctx.answerCbQuery().catch(() => {});
      await askDate(ctx, candidateId);
    } catch (err) {
      logError("lk_cand_invite_start", err);
    }
  });

  // Дата: сегодня / завтра
  bot.action(/^lk_cand_invite_date_today_(\d+)$/, async (ctx) => {
    try {
      const candidateId = Number(ctx.match[1]);
      const st = getState(ctx.from.id);
      if (!st || st.candidateId !== candidateId) return;

      const now = new Date();
      const yyyy = now.getFullYear();
      const mm = String(now.getMonth() + 1).padStart(2, "0");
      const dd = String(now.getDate()).padStart(2, "0");
      const iso = `${yyyy}-${mm}-${dd}`;

      setState(ctx.from.id, { dateIso: iso, step: "time_from" });
      await ctx.answerCbQuery().catch(() => {});
      await askTimeFrom(ctx, candidateId);
    } catch (err) {
      logError("lk_cand_invite_date_today", err);
    }
  });

  bot.action(/^lk_cand_invite_date_tomorrow_(\d+)$/, async (ctx) => {
    try {
      const candidateId = Number(ctx.match[1]);
      const st = getState(ctx.from.id);
      if (!st || st.candidateId !== candidateId) return;

      const now = new Date();
      now.setDate(now.getDate() + 1);
      const yyyy = now.getFullYear();
      const mm = String(now.getMonth() + 1).padStart(2, "0");
      const dd = String(now.getDate()).padStart(2, "0");
      const iso = `${yyyy}-${mm}-${dd}`;

      setState(ctx.from.id, { dateIso: iso, step: "time_from" });
      await ctx.answerCbQuery().catch(() => {});
      await askTimeFrom(ctx, candidateId);
    } catch (err) {
      logError("lk_cand_invite_date_tomorrow", err);
    }
  });

  // Отмена сценария
  bot.action(/^lk_cand_invite_cancel_(\d+)$/, async (ctx) => {
    try {
      const candidateId = Number(ctx.match[1]);
      clearState(ctx.from.id);
      await ctx.answerCbQuery("Отменено").catch(() => {});
      await showCandidateCardLk(ctx, candidateId, { edit: true });
    } catch (err) {
      logError("lk_cand_invite_cancel", err);
    }
  });

  // Выбор точки стажировки
  bot.action(/^lk_cand_invite_point_(\d+)$/, async (ctx) => {
    try {
      const pointId = Number(ctx.match[1]);
      const st = getState(ctx.from.id);
      if (!st) return;
      setState(ctx.from.id, { pointId, step: "admin" });
      await ctx.answerCbQuery().catch(() => {});
      await askAdmin(ctx, st.candidateId);
    } catch (err) {
      logError("lk_cand_invite_point", err);
    }
  });

  bot.action(/^lk_cand_invite_point_later_(\d+)$/, async (ctx) => {
    try {
      const candidateId = Number(ctx.match[1]);
      const st = getState(ctx.from.id);
      if (!st || st.candidateId !== candidateId) return;
      setState(ctx.from.id, { pointId: null, step: "admin" });
      await ctx.answerCbQuery().catch(() => {});
      await askAdmin(ctx, candidateId);
    } catch (err) {
      logError("lk_cand_invite_point_later", err);
    }
  });

  // Выбор наставника
  bot.action(/^lk_cand_invite_admin_(\d+)$/, async (ctx) => {
    try {
      const adminId = Number(ctx.match[1]);
      const st = getState(ctx.from.id);
      if (!st) return;

      setState(ctx.from.id, { adminId, step: "link" });
      await ctx.answerCbQuery().catch(() => {});

      // 🔁 здесь новая логика
      await askLinkUserOrFinish(ctx, st.candidateId);
    } catch (err) {
      logError("lk_cand_invite_admin", err);
    }
  });

  bot.action(/^lk_cand_invite_admin_later_(\d+)$/, async (ctx) => {
    try {
      const candidateId = Number(ctx.match[1]);
      const st = getState(ctx.from.id);
      if (!st || st.candidateId !== candidateId) return;

      setState(ctx.from.id, { adminId: null, step: "link" });
      await ctx.answerCbQuery().catch(() => {});

      // 🔁 и здесь тоже
      await askLinkUserOrFinish(ctx, candidateId);
    } catch (err) {
      logError("lk_cand_invite_admin_later", err);
    }
  });

  // Привязка к существующему пользователю
  bot.action(/^lk_cand_invite_link_existing_(\d+)$/, async (ctx) => {
    try {
      const candidateId = Number(ctx.match[1]);
      const st = getState(ctx.from.id);
      if (!st || st.candidateId !== candidateId) return;
      setState(ctx.from.id, { step: "link_existing" });
      await ctx.answerCbQuery().catch(() => {});
      await showExistingUsersForLink(ctx, candidateId);
    } catch (err) {
      logError("lk_cand_invite_link_existing", err);
    }
  });

  // Выбор конкретного пользователя
  bot.action(/^lk_cand_invite_link_select_(\d+)_(\d+)$/, async (ctx) => {
    try {
      const candidateId = Number(ctx.match[1]);
      const waitingId = Number(ctx.match[2]); // id из lk_waiting_users
      const st = getState(ctx.from.id);
      if (!st || st.candidateId !== candidateId) return;

      await ctx.answerCbQuery().catch(() => {});
      await finishInternshipInvite(ctx, ctx.from.id, { waitingId });
    } catch (err) {
      logError("lk_cand_invite_link_select", err);
    }
  });

  // Привяжу позже
  bot.action(/^lk_cand_invite_link_later_(\d+)$/, async (ctx) => {
    try {
      const candidateId = Number(ctx.match[1]);
      const st = getState(ctx.from.id);
      if (!st || st.candidateId !== candidateId) return;
      await ctx.answerCbQuery().catch(() => {});
      await finishInternshipInvite(ctx, ctx.from.id, { linkUserId: null });
    } catch (err) {
      logError("lk_cand_invite_link_later", err);
    }
  });

  // ТЕКСТОВЫЕ ШАГИ (дата / время)
  bot.on("text", async (ctx, next) => {
    const st = getState(ctx.from.id);
    if (!st) return next();

    try {
      if (st.step === "date") {
        const raw = (ctx.message.text || "").trim();
        const iso = parseRuDateToIso(raw);
        if (!iso) {
          await ctx.reply(
            "Дата не распознана. Укажите в формате ДД.ММ, например 05.12"
          );
          return;
        }
        setState(ctx.from.id, { dateIso: iso, step: "time_from" });
        await askTimeFrom(ctx, st.candidateId);
        return;
      }

      if (st.step === "time_from") {
        const raw = (ctx.message.text || "").trim();
        const t = parseTimeHHMM(raw);
        if (!t) {
          await ctx.reply(
            "Время не распознано. Укажите в формате ЧЧ:ММ, например 11:00"
          );
          return;
        }
        setState(ctx.from.id, { timeFrom: t, step: "time_to" });
        await askTimeTo(ctx, st.candidateId);
        return;
      }

      if (st.step === "time_to") {
        const raw = (ctx.message.text || "").trim();
        const t = parseTimeHHMM(raw);
        if (!t) {
          await ctx.reply(
            "Время не распознано. Укажите в формате ЧЧ:ММ, например 16:00"
          );
          return;
        }
        setState(ctx.from.id, { timeTo: t, step: "point" });
        await askPoint(ctx, st.candidateId);
        return;
      }

      return next();
    } catch (err) {
      logError("lk_cand_invite_text", err);
      clearState(ctx.from.id);
      await ctx.reply("Не удалось сохранить данные по стажировке.");
    }
  });

  // ---------------- НАЧАТЬ СТАЖИРОВКУ ----------------

  // 1) Нажатие "🚀 начать стажировку" на карточке кандидата
  bot.action(/^lk_cand_start_intern_(\d+)$/, async (ctx) => {
    try {
      const admin = await ensureUser(ctx);
      if (!admin) return;

      const candidateId = Number(ctx.match[1]);

      // подтягиваем кандидата + привязанного lk пользователя + ответственного
      const cRes = await pool.query(
        `
        SELECT
          c.id,
          c.name,
          c.age,
          c.internship_admin_id,
          c.internship_point_id,
          u_link.id AS intern_user_id,
          u_link.telegram_id AS intern_telegram_id,
          u_link.full_name AS intern_name
        FROM candidates c
        LEFT JOIN users u_link ON u_link.candidate_id = c.id
        WHERE c.id = $1
        LIMIT 1
        `,
        [candidateId]
      );

      if (!cRes.rows.length) {
        await ctx.answerCbQuery("Кандидат не найден").catch(() => {});
        return;
      }

      const c = cRes.rows[0];

      // доступ только у наставника (ответственного по стажировке)
      if (
        !c.internship_admin_id ||
        Number(c.internship_admin_id) !== Number(admin.id)
      ) {
        await ctx
          .answerCbQuery("Только ответственный может начать стажировку")
          .catch(() => {});
        return;
      }

      // должен быть привязанный lk пользователь (users.candidate_id = c.id)
      if (!c.intern_user_id || !c.intern_telegram_id) {
        await ctx
          .answerCbQuery(
            "Нет привязанного пользователя ЛК (некому начать обучение)"
          )
          .catch(() => {});
        return;
      }

      // должна быть выбрана точка (trade_point_id)
      if (!c.internship_point_id) {
        await ctx.answerCbQuery("Не указана точка стажировки").catch(() => {});
        return;
      }

      // сохраняем состояние вопроса "опоздал/вовремя"
      startInternshipStates.set(ctx.from.id, {
        candidateId: c.id,
        internUserId: Number(c.intern_user_id),
        internTelegramId: Number(c.intern_telegram_id),
        internName: c.intern_name || c.name || "стажёр",
        tradePointId: Number(c.internship_point_id),
        mentorUserId: Number(admin.id),
        mentorTelegramId: Number(ctx.from.id),
      });

      const text = "Стажёр пришёл вовремя?";
      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "✅ Пришёл вовремя",
            `lk_intern_start_late_no_${c.id}`
          ),
        ],
        [
          Markup.button.callback(
            "⚠️ Опоздал",
            `lk_intern_start_late_yes_${c.id}`
          ),
        ],
        [Markup.button.callback("❌ Отмена", `lk_intern_start_cancel_${c.id}`)],
      ]);

      await ctx.answerCbQuery().catch(() => {});
      await ctx
        .editMessageText(text, { ...keyboard, parse_mode: "Markdown" })
        .catch(async () => {
          await ctx.reply(text, { ...keyboard, parse_mode: "Markdown" });
        });
    } catch (err) {
      logError("lk_cand_start_intern", err);
    }
  });

  // 2) Отмена (на экране "пришёл вовремя?")
  bot.action(/^lk_intern_start_cancel_(\d+)$/, async (ctx) => {
    try {
      const candidateId = Number(ctx.match[1]);
      startInternshipStates.delete(ctx.from.id);
      await ctx.answerCbQuery("Отменено").catch(() => {});
      await showCandidateCardLk(ctx, candidateId, { edit: true });
    } catch (err) {
      logError("lk_intern_start_cancel", err);
    }
  });

  // helper: фактический старт сессии (создание internship_sessions + нотификации)
  async function doStartInternship(ctx, wasLate) {
    const st = startInternshipStates.get(ctx.from.id);
    if (!st) {
      await ctx.answerCbQuery("Состояние старта потеряно").catch(() => {});
      return;
    }

    const {
      candidateId,
      internUserId,
      internTelegramId,
      internName,
      tradePointId,
      mentorUserId,
      mentorTelegramId,
    } = st;

    // 0) если уже есть активная сессия — просто перерисуем карточку
    const activeRes = await pool.query(
      `
      SELECT 1
      FROM internship_sessions
      WHERE user_id = $1 AND finished_at IS NULL AND is_canceled = FALSE
      LIMIT 1
      `,
      [internUserId]
    );
    if (activeRes.rows.length) {
      startInternshipStates.delete(ctx.from.id);
      await ctx.answerCbQuery("Стажировка уже запущена").catch(() => {});
      await showCandidateCardLk(ctx, candidateId, { edit: true });
      return;
    }

    // 1) следующий день = кол-во завершённых (не cancelled) + 1
    const cntRes = await pool.query(
      `
      SELECT COUNT(*)::int AS finished_cnt
      FROM internship_sessions
      WHERE user_id = $1 AND finished_at IS NOT NULL AND is_canceled = FALSE
      `,
      [internUserId]
    );
    const nextDay = (cntRes.rows[0]?.finished_cnt || 0) + 1;

    // 2) создаём сессию
    await pool.query(
      `
      INSERT INTO internship_sessions (user_id, day_number, started_by, trade_point_id, was_late)
      VALUES ($1, $2, $3, $4, $5)
      `,
      [internUserId, nextDay, mentorUserId, tradePointId, wasLate]
    );

    // 3) фиксируем, что человек теперь intern (если вдруг ещё candidate)
    await pool.query(
      `
      UPDATE users
      SET staff_status = 'intern'
      WHERE id = $1
      `,
      [internUserId]
    );

    // 3.1) КРИТИЧНО:
    // переводим кандидата в статус "intern",
    // чтобы он исчез из списка "Кандидаты" и появился в "Стажёры"
    await pool.query(
      `
  UPDATE candidates
  SET status = 'intern'
  WHERE id = $1
  `,
      [candidateId]
    );

    // 4) уведомление стажёру (в lk-bot) + кнопка перехода в academy bot
    await ctx.telegram
      .sendMessage(
        internTelegramId,
        "🚀 Стажировка началась!\n\nНажмите кнопку ниже, чтобы перейти к обучению.",
        {
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "🚀 Перейти к обучению",
                  url: "https://t.me/barista_academy_GR_bot",
                },
              ],
            ],
          },
        }
      )
      .catch(() => {});

    // 5) уведомление наставнику В academy bot через outbox (academy worker уже это обрабатывает)
    await pushOutboxEvent("academy", "internship_started", {
      mentor_telegram_id: mentorTelegramId,
      intern_user_id: internUserId,
      intern_name: internName,
    });

    startInternshipStates.delete(ctx.from.id);

    // 6) перерисовываем карточку (теперь isTraineeMode станет true, потому что появилась активная сессия)
    await ctx.answerCbQuery().catch(() => {});
    await showCandidateCardLk(ctx, candidateId, { edit: true });
  }

  // 3) Пришёл вовремя
  bot.action(/^lk_intern_start_late_no_(\d+)$/, async (ctx) => {
    try {
      await doStartInternship(ctx, false);
    } catch (err) {
      logError("lk_intern_start_late_no", err);
    }
  });

  // 4) Опоздал
  bot.action(/^lk_intern_start_late_yes_(\d+)$/, async (ctx) => {
    try {
      await doStartInternship(ctx, true);
    } catch (err) {
      logError("lk_intern_start_late_yes", err);
    }
  });

  // ---------------- НАЧАТЬ СТАЖИРОВКУ ----------------

  // 1) Нажатие "🚀 начать стажировку" на карточке кандидата
  bot.action(/^lk_cand_start_intern_(\d+)$/, async (ctx) => {
    try {
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin")) {
        await ctx.answerCbQuery("Нет доступа").catch(() => {});
        return;
      }

      const candidateId = Number(ctx.match[1]);

      // достаём кандидата + кто наставник + к какому user привязан стажёр + торговая точка
      const cRes = await pool.query(
        `
        SELECT
          c.id,
          c.name,
          c.internship_admin_id,
          c.internship_point_id,
          u.id AS intern_user_id,
          u.telegram_id AS intern_telegram_id
        FROM candidates c
        LEFT JOIN users u ON u.candidate_id = c.id
        WHERE c.id = $1
        LIMIT 1
        `,
        [candidateId]
      );

      if (!cRes.rows.length) {
        await ctx.answerCbQuery("Кандидат не найден").catch(() => {});
        return;
      }

      const c = cRes.rows[0];

      // кнопка доступна только наставнику
      if (
        !c.internship_admin_id ||
        Number(c.internship_admin_id) !== Number(admin.id)
      ) {
        await ctx.answerCbQuery("Доступно только наставнику").catch(() => {});
        return;
      }

      if (!c.intern_user_id || !c.intern_telegram_id) {
        await ctx
          .answerCbQuery("Стажёр не привязан к пользователю")
          .catch(() => {});
        return;
      }

      if (!c.internship_point_id) {
        await ctx
          .answerCbQuery("Не указана торговая точка стажировки")
          .catch(() => {});
        return;
      }

      // проверка: нет ли уже активной сессии по стажёру
      const activeRes = await pool.query(
        `
        SELECT id
        FROM internship_sessions
        WHERE user_id = $1
          AND finished_at IS NULL
          AND is_canceled = FALSE
        LIMIT 1
        `,
        [c.intern_user_id]
      );

      if (activeRes.rows.length) {
        await ctx
          .answerCbQuery("У стажёра уже идёт стажировка")
          .catch(() => {});
        return;
      }

      // сохраняем состояние "ожидаем ответ вовремя/опоздал"
      startInternshipStates.set(ctx.from.id, {
        candidateId,
        internUserId: Number(c.intern_user_id),
        tradePointId: Number(c.internship_point_id),
      });

      await ctx.answerCbQuery().catch(() => {});

      const text = `🕒 <b>Начать стажировку</b>\n\n` + `Стажёр пришёл вовремя?`;

      const keyboard = {
        inline_keyboard: [
          [
            {
              text: "✅ пришёл вовремя",
              callback_data: "lk_intern_start_late_no",
            },
          ],
          [{ text: "⚠️ опоздал", callback_data: "lk_intern_start_late_yes" }],
          [{ text: "❌ отмена", callback_data: "lk_intern_start_cancel" }],
        ],
      };

      await ctx.editMessageText(text, {
        parse_mode: "HTML",
        reply_markup: keyboard,
      });
    } catch (err) {
      logError("lk_cand_start_intern", err);
    }
  });

  // 2) Отмена старта (ничего не начинаем, возвращаемся на карточку)
  bot.action(/^lk_intern_start_cancel$/, async (ctx) => {
    try {
      const st = startInternshipStates.get(ctx.from.id);
      await ctx.answerCbQuery().catch(() => {});
      if (!st) return;

      startInternshipStates.delete(ctx.from.id);

      // вернёмся на карточку кандидата
      await showCandidateCardLk(ctx, st.candidateId, { edit: true });
    } catch (err) {
      logError("lk_intern_start_cancel", err);
    }
  });

  // 3) Пришёл вовремя / опоздал -> фактический старт
  bot.action(/^lk_intern_start_late_(yes|no)$/, async (ctx) => {
    try {
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin")) {
        await ctx.answerCbQuery("Нет доступа").catch(() => {});
        return;
      }

      const st = startInternshipStates.get(ctx.from.id);
      if (!st) {
        await ctx.answerCbQuery("Сценарий старта не активен").catch(() => {});
        return;
      }

      const wasLate = ctx.match[1] === "yes";
      startInternshipStates.delete(ctx.from.id);

      // пересчёт следующего дня
      const uRes = await pool.query(
        `SELECT id, full_name, staff_status, intern_days_completed, telegram_id
         FROM users
         WHERE id = $1`,
        [st.internUserId]
      );
      if (!uRes.rows.length) {
        await ctx
          .answerCbQuery("Пользователь стажёра не найден")
          .catch(() => {});
        return;
      }

      const intern = uRes.rows[0];

      // если он ещё не intern — делаем intern (иначе academy не даст стажировку)
      if (intern.staff_status !== "intern") {
        await pool.query(
          `UPDATE users
           SET staff_status = 'intern',
               intern_days_completed = COALESCE(intern_days_completed, 0)
           WHERE id = $1`,
          [intern.id]
        );
      }

      const nextDay = (intern.intern_days_completed || 0) + 1;

      // создаём сессию стажировки (как в academy bot startInternshipSession :contentReference[oaicite:3]{index=3})
      const ins = await pool.query(
        `
        INSERT INTO internship_sessions (user_id, day_number, started_by, trade_point_id, was_late)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id
        `,
        [intern.id, nextDay, admin.id, st.tradePointId, wasLate]
      );

      const sessionId = ins.rows[0].id;

      // 1) уведомление стажёру (ссылкой в academy bot)
      if (intern.telegram_id) {
        const academyBot =
          process.env.ACADEMY_BOT_USERNAME || "barista_academy_GR_bot";
        const url = `https://t.me/${academyBot}`;

        const text =
          `🌱 Стажировка началась!\n` +
          `День ${nextDay}.\n\n` +
          `Нажмите кнопку ниже, чтобы перейти к обучению.`;

        const keyboard = {
          inline_keyboard: [[{ text: "🚀 Перейти к обучению", url }]],
        };

        await ctx.telegram
          .sendMessage(intern.telegram_id, text, {
            reply_markup: keyboard,
          })
          .catch(() => {});
      }

      // 2) событие в outbox для academy bot (наставнику внутри academy bot)
      await pushOutboxEvent("academy", "internship_started", {
        intern_user_id: intern.id,
        intern_name: intern.full_name || null,
        mentor_telegram_id: ctx.from.id,
        session_id: sessionId,
        day_number: nextDay,
      });

      await ctx.answerCbQuery().catch(() => {});

      // возвращаемся на карточку кандидата (она позже будет перерисована под "стажёр/день 1")
      await showCandidateCardLk(ctx, st.candidateId, { edit: true });
    } catch (err) {
      logError("lk_intern_start_late", err);
    }
  });
}

module.exports = registerCandidateInternship;
