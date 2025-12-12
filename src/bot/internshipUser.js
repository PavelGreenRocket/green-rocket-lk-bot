// src/bot/internshipUser.js

const pool = require("../db/pool");
const { Markup } = require("telegraf");
const { deliver } = require("../utils/renderHelpers");

// ---------- БАЗОВЫЙ ХЕЛПЕР ----------

/**
 * Ищем "активного кандидата" для пользователя:
 * users.candidate_id → candidates.id
 * и статус кандидата = 'internship_invited'
 */
async function getActiveInternshipCandidate(userId) {
  const res = await pool.query(
    `
      SELECT
        c.*,
        tp.title       AS internship_point_name,
        mentor.full_name AS internship_admin_name
      FROM users u
      JOIN candidates c
        ON c.id = u.candidate_id
      LEFT JOIN trade_points tp
        ON tp.id = c.internship_point_id
      LEFT JOIN users mentor
        ON mentor.id = c.internship_admin_id
      WHERE u.id = $1
        AND c.status = 'internship_invited'
      ORDER BY c.interview_date DESC, c.id DESC
      LIMIT 1
    `,
    [userId]
  );

  return res.rows[0] || null;
}

// Красиво форматируем дату стажировки: 09.12 (вт)
function formatDateRu(date) {
  if (!date) return "не указана";

  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return "не указана";

  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const weekday = d.toLocaleDateString("ru-RU", { weekday: "short" });

  return `${dd}.${mm} (${weekday})`;
}

function buildInternshipDetailsText(candidate) {
  if (!candidate) {
    return (
      "📄 *Детали стажировки*\n\n" +
      "Стажировка ещё не назначена.\n" +
      "Если вы уверены, что вас уже пригласили, свяжитесь с руководителем."
    );
  }

  const datePart = formatDateRu(candidate.internship_date);
  const timeFrom = candidate.internship_time_from || "не указано";
  const timeTo = candidate.internship_time_to || "не указано";
  const pointName = candidate.internship_point_name || "не указана";
  const mentorName = candidate.internship_admin_name || "не указан";

  return (
    "📄 *Детали стажировки*\n\n" +
    `• *Дата:* ${datePart}\n` +
    `• *Время:* с ${timeFrom} до ${timeTo}\n` +
    `• *Кофейня:* ${pointName}\n` +
    `• *Наставник:* ${mentorName}\n`
  );
}

/**
 * Показать экран деталей стажировки.
 * withReadButton = true → показываем кнопку "Прочитал"
 */
async function showInternshipDetails(ctx, user, { withReadButton, edit } = {}) {
  const candidate = await getActiveInternshipCandidate(user.id);

  const text = buildInternshipDetailsText(candidate);

  const buttons = [];

  if (withReadButton) {
    buttons.push([Markup.button.callback("✅ Прочитал", "lk_internship_read")]);
  }

  // Кнопки действий по стажировке
  buttons.push([
    Markup.button.callback("🧭 Ориентир", "lk_internship_orientir"),
    Markup.button.callback("💰 По оплате", "lk_internship_payment"),
  ]);

  buttons.push([
    Markup.button.callback(
      "❌ Отказаться от стажировки",
      "lk_internship_decline"
    ),
  ]);

  buttons.push([Markup.button.callback("⬅️ В меню", "lk_main_menu")]);

  const keyboard = Markup.inlineKeyboard(buttons);

  await deliver(ctx, { text, extra: keyboard }, { edit: !!edit });
}

// ---------- РЕГИСТРАЦИЯ ХЕНДЛЕРОВ ----------

