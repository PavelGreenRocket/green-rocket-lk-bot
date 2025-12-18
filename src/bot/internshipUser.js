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
        tp.title        AS internship_point_name,
        tp.address      AS internship_point_address,
        tp.landmark     AS internship_point_landmark,
        mentor.full_name  AS internship_admin_name,
        mentor.position   AS internship_admin_position,
        mentor.username   AS internship_admin_username,
        mentor.telegram_id AS internship_admin_telegram_id,
        mentor.work_phone  AS internship_admin_work_phone
      FROM users u
      JOIN candidates c
        ON c.id = u.candidate_id
      LEFT JOIN trade_points tp
        ON tp.id = c.internship_point_id
      LEFT JOIN users mentor
        ON mentor.id = c.internship_admin_id
      WHERE u.id = $1
        AND c.status = 'internship_invited'
      ORDER BY c.internship_date DESC, c.id DESC
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

function escapeHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Нормализация телефона (для tel:)
function normalizePhone(raw) {
  if (!raw) return { display: null, href: null };

  const src = String(raw);
  let digits = src.replace(/\D+/g, "");

  if (digits.length === 11 && digits.startsWith("8")) {
    digits = "7" + digits.slice(1);
  }

  if (digits.length === 11 && digits.startsWith("7")) {
    const v = "+" + digits;
    return { display: v, href: v };
  }

  if (digits.length >= 10) {
    const v = "+" + digits;
    return { display: v, href: v };
  }

  return { display: src.trim(), href: null };
}

function buildInternshipDetailsText(candidate, userNameFallback = "Вы") {
  if (!candidate) {
    return (
      `<b>📄 Детали стажировки</b>\n\n` +
      `Стажировка ещё не назначена.\n` +
      `Если вы уверены, что вас уже пригласили — свяжитесь с руководителем.`
    );
  }

  const name = candidate.name || userNameFallback;

  const datePart = formatDateRu(candidate.internship_date);
  const timeFrom = candidate.internship_time_from || "не указано";
  const timeTo = candidate.internship_time_to || "не указано";

  const pointAddress =
    candidate.internship_point_address || "будет добавлен позже";
  const mentorName = candidate.internship_admin_name || "не указан";
  const phone = normalizePhone(candidate.internship_admin_work_phone);

  let text = `${escapeHtml(
    name
  )}, вы приглашены на стажировку в Green Rocket! 🚀\n\n`;
  text += `<b>📄 Детали стажировки</b>\n`;
  text += `• <b>Дата:</b> ${escapeHtml(datePart)}\n`;
  text += `• <b>Время:</b> с ${escapeHtml(timeFrom)} до ${escapeHtml(
    timeTo
  )}\n`;
  text += `• <b>Адрес:</b> ${escapeHtml(pointAddress)}\n`;
  text += `• <b>Наставник:</b> ${escapeHtml(mentorName)}\n`;

  if (phone.display) {
    if (phone.href) {
      text += `• <b>Телефон для связи:</b> <a href="tel:${escapeHtml(
        phone.href
      )}">${escapeHtml(phone.display)}</a>\n`;
    } else {
      text += `• <b>Телефон для связи:</b> ${escapeHtml(phone.display)}\n`;
    }
  }

  return text;
}

/**
 * Показать экран деталей стажировки.
 * withReadButton = true → показываем кнопку "Прочитал"
 */
