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

async function askPostTrainingControl(ctx, candidateId) {
  const text = `✅ Курс стажёра пройден.

Сотрудник может работать самостоятельно *под контролем*,  
или пока нужен *полный контроль*?

Выберите вариант:`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "✅ Может работать под контролем",
        `lk_cand_invite_post_training_control_${candidateId}_yes`
      ),
    ],
    [
      Markup.button.callback(
        "❌ нужен полный контроль",
        `lk_cand_invite_post_training_control_${candidateId}_no`
      ),
    ],
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

async function askLinkUserOrFinish(ctx, candidateId, ensureUser) {
  const res = await pool.query(
    `SELECT id FROM users WHERE candidate_id = $1 LIMIT 1`,
    [candidateId]
  );

  const st = getState(ctx.from.id);
  if (!st) return;

  if (res.rows.length) {
    const existingUserId = res.rows[0].id;

    // Берём админа из ensureUser, чтобы корректно решить показывать ли "В меню"
    const adminUser = await ensureUser(ctx);

    // Если курс уже пройден — уточняем режим контроля перед назначением
    const uRes = await pool.query(
      `SELECT training_completed_at FROM users WHERE id = $1`,
      [existingUserId]
    );
    const trainingCompleted = !!uRes.rows?.[0]?.training_completed_at;

    if (trainingCompleted) {
      setState(ctx.from.id, {
        step: "post_training_control",
        pending_link_user_id: existingUserId,
      });
      await askPostTrainingControl(ctx, candidateId);
      return;
    }

    await finishInternshipInvite(ctx, ctx.from.id, adminUser, {
      linkUserId: existingUserId,
    });
  } else {
    await askLinkUser(ctx, candidateId);
  }
}

