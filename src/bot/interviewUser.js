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

  // Фото точки добавим позже, когда допилим хранение

  const buttons = [
    [
      Markup.button.callback(
        "⬅️ Назад к собеседованию",
        "lk_interview_details"
      ),
    ],
  ];

  const keyboard = Markup.inlineKeyboard(buttons);

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

function buildInterviewDetailsText(candidate) {
  if (!candidate) {
    return "У вас нет назначенного собеседования.";
  }

  const dateStr = formatDateRu(candidate.interview_date);
  const timeStr = candidate.interview_time || "не указано";
  const pointTitle = candidate.point_title || "не указана";
  const pointAddress = candidate.point_address || "не указан";

  const adminName = candidate.admin_name || "не указан";
  const adminPosition = candidate.admin_position || "не указана должность";
  const adminUsername = candidate.admin_username
    ? `@${candidate.admin_username}`
    : "";

  const responsible = adminUsername
    ? `${adminName}, ${adminPosition} (${adminUsername})`
    : `${adminName}, ${adminPosition}`;

  return (
    "📄 *Детали собеседования*\n\n" +
    `• Дата: ${dateStr}\n` +
    `• Время: ${timeStr}\n` +
    `• Кофейня: ${pointTitle}\n` +
    `• Адрес: ${pointAddress}\n` +
    `• Ответственный: ${responsible}\n`
  );
}

async function showInterviewDetails(ctx, user, { edit } = {}) {
  const candidate = await getActiveInterviewCandidate(user.id);
  const text = buildInterviewDetailsText(candidate);

  const buttons = [
    [
      Markup.button.callback(
        "❌ Отказаться от собеседования",
        "lk_interview_decline"
      ),
    ],
    [Markup.button.callback("⬅️ В меню", "lk_main_menu")],
  ];

  const keyboard = Markup.inlineKeyboard(buttons);

  await deliver(
    ctx,
    { text, extra: { ...keyboard, parse_mode: "Markdown" } },
    { edit: !!edit }
  );
}

// ---------- РЕГИСТРАЦИЯ ----------

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

  // Кнопка "🧭 Как пройти?"
  bot.action("lk_interview_route", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const candidate = await getActiveInterviewCandidate(user.id);
      if (!candidate) {
        await ctx.reply("У вас нет назначенного собеседования.");
        return;
      }

      const pointTitle = candidate.point_title || "не указана";
      const pointAddress = candidate.point_address || "не указан";
      const pointLandmark = candidate.point_landmark || "не указан";

      let text = "🧭 *Как пройти*\n\n";
      text += `• Кофейня: ${pointTitle}\n`;
      text += `• Адрес: ${pointAddress}\n`;
      text += `• Ориентир: ${pointLandmark}\n`;

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "📄 Детали собеседования",
            "lk_interview_details"
          ),
        ],
        [Markup.button.callback("⬅️ В меню", "lk_interview_details")],
      ]);

      await deliver(
        ctx,
        { text, extra: { ...keyboard, parse_mode: "Markdown" } },
        { edit: false }
      );

      // Фотографии точки, если есть в базе
      try {
        const photosRes = await pool.query(
          `
            SELECT file_id
            FROM trade_point_photos
            WHERE trade_point_id = $1
            ORDER BY id
          `,
          [candidate.point_id]
        );

        for (const row of photosRes.rows) {
          if (row.file_id) {
            await ctx.replyWithPhoto(row.file_id);
          }
        }
      } catch (err) {
        // если таблицы/фото ещё нет — просто логируем
        logError("lk_interview_route_photos", err);
      }
    } catch (err) {
      logError("lk_interview_route", err);
    }
  });

  // Кнопка "❌ Отказаться от собеседования"
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

      await pool.query(
        `
          UPDATE candidates
             SET status = 'declined',
                 decline_reason = 'кандидат отказался от собеседования',
                 closed_from_status = status,
                 closed_by_admin_id = $2,
                 declined_at = NOW()
           WHERE id = $1
        `,
        [candidate.id, user.id]
      );

      await pool.query("UPDATE users SET candidate_id = NULL WHERE id = $1", [
        user.id,
      ]);

      await ctx.reply(
        "Вы отказались от собеседования.\n" +
          "Если это ошибка — свяжитесь, пожалуйста, с руководителем."
      );

      await showMainMenu(ctx);
    } catch (err) {
      logError("lk_interview_decline", err);
      await ctx.reply("Не удалось оформить отказ от собеседования.");
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
};
