// src/ai/contact.js
const { Markup } = require("telegraf");
const pool = require("../db/pool");
const { getContactTopic, getAdminsForContactTopic } = require("./repository");

async function createNotificationForMany({
  createdBy,
  text,
  recipientUserIds,
}) {
  if (!recipientUserIds?.length) return null;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const ins = await client.query(
      `
      INSERT INTO notifications (text, created_by, created_at)
      VALUES ($1, $2, NOW())
      RETURNING id
      `,
      [text, createdBy ?? null]
    );

    const notificationId = ins.rows[0]?.id;
    if (!notificationId)
      throw new Error("Не удалось создать notifications row");

    for (const uid of recipientUserIds) {
      await client.query(
        `
        INSERT INTO user_notifications (user_id, notification_id, is_read, read_at)
        VALUES ($1, $2, false, NULL)
        ON CONFLICT DO NOTHING
        `,
        [uid, notificationId]
      );
    }

    await client.query("COMMIT");
    return notificationId;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

function formatContactsText(topic, admins) {
  return (
    `📞 *Контакты по теме: ${topic?.title || "—"}*\n\n` +
    admins
      .map((a) => {
        const pos = a.position ? `, ${a.position}` : "";
        const uname = a.username ? `\n@${a.username}` : "";
        const phone = a.work_phone ? `\n☎️ ${a.work_phone}` : "";
        return `• *${a.full_name}*${pos}${uname}${phone}`;
      })
      .join("\n\n")
  );
}

function buildNotifyText(user, topic, question) {
  return (
    "📞 Запрос помощи по теме\n\n" +
    `От: ${user.full_name || "Пользователь"}\n` +
    (user.username ? `@${user.username}\n` : "") +
    (user.work_phone ? `☎️ ${user.work_phone}\n` : "") +
    `Тема: ${topic?.title || "—"}\n\n` +
    `Вопрос:\n${question}`
  );
}

/**
 * Регистрирует handler для кнопки "📞 Связаться с администратором"
 * callback_data: lk_ai_contact_<logId>
 */
function registerAiContact(bot, ensureUser, logError) {
  bot.action(/^lk_ai_contact_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const logId = Number(ctx.match[1]);
      if (!Number.isFinite(logId)) return;

      const user = await ensureUser(ctx);
      if (!user) return;

      const res = await pool.query(
        `
          SELECT id, user_id, question, matched_contact_topic_id
          FROM ai_chat_logs
          WHERE id = $1
          LIMIT 1
        `,
        [logId]
      );

      const row = res.rows?.[0];
      if (!row) {
        await ctx.reply("Не нашёл это обращение.");
        return;
      }
      if (Number(row.user_id) !== Number(user.id)) {
        await ctx.reply("Это не твоё обращение 🙂");
        return;
      }

      const topicId = row.matched_contact_topic_id;
      if (!topicId) {
        await ctx.reply("Для этого вопроса контактная тема не определена.");
        return;
      }

      const topic = await getContactTopic(topicId);
      const admins = await getAdminsForContactTopic(topicId);

      if (!admins.length) {
        await ctx.reply("По этой теме пока не назначены администраторы.");
        return;
      }

      // 1) контакты пользователю
      await ctx.reply(formatContactsText(topic, admins), {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("⬅️ В меню", "lk_main_menu")],
        ]),
      });

      // 2) уведомления админам (в ЛК)
      const notifyText = buildNotifyText(user, topic, row.question);
      const recipientIds = admins.map((a) => a.id);

      await createNotificationForMany({
        createdBy: user.id,
        text: notifyText,
        recipientUserIds: recipientIds,
      });

      // 3) телега админам
      for (const a of admins) {
        if (a.telegram_id) {
          await bot.telegram
            .sendMessage(Number(a.telegram_id), notifyText)
            .catch(() => {});
        }
      }
    } catch (err) {
      logError("lk_ai_contact", err);
      await ctx.reply(
        "Не получилось отправить запрос администратору. Попробуй позже."
      );
    }
  });
}

module.exports = {
  registerAiContact,
};