async function showInternshipDetails(ctx, user, { withReadButton, edit } = {}) {
  const candidate = await getActiveInternshipCandidate(user.id);

  const text = buildInternshipDetailsText(candidate, user.full_name || "Вы");

  const rows = [];

  // (опционально) "Прочитал" — оставим как было, если нужно
  if (withReadButton) {
    rows.push([Markup.button.callback("✅ Прочитал", "lk_internship_read")]);
  }

  // Telegram наставника (если есть)
  if (candidate?.internship_admin_telegram_id) {
    const mentorName = candidate.internship_admin_name || "Наставник";
    const firstName = mentorName.split(" ")[0] || "Наставник";
    rows.push([
      Markup.button.url(
        `✈️ Telegram ${firstName}`,
        `tg://user?id=${candidate.internship_admin_telegram_id}`
      ),
    ]);
  }

  // Как пройти? + По оплате
  rows.push([
    Markup.button.callback("🧭 Как пройти?", "lk_internship_route"),
    Markup.button.callback("💰 По оплате", "lk_internship_payment"),
  ]);

  // Отказаться
  rows.push([
    Markup.button.callback(
      "❌ Отказаться от стажировки",
      "lk_internship_decline"
    ),
  ]);

  // В меню
  rows.push([Markup.button.callback("⬅️ В меню", "lk_main_menu")]);

  const keyboard = Markup.inlineKeyboard(rows);

  await deliver(
    ctx,
    { text, extra: { ...keyboard, parse_mode: "HTML" } },
    { edit: !!edit }
  );
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
        [Markup.button.callback("⬅️ В меню", "lk_main_menu")],
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
  // Кнопка "❌ Отказаться от стажировки" -> экран подтверждения
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

      const text =
        "❗️Вы точно хотите отказаться от стажировки?\n\n" +
        "Если нажмёте «Да» — наставнику придёт уведомление, " +
        "а ваша заявка перейдёт в список на удаление.";

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "✅ Да, отказаться",
            "lk_internship_decline_yes"
          ),
        ],
        [Markup.button.callback("⬅️ Нет, назад", "lk_internship_decline_no")],
      ]);

      await deliver(
        ctx,
        { text, extra: { ...keyboard, parse_mode: "Markdown" } },
        { edit: true }
      );
    } catch (err) {
      logError("lk_internship_decline_confirm", err);
    }
  });

  // Нет -> назад к деталям стажировки
  bot.action("lk_internship_decline_no", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      await showInternshipDetails(ctx, user, {
        withReadButton: false,
        edit: true,
      });
    } catch (err) {
      logError("lk_internship_decline_no", err);
    }
  });

  // Да -> оформить отказ (идемпотентно) + уведомить наставника
  bot.action("lk_internship_decline_yes", async (ctx) => {
    let client;
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const candidate = await getActiveInternshipCandidate(user.id);
      if (!candidate) {
        await ctx.reply("У вас нет активной стажировки.");
        return;
      }

      client = await pool.connect();
      await client.query("BEGIN");

      // Идемпотентно: только если кандидат ещё реально на статусе internship_invited
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
           AND status = 'internship_invited'
        RETURNING id
      `,
        [candidate.id, user.id]
      );

      if (!upd.rowCount) {
        await client.query("ROLLBACK");
        await ctx.reply("Отказ уже был оформлен ранее.");
        await showMainMenu(ctx);
        return;
      }

      await client.query("UPDATE users SET candidate_id = NULL WHERE id = $1", [
        user.id,
      ]);

      await client.query("COMMIT");

      // Уведомление наставнику — по стилю как при “назначена стажировка”
      // (там используется mentor_telegram_id и кнопки "Открыть кандидата" / "Мои стажировки") :contentReference[oaicite:2]{index=2}
      const mentorTgId = candidate.internship_admin_telegram_id;
      if (mentorTgId) {
        try {
          const adminTextLines = [];
          adminTextLines.push("❌ *Кандидат отказался от стажировки*");
          adminTextLines.push("");

          adminTextLines.push(
            `• Кандидат: ${candidate.name || "без имени"}${
              candidate.age ? ` (${candidate.age})` : ""
            }`
          );

          const datePart = formatDateRu(candidate.internship_date);
          const timeFromText = candidate.internship_time_from || "не указано";
          const timeToText = candidate.internship_time_to || "не указано";
          const pointTitle = candidate.internship_point_name || "не указана";
          const pointAddress = candidate.internship_point_address || null;

          adminTextLines.push(`• Дата: ${datePart}`);
          adminTextLines.push(`• Время: с ${timeFromText} до ${timeToText}`);
          adminTextLines.push(`• Точка: ${pointTitle}`);
          if (pointAddress) adminTextLines.push(`• Адрес: ${pointAddress}`);

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
                "📋 Мои стажировки",
                "lk_admin_my_internships"
              ),
            ],
          ]);

          await ctx.telegram.sendMessage(
            mentorTgId,
            adminTextLines.join("\n"),
            {
              parse_mode: "Markdown",
              reply_markup: adminKeyboard.reply_markup,
            }
          );
        } catch (e) {
          logError("lk_internship_decline_notify_mentor", e);
        }
      }

      await ctx.reply(
        "Вы отказались от стажировки. " +
          "Если это ошибка, свяжитесь с руководителем."
      );

      await showMainMenu(ctx);
    } catch (err) {
      if (client) {
        try {
          await client.query("ROLLBACK");
        } catch (_) {}
      }
      logError("lk_internship_decline_yes", err);
      await ctx.reply("Не удалось оформить отказ от стажировки.");
    } finally {
      if (client) client.release();
    }
  });
}

module.exports = {
  registerInternshipUser,
  getActiveInternshipCandidate,
};
