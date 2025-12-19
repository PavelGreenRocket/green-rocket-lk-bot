// src/bot/interviewUser.js

const pool = require("../db/pool");
const { Markup } = require("telegraf");
const { deliver } = require("../utils/renderHelpers");

// ---------- БАЗОВЫЕ ХЕЛПЕРЫ ----------

async function getActiveInterviewCandidate(userId) {
  const res = await pool.query(
    `
      SELECT
        c.*,
        tp.title      AS point_title,
        tp.address    AS point_address,
        tp.landmark   AS point_landmark,
        a.full_name   AS admin_name,
        a.position    AS admin_position,
        a.telegram_id AS admin_telegram_id,
        a.username    AS admin_username,
        a.work_phone  AS admin_work_phone
      FROM users u
      JOIN candidates c ON c.id = u.candidate_id
      LEFT JOIN trade_points tp ON tp.id = c.point_id
      LEFT JOIN users a        ON a.id = c.admin_id
      WHERE u.id = $1
        AND c.status = 'invited'
    `,
    [userId]
  );

  return res.rows[0] || null;
}

async function showInterviewRoute(ctx, user, { edit } = {}) {
  const res = await pool.query(
    `
      SELECT
  c.id,
  c.name,
  c.point_id,
  tp.title    AS point_title,
  tp.address  AS point_address,
  tp.landmark AS point_landmark
      FROM users u
      INNER JOIN candidates c ON c.id = u.candidate_id
      LEFT JOIN trade_points tp ON tp.id = c.point_id
      WHERE u.id = $1
        AND c.status = 'invited'
      LIMIT 1
    `,
    [user.id]
  );

  const row = res.rows[0];
  if (!row) {
    await ctx.reply("Не удалось найти данные по собеседованию.");
    return;
  }

  const pointTitle = row.point_title || "не указана";
  const address = row.point_address || "будет добавлен позже";
  const landmark = row.point_landmark || "будет добавлен позже";

  let text = "🧭 *Как пройти?*\n\n";
  text += `Кофейня: ${pointTitle}\n`;
  text += `Адрес: ${address}\n`;
  text += `Ориентир: ${landmark}\n`;

  // 1) подготовили keyboard как сейчас
  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "⬅️ Назад к собеседованию",
        "lk_interview_details"
      ),
    ],
  ]);

  // 2) получили фото
  let photos = [];
  if (row.point_id) {
    const photosRes = await pool.query(
      `SELECT file_id
       FROM trade_point_photos
      WHERE trade_point_id = $1
      ORDER BY id`,
      [row.point_id]
    );
    photos = photosRes.rows.map((r) => r.file_id).filter(Boolean);
  }

  // 3) если есть фото — шлём 1 фото с caption=текст и keyboard
  if (photos.length > 0) {
    await ctx.replyWithPhoto(photos[0], {
      caption: text,
      parse_mode: "Markdown",
      reply_markup: keyboard.reply_markup,
    });

    // остальные фото (если есть) — без кнопок
    for (const fileId of photos.slice(1)) {
      await ctx.replyWithPhoto(fileId);
    }
    return;
  }

  // 4) если фото нет — текстом как раньше
  await deliver(
    ctx,
    { text, extra: { ...keyboard, parse_mode: "Markdown" } },
    { edit: !!edit }
  );
}

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

function buildInterviewDetailsText(candidate) {
  if (!candidate) return "У вас нет назначенного собеседования.";

  const dateStr = escapeHtml(formatDateRu(candidate.interview_date));
  const timeStr = escapeHtml(candidate.interview_time || "не указано");
  const pointTitle = escapeHtml(candidate.point_title || "не указана");
  const pointAddress = escapeHtml(candidate.point_address || "не указан");

  const adminName = escapeHtml(candidate.admin_name || "не указан");
  const adminPos = escapeHtml(
    candidate.admin_position || "не указана должность"
  );
  const username = candidate.admin_username
    ? `@${candidate.admin_username}`
    : "";
  const responsible = username
    ? `${adminName}, ${adminPos} (${escapeHtml(username)})`
    : `${adminName}, ${adminPos}`;

  return (
    "📄 <b>Детали собеседования</b>\n\n" +
    `• Дата: ${dateStr}\n` +
    `• Время: ${timeStr}\n` +
    `• Кофейня: ${pointTitle}\n` +
    `• Адрес: ${pointAddress}\n` +
    `• Ответственный: ${responsible}\n`
  );
}

async function showInterviewDetails(ctx, user, { edit } = {}) {
  const candidate = await getActiveInterviewCandidate(user.id);

  if (!candidate || candidate.status === "rejected") {
    await ctx.answerCbQuery().catch(() => {});
    await ctx.reply("У вас нет активного приглашения на собеседование.");
    return;
  }

  const text = buildInterviewDetailsText(candidate);

  const buttons = [
    [Markup.button.callback("🧭 Как пройти?", "lk_interview_route")],
    [
      Markup.button.callback(
        "❌ Отказаться от собеседования",
        "lk_interview_decline"
      ),
    ],
  ];

  const keyboard = Markup.inlineKeyboard(buttons);

  await deliver(
    ctx,
    { text, extra: { ...keyboard, parse_mode: "HTML" } },
    { edit: !!edit }
  );
}

// ---------- РЕГИСТРАЦИЯ ----------

async function showDeclineFinalScreen(ctx, text, { edit } = {}) {
  await deliver(
    ctx,
    { text }, // без кнопок
    { edit: !!edit }
  );
}