function registerInternshipUser(bot, ensureUser, logError, showMainMenu) {
  // Слеш-команда, на которую мы ссылку даём в приглашении
  bot.command("стажировка", async (ctx) => {
    try {
      const user = await ensureUser(ctx);
      if (!user) return;

      await showInternshipDetails(ctx, user, {
        withReadButton: true,
        edit: false,
      });
    } catch (err) {
      logError("lk_cmd_internship", err);
      await ctx.reply("Не удалось показать детали стажировки.");
    }
  });

  // Кнопка "📄 Детали стажировки" из главного меню
  bot.action("lk_internship_details", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      await showInternshipDetails(ctx, user, {
        withReadButton: false,
        edit: true,
      });
    } catch (err) {
      logError("lk_internship_details", err);
    }
  });

  // Кнопка "✅ Прочитал"
  bot.action("lk_internship_read", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      await pool.query(
        `
          UPDATE users
          SET internship_info_read_at = NOW()
          WHERE id = $1
        `,
        [user.id]
      );

      await ctx.reply("Отлично! Ждём вас на стажировке.");
      await showMainMenu(ctx);
    } catch (err) {
      logError("lk_internship_read", err);
      await ctx.reply("Не удалось отметить, что вы прочитали детали.");
    }
  });

  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  // Кнопка "🧭 Как пройти?"
  bot.action("lk_internship_route", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const res = await pool.query(
        `
        SELECT
          c.id,
          c.internship_point_id AS point_id,
          COALESCE(tp.title, '')    AS point_title,
          COALESCE(tp.address, '')  AS point_address,
          COALESCE(tp.landmark, '') AS point_landmark
        FROM users u
        JOIN candidates c ON c.id = u.candidate_id
        LEFT JOIN trade_points tp ON tp.id = c.internship_point_id
        WHERE u.id = $1
          AND c.status = 'internship_invited'
        LIMIT 1
      `,
        [user.id]
      );

      const row = res.rows[0];
      if (!row) {
        await ctx.reply("Не удалось найти данные по стажировке.");
        return;
      }

      const pointTitle = row.point_title || "не указана";
      const address = row.point_address || "будет добавлен позже";
      const landmark = row.point_landmark || "будет добавлен позже";

      let text = "🧭 <b>Как пройти?</b>\n\n";
      text += `Кофейня: ${escapeHtml(pointTitle)}\n`;
      text += `Адрес: ${escapeHtml(address)}\n`;
      text += `Ориентир: ${escapeHtml(landmark)}\n`;

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("⬅️ Назад", "lk_internship_details")],
      ]);

      await deliver(
        ctx,
        { text, extra: { ...keyboard, parse_mode: "HTML" } },
        { edit: true }
      );

      // Фото точки (если есть)
      try {
        if (row.point_id) {
          const photosRes = await pool.query(
            `
            SELECT file_id
            FROM trade_point_photos
            WHERE trade_point_id = $1
            ORDER BY id
          `,
            [row.point_id]
          );

          for (const p of photosRes.rows) {
            if (p.file_id) {
              await ctx.replyWithPhoto(p.file_id);
            }
          }
        }
      } catch (err) {
        logError("lk_internship_route_photos", err);
      }
    } catch (err) {
      logError("lk_internship_route", err);
    }
  });

  // Кнопка "💰 По оплате" — пока заглушка
  bot.action("lk_internship_payment", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const text =
        "💰 *По оплате стажировки*\n\n" +
        "Сейчас этот раздел в разработке.\n" +
        "Позже здесь появится подробная информация об оплате стажировки.";

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("⬅️ Назад", "lk_internship_details")],
      ]);

      await deliver(ctx, { text, extra: keyboard }, { edit: true });
    } catch (err) {
      logError("lk_internship_payment", err);
    }
  });

  // Кнопка "❌ Отказаться от стажировки"
  bot.action("lk_internship_decline", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const candidate = await getActiveInternshipCandidate(user.id);
      if (!candidate) {
        await ctx.reply("У вас нет активной стажировки.");
        return;
      }

      await pool.query(
        `
          UPDATE candidates
          SET status = 'declined',
              decline_reason = 'кандидат отказался от стажировки',
              closed_from_status = status,
              closed_by_admin_id = $2,
              declined_at = NOW()
          WHERE id = $1
        `,
        [candidate.id, user.id]
      );

      // Отвязываем кандидата от пользователя
      await pool.query(`UPDATE users SET candidate_id = NULL WHERE id = $1`, [
        user.id,
      ]);

      await ctx.reply(
        "Вы отказались от стажировки. " +
          "Если это ошибка, свяжитесь с руководителем."
      );

      await showMainMenu(ctx);
    } catch (err) {
      logError("lk_internship_decline", err);
      await ctx.reply("Не удалось оформить отказ от стажировки.");
    }
  });
}

module.exports = {
  registerInternshipUser,
  getActiveInternshipCandidate,
};