async function showExistingUsersForLink(ctx, candidateId, ensureUser) {
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
    const adminUser = await ensureUser(ctx);
    await finishInternshipInvite(ctx, ctx.from.id, adminUser, {
      linkUserId: null,
    });

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

async function finishInternshipInvite(ctx, tgId, user, options = {}) {
  const state = getState(tgId);
  if (!state) return;

  const { candidateId, dateIso, timeFrom, timeTo, pointId, adminId } = state;

  let linkedUserId = null;
  let linkedTelegramId = null;
  let linkedName = null;

  // ВАЖНО: все изменения БД — атомарно
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 1) Обновляем кандидата как приглашённого на стажировку
    await client.query(
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

    // 2а) Привязка к существующему users.id
    if (options.linkUserId) {
      const res = await client.query(
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

    // Сохраняем режим контроля после прохождения курса (если выбран)
    if (
      typeof options.postTrainingCanWorkUnderControl === "boolean" &&
      linkedUserId
    ) {
      await client.query(
        `
    UPDATE users
       SET post_training_can_work_under_control = $2
     WHERE id = $1
    `,
        [linkedUserId, options.postTrainingCanWorkUnderControl]
      );
    }

    // 2б) Привязка из lk_waiting_users
    if (options.waitingId) {
      const wRes = await client.query(
        `
        SELECT id, telegram_id, full_name, age, phone
        FROM lk_waiting_users
        WHERE id = $1
        `,
        [options.waitingId]
      );

      if (wRes.rows.length) {
        const w = wRes.rows[0];

        const userRes = await client.query(
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

        await client.query(
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

    // 2в) Пишем/обновляем "следующую стажировку" (planned) в расписание
    await client.query(
      `
      INSERT INTO internship_schedules (
        candidate_id,
        user_id,
        trade_point_id,
        mentor_user_id,
        planned_date,
        planned_time_from,
        planned_time_to,
        status
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7,'planned')
      ON CONFLICT (candidate_id) WHERE status = 'planned'
      DO UPDATE SET
        user_id = EXCLUDED.user_id,
        trade_point_id = EXCLUDED.trade_point_id,
        mentor_user_id = EXCLUDED.mentor_user_id,
        planned_date = EXCLUDED.planned_date,
        planned_time_from = EXCLUDED.planned_time_from,
        planned_time_to = EXCLUDED.planned_time_to
      `,
      [candidateId, linkedUserId, pointId, adminId, dateIso, timeFrom, timeTo]
    );

    await client.query("COMMIT");
    clearState(tgId);
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    clearState(tgId);

    // важно: даём понятную ошибку админу, чтобы не было "уведомление пришло, а план не сохранился"
    await ctx.reply("⚠️ Не удалось назначить стажировку. Попробуйте ещё раз.");
    throw err;
  } finally {
    client.release();
  }

  // 3) Уведомления — только ПОСЛЕ успешного COMMIT
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

    if (cRes.rows.length) {
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

      const mentorName = c?.mentor_name || "не указан";
      const nameForText = c?.name || "Вы";

      function escapeHtml(s) {
        return String(s ?? "")
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;");
      }

      // телефон
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
      const mentorLine = escapeHtml(mentorName);

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

      // Берём флаг доступа в ЛК у самого стажёра (а не у админа),
      // чтобы кнопка «⬅️ В меню» показывалась корректно.
      let linkedLkEnabled = false;
      if (linkedUserId) {
        try {
          const lkRes = await pool.query(
            "SELECT lk_enabled FROM users WHERE id = $1",
            [linkedUserId]
          );
          linkedLkEnabled = lkRes.rows[0]?.lk_enabled === true;
        } catch (e) {}
      }

      if (c?.mentor_telegram_id) {
        const firstName =
          (mentorName || "Telegram").split(" ")[0] || "Telegram";
        keyboardRows.push([
          {
            text: `✈️ Telegram ${firstName}`,
            url: `tg://user?id=${c.mentor_telegram_id}`,
          },
        ]);
      }

      keyboardRows.push([
        { text: "🧭 Как пройти?", callback_data: "lk_internship_route" },
        { text: "💰 По оплате", callback_data: "lk_internship_payment" },
      ]);

      keyboardRows.push([
        {
          text: "❌ Отказаться от стажировки",
          callback_data: "lk_internship_decline",
        },
      ]);

      // В меню — показываем только если доступ в ЛК открыт
      if (linkedLkEnabled) {
        keyboardRows.push([
          {
            text: "⬅️ В меню",
            callback_data: "lk_main_menu",
          },
        ]);
      }

      await ctx.telegram
        .sendMessage(linkedTelegramId, text, {
          parse_mode: "HTML",
          reply_markup: { inline_keyboard: keyboardRows },
        })
        .catch(() => {});

      // уведомление наставнику (как было)
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
          adminTextLines.push(`• Точка: ${c.point_title || "не указана"}`);
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
        } catch (e) {}
      }
    }
  }

  // 4) Возвращаемся к карточке кандидата админу
  await showCandidateCardLk(ctx, candidateId, { edit: true });
}

// ------------- РЕГИСТРАЦИЯ ХЕНДЛЕРОВ -------------

function registerCandidateInternship(bot, ensureUser, logError) {
  // Ввод минут опоздания (для старта стажировки)
  bot.on("text", async (ctx, next) => {
    const st = startInternshipStates.get(ctx.from.id);
    if (!st || st.step !== "late_minutes") return next();

    const raw = (ctx.message?.text || "").trim();
    const mins = Number(raw);

    if (!Number.isFinite(mins) || mins < 0 || mins > 600) {
      await ctx.reply("Введите число минут от 0 до 600 (например: 7).");
      return;
    }

    st.lateMinutes = Math.floor(mins);
    startInternshipStates.set(ctx.from.id, st);

    await doStartInternship(ctx, true, st.lateMinutes);
  });

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
      await askLinkUserOrFinish(ctx, st.candidateId, ensureUser);
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
      await showExistingUsersForLink(ctx, candidateId, ensureUser);
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
      const adminUser = await ensureUser(ctx);
      await finishInternshipInvite(ctx, ctx.from.id, adminUser, { waitingId });
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
      const adminUser = await ensureUser(ctx);
      await finishInternshipInvite(ctx, ctx.from.id, adminUser, {
        linkUserId: null,
      });
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
            c.internship_date,
  c.internship_time_from,
  c.internship_time_to,
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

      if (
        !c.internship_date ||
        !c.internship_time_from ||
        !c.internship_time_to
      ) {
        await ctx
          .answerCbQuery("Стажировка не назначена полностью (нет даты/времени)")
          .catch(() => {});
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

        step: "late_choice",
        lateMinutes: null,
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
  // helper: фактический старт сессии (создание internship_sessions + сохранение опоздания)
  async function doStartInternship(ctx, wasLate, lateMinutes = null) {
    const candidateIdFromCb =
      ctx.updateType === "callback_query" && ctx.match && ctx.match[1]
        ? Number(ctx.match[1])
        : null;

    const st = startInternshipStates.get(ctx.from.id);
    if (!st) {
      // сценарий сброшен/истёк — возвращаем в карточку (как ты просил)
      await ctx.answerCbQuery("Сценарий отменён/истёк").catch(() => {});
      if (candidateIdFromCb) {
        await showCandidateCardLk(ctx, candidateIdFromCb, { edit: true });
      }
      return;
    }

    const {
      candidateId,
      internUserId,
      internTelegramId,
      internName,
      tradePointId,
      mentorUserId,
    } = st;

    try {
      // 0) если уже есть активная сессия — не создаём новую
      const activeRes = await pool.query(
        `
        SELECT id
        FROM internship_sessions
        WHERE user_id = $1
          AND finished_at IS NULL
          AND is_canceled = FALSE
        ORDER BY id DESC
        LIMIT 1
        `,
        [internUserId]
      );

      if (activeRes.rows.length) {
        startInternshipStates.delete(ctx.from.id);
        await ctx
          .answerCbQuery("У стажёра уже идёт стажировка")
          .catch(() => {});
        await showCandidateCardLk(ctx, candidateId, { edit: true });
        return;
      }

      // 1) определяем day_number = max(day_number)+1
      const dayRes = await pool.query(
        `
        SELECT COALESCE(MAX(day_number), 0)::int + 1 AS next_day
        FROM internship_sessions
        WHERE user_id = $1
        `,
        [internUserId]
      );
      const nextDay = Number(dayRes.rows[0]?.next_day || 1);

      // 2) comment про опоздание
      let comment = null;
      if (wasLate) {
        const mins = Number.isFinite(lateMinutes) ? Number(lateMinutes) : null;
        comment = mins !== null ? `Опоздание: ${mins} мин.` : "Опоздание";
      }

      // 3) создаём сессию (и получаем её id)
      const insRes = await pool.query(
        `
        INSERT INTO internship_sessions
          (user_id, day_number, started_by, trade_point_id, was_late, comment)
        VALUES
          ($1, $2, $3, $4, $5, $6)
        RETURNING id
        `,
        [
          internUserId,
          nextDay,
          mentorUserId || null,
          tradePointId || null,
          wasLate ? true : false,
          comment,
        ]
      );

      const sessionId = Number(insRes.rows[0]?.id);

      // 4) переводим кандидата в intern (один раз)
      await pool.query(
        `
  UPDATE candidates
     SET status = 'intern'
   WHERE id = $1
     AND status IN ('internship_invited', 'intern')
  `,
        [candidateId]
      );

      // 4.1) переводим пользователя (users) в intern — КЛЮЧЕВО для /start и ЛК
      await pool.query(
        `
  UPDATE users
     SET staff_status = 'intern'
   WHERE id = $1
     AND staff_status = 'candidate'
  `,
        [internUserId]
      );

      // 5) planned -> started + привязка к session_id
      //    (started → planned fallback в карточке заработает сразу)
      await pool.query(
        `
        WITH moved AS (
          UPDATE internship_schedules
             SET status = 'started',
                 session_id = $2,
                 started_at = NOW(),
                 user_id = COALESCE(user_id, $3)
           WHERE candidate_id = $1
             AND status = 'planned'
           RETURNING id
        )
        INSERT INTO internship_schedules (
          candidate_id,
          user_id,
          trade_point_id,
          mentor_user_id,
          planned_date,
          planned_time_from,
          planned_time_to,
          status,
          session_id,
          started_at
        )
        SELECT
          c.id,
          $3,
          COALESCE(c.internship_point_id, $4),
          COALESCE(c.internship_admin_id, $5),
          c.internship_date,
          c.internship_time_from,
          c.internship_time_to,
          'started',
          $2,
          NOW()
        FROM candidates c
        WHERE c.id = $1
          AND NOT EXISTS (SELECT 1 FROM moved)
        `,
        [
          candidateId,
          sessionId,
          internUserId,
          tradePointId || null,
          mentorUserId || null,
        ]
      );

      // ВАЖНО:
      // НЕ обнуляем candidates.internship_* при старте.
      // Эти поля могут временно ещё использоваться списками/старым UI.

      // 4) переводим кандидата в intern (если ещё не переведён)
      await pool.query(
        `UPDATE candidates SET status = 'intern' WHERE id = $1`,
        [candidateId]
      );

      // 4) переводим кандидата в intern (если ещё не переведён)
      await pool.query(
        `UPDATE candidates SET status = 'intern' WHERE id = $1`,
        [candidateId]
      );

      // ВАЖНО:
      // НЕ обнуляем candidates.internship_* при старте.
      // Эти поля нужны для отображения блока "О стажировке" и для списков наставника,
      // пока стажировка идёт.

      // 5) OUTBOX (academy): если курс ещё НЕ пройден — уведомляем наставника и даём кнопку «Начать курс»
      // Академический worker слушает destination='academy' и event_type='internship_started'
      const trRes = await pool.query(
        "SELECT training_completed_at FROM users WHERE id = $1",
        [internUserId]
      );
      const trainingCompletedAt = trRes.rows[0]?.training_completed_at || null;

      if (!trainingCompletedAt) {
        await pushOutboxEvent("academy", "internship_started", {
          mentor_telegram_id: Number(ctx.from.id),
          intern_user_id: Number(internUserId),
          intern_name: internName || "стажёр",
          session_id: sessionId,
          day_number: nextDay,
        });
      }

      // 6) уведомим стажёра (на всякий случай, у тебя ранее могло уйти другое уведомление)
      const text =
        "🚀 Стажировка началась!\n\n" +
        "Нажмите кнопку ниже, чтобы перейти к обучению.";

      const keyboard = {
        inline_keyboard: [
          [
            {
              text: "🚀 Перейти к обучению",
              url: "https://t.me/baristaAcademy_GR_bot",
            },
          ],
        ],
      };

      await ctx.telegram.sendMessage(internTelegramId, text, {
        parse_mode: "Markdown",
        reply_markup: keyboard,
      });

      // 6) чистим состояние и возвращаем в карточку стажёра
      startInternshipStates.delete(ctx.from.id);
      await showCandidateCardLk(ctx, candidateId, { edit: true });
    } catch (err) {
      startInternshipStates.delete(ctx.from.id);
      logError("doStartInternship", err);
      await ctx.reply("Не удалось начать стажировку. Попробуйте ещё раз.");
      await showCandidateCardLk(ctx, candidateId, { edit: true }).catch(
        () => {}
      );
    }
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
  // 4) Опоздал -> спрашиваем, на сколько минут
  bot.action(/^lk_intern_start_late_yes_(\d+)$/, async (ctx) => {
    try {
      const candidateId = Number(ctx.match[1]);
      const st = startInternshipStates.get(ctx.from.id);

      if (!st || Number(st.candidateId) !== candidateId) {
        await ctx.answerCbQuery("Сценарий старта не активен").catch(() => {});
        await showCandidateCardLk(ctx, candidateId, { edit: true }).catch(
          () => {}
        );
        return;
      }

      st.step = "late_minutes";
      startInternshipStates.set(ctx.from.id, st);

      await ctx.answerCbQuery().catch(() => {});
      await ctx
        .editMessageText(
          "На сколько минут опоздал стажёр?\n\nВведите число (например: 7).",
          {
            parse_mode: "Markdown",
            ...Markup.inlineKeyboard([
              [
                Markup.button.callback(
                  "↩️ Назад",
                  `lk_intern_start_late_back_${candidateId}`
                ),
              ],
              [
                Markup.button.callback(
                  "❌ Отмена",
                  `lk_intern_start_cancel_${candidateId}`
                ),
              ],
            ]),
          }
        )
        .catch(async () => {
          await ctx.reply(
            "На сколько минут опоздал стажёр?\n\nВведите число (например: 7).",
            {
              parse_mode: "Markdown",
              ...Markup.inlineKeyboard([
                [
                  Markup.button.callback(
                    "↩️ Назад",
                    `lk_intern_start_late_back_${candidateId}`
                  ),
                ],
                [
                  Markup.button.callback(
                    "❌ Отмена",
                    `lk_intern_start_cancel_${candidateId}`
                  ),
                ],
              ]),
            }
          );
        });
    } catch (err) {
      logError("lk_intern_start_late_yes", err);
    }
  });
  // Назад со ввода минут опоздания
  bot.action(/^lk_intern_start_late_back_(\d+)$/, async (ctx) => {
    try {
      const candidateId = Number(ctx.match[1]);
      const st = startInternshipStates.get(ctx.from.id);
      if (!st || Number(st.candidateId) !== candidateId) {
        await ctx.answerCbQuery("Сценарий старта не активен").catch(() => {});
        await showCandidateCardLk(ctx, candidateId, { edit: true }).catch(
          () => {}
        );
        return;
      }

      st.step = "late_choice";
      st.lateMinutes = null;
      startInternshipStates.set(ctx.from.id, st);

      const text = "Стажёр пришёл вовремя?";
      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "✅ Пришёл вовремя",
            `lk_intern_start_late_no_${candidateId}`
          ),
        ],
        [
          Markup.button.callback(
            "⚠️ Опоздал",
            `lk_intern_start_late_yes_${candidateId}`
          ),
        ],
        [
          Markup.button.callback(
            "❌ Отмена",
            `lk_intern_start_cancel_${candidateId}`
          ),
        ],
      ]);

      await ctx.answerCbQuery().catch(() => {});
      await ctx
        .editMessageText(text, { ...keyboard, parse_mode: "Markdown" })
        .catch(async () => {
          await ctx.reply(text, { ...keyboard, parse_mode: "Markdown" });
        });
    } catch (err) {
      logError("lk_intern_start_late_back", err);
    }
  });
}

module.exports = registerCandidateInternship;