function registerInterviewUser(bot, ensureUser, logError, showMainMenu) {
  // Слеш-команда /собеседование — можно давать ссылкой
  bot.command("собеседование", async (ctx) => {
    try {
      const user = await ensureUser(ctx);
      if (!user) return;

      await showInterviewDetails(ctx, user, { edit: false });
    } catch (err) {
      logError("lk_cmd_interview", err);
      await ctx.reply("Не удалось показать детали собеседования.");
    }
  });

  // Кнопка "📄 Детали собеседования"
  bot.action("lk_interview_details", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      await showInterviewDetails(ctx, user, { edit: true });
    } catch (err) {
      logError("lk_interview_details", err);
    }
  });

  // Кнопка "❌ Отказаться от собеседования" -> экран подтверждения
  bot.action("lk_interview_decline", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const candidate = await getActiveInterviewCandidate(user.id);
      if (!candidate) {
        await ctx.reply("У вас нет назначенного собеседования.");
        return;
      }

      const text =
        "❗️Вы точно хотите отказаться от собеседования?\n\n" +
        "Если нажмёте «Да» — ответственному придёт уведомление, " +
        "а ваша заявка перейдёт в список на удаление.";

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "✅ Да, отказаться",
            "lk_interview_decline_yes"
          ),
        ],
        [Markup.button.callback("⬅️ Нет, назад", "lk_interview_decline_no")],
      ]);

      await deliver(
        ctx,
        { text, extra: { ...keyboard, parse_mode: "Markdown" } },
        { edit: true }
      );
    } catch (err) {
      logError("lk_interview_decline_confirm", err);
    }
  });

  // Нет -> назад к деталям собеседования
  bot.action("lk_interview_decline_no", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      await showInterviewDetails(ctx, user, { edit: true });
    } catch (err) {
      logError("lk_interview_decline_no", err);
    }
  });

  // Да -> оформить отказ (идемпотентно) + уведомить ответственного
  bot.action("lk_interview_decline_yes", async (ctx) => {
    let client;
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const candidate = await getActiveInterviewCandidate(user.id);
      if (!candidate) {
        await ctx.reply("У вас нет назначенного собеседования.");
        return;
      }

      // Транзакция, чтобы не было “обновили кандидата, но не отвязали юзера”
      client = await pool.connect();
      await client.query("BEGIN");

      // ✅ ВАЖНО: статус должен быть 'rejected', т.к. "Кандидаты на удалении"
      // в админке ЛК выбираются по c.status='rejected' + declined_at not null + is_deferred=false
      // см. candidateList.js :contentReference[oaicite:1]{index=1}
      const upd = await client.query(
        `
        UPDATE candidates
           SET status = 'rejected',
               decline_reason = 'отказался сам',
               closed_from_status = status,
               closed_by_admin_id = $2,
               declined_at = NOW(),
               is_deferred = false
         WHERE id = $1
           AND status = 'invited'
        RETURNING id
      `,
        [candidate.id, user.id]
      );

      // Идемпотентность: двойной клик/повтор колбэка
      if (!upd.rowCount) {
        await ctx.reply("Отказ уже был оформлен ранее.");
        await ctx.reply("Нажмите /start");
        return;
      }

      await client.query("UPDATE users SET candidate_id = NULL WHERE id = $1", [
        user.id,
      ]);

      await client.query("COMMIT");

      // Уведомление ответственному — копипаст-паттерн из sendInterviewInvitation
      // (candidateCreate.js) :contentReference[oaicite:2]{index=2}
      if (candidate.admin_telegram_id) {
        try {
          const adminTextLines = [];
          adminTextLines.push("❌ *Кандидат отказался от собеседования*");
          adminTextLines.push("");

          adminTextLines.push(
            `• Кандидат: ${candidate.name || "без имени"}${
              candidate.age ? ` (${candidate.age})` : ""
            }`
          );

          const dateStr = formatDateRu(candidate.interview_date);
          const timeStr = candidate.interview_time || "не указано";
          const pointTitle = candidate.point_title || "не указана";
          const pointAddress =
            candidate.point_address || "будет добавлен позже";

          adminTextLines.push(`• Дата: ${dateStr}`);
          adminTextLines.push(`• Время: ${timeStr}`);
          adminTextLines.push(`• Точка: ${pointTitle}`);
          adminTextLines.push(`• Адрес: ${pointAddress}`);

          adminTextLines.push("• Причина: отказался сам");

          const adminKeyboard = Markup.inlineKeyboard([
            [
              Markup.button.callback(
                "👤 Открыть кандидата",
                `lk_cand_open_${candidate.id}`
              ),
            ],
            [
              Markup.button.callback(
                "📋 Мои собеседования",
                "lk_admin_my_interviews"
              ),
            ],
          ]);

          await ctx.telegram.sendMessage(
            candidate.admin_telegram_id,
            adminTextLines.join("\n"),
            {
              reply_markup: adminKeyboard.reply_markup,
              parse_mode: "Markdown",
            }
          );
        } catch (e) {
          logError("lk_interview_decline_notify_admin", e);
        }
      }

      await showDeclineFinalScreen(
        ctx,
        "❌ Вы отказались от собеседования.\n\n" +
          "Мы сообщили наставнику.\n" +
          "Если это ошибка — свяжитесь, пожалуйста, с руководителем."
      );
    } catch (err) {
      if (client) {
        try {
          await client.query("ROLLBACK");
        } catch (_) {}
      }
      logError("lk_interview_decline_yes", err);
      await ctx.reply("Не удалось оформить отказ от собеседования.");
    } finally {
      if (client) client.release();
    }
  });

  // Кнопка "🧭 Как пройти?" из приглашения
  bot.action("lk_interview_route", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      await showInterviewRoute(ctx, user, { edit: true });
    } catch (err) {
      logError("lk_interview_route", err);
    }
  });
}

module.exports = {
  registerInterviewUser,
  getActiveInterviewCandidate,
  showInterviewDetails,
};
