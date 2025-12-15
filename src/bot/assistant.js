// src/bot/assistant.js

const { Markup } = require("telegraf");
const { deliver } = require("../utils/renderHelpers");
const GigaChat = require("gigachat").default;
const pool = require("../db/pool");
const { getRelevantChunks } = require("./knowledge");
const { Agent } = require("node:https");

console.log(
  "GIGACHAT_CREDENTIALS length =",
  (process.env.GIGACHAT_CREDENTIALS || "").length
);
console.log("GIGACHAT_SCOPE =", process.env.GIGACHAT_SCOPE);
console.log("GIGACHAT_MODEL =", process.env.GIGACHAT_MODEL);

// агент, чтобы не заморачиваться с сертификатами (как в доке GigaChat)
const httpsAgent = new Agent({
  rejectUnauthorized: false,
});

const gigaClient = new GigaChat({
  timeout: 60,
  model: process.env.GIGACHAT_MODEL || "GigaChat-2",
  credentials: process.env.GIGACHAT_CREDENTIALS,
  scope: process.env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS",
  httpsAgent,
});

// состояние: ждём вопрос от конкретного пользователя (по telegram_id)
const questionState = new Set();

// --- настройки ---
const MAX_AI_LOGS = 500; // сколько последних обращений к ИИ храним в БД
const TOP_K_CHUNKS = 3; // K=3 (top-K фрагментов базы знаний)
const DEFAULT_DAILY_LIMIT = 3; // 3 успешных ответа в день
const COMPANY_TZ = process.env.COMPANY_TZ || "Europe/Moscow"; // локальное время компании

async function getTodayAiAnswersCount(userId) {
  // day_start считаем по TZ компании
  const res = await pool.query(
    `
    WITH bounds AS (
      SELECT (date_trunc('day', now() AT TIME ZONE $2) AT TIME ZONE $2) AS day_start
    )
    SELECT COUNT(*) AS cnt
    FROM ai_chat_logs
    WHERE user_id = $1
      AND created_at >= (SELECT day_start FROM bounds)
    `,
    [userId, COMPANY_TZ]
  );

  return Number(res.rows[0]?.cnt || 0);
}

async function enforceDailyLimit(userId) {
  const used = await getTodayAiAnswersCount(userId);
  return used < DEFAULT_DAILY_LIMIT;
}

async function trimAiLogsToMax() {
  await pool.query(
    `
    DELETE FROM ai_chat_logs
    WHERE id NOT IN (
      SELECT id
      FROM ai_chat_logs
      ORDER BY created_at DESC
      LIMIT $1
    )
    `,
    [MAX_AI_LOGS]
  );
}

/**
 * Вызов GigaChat: короткий ответ на вопрос бариста
 * теперь ассистент опирается на базу знаний
 */
async function getAssistantAnswer(question) {
  // 1) ищем подходящие фрагменты теории (K=3)
  const chunks = await getRelevantChunks(question, TOP_K_CHUNKS);

  if (!chunks.length) {
    return (
      "Я не нашёл подходящего ответа в учебной базе. " +
      "Пожалуйста, обратись к наставнику или загляни в методичку."
    );
  }

  const contextText = chunks
    .map(
      (ch, idx) =>
        `[Фрагмент ${idx + 1} из источника "${ch.source}"]\n` + ch.text
    )
    .join("\n\n---\n\n");

  const resp = await gigaClient.chat({
    messages: [
      {
        role: "system",
        content:
          "Ты — наставник по обучению бариста в кофейне. " +
          "Отвечай строго на основе приведённых ниже фрагментов учебной базы. " +
          "Не выдумывай факты, которых там нет. " +
          "Если информации недостаточно, честно скажи, что по базе нет точного ответа. " +
          "Если вопрос связан с качеством, техникой приготовления, правилами сервиса или теорией, " +
          "при необходимости можно обратиться к менеджеру по качеству +7 913 457 5883 (Шах). " +
          "По всем другим вопросам — к главному администратору @k0nfe11ka (Ярослава).",
      },
      {
        role: "user",
        content:
          "Вопрос бариста:\n" +
          question +
          "\n\nВот выдержки из учебной базы:\n\n" +
          contextText +
          "\n\nСформулируй короткий и понятный ответ, опираясь только на эти фрагменты.",
      },
    ],
    temperature: 0.3,
    max_tokens: 400,
  });

  const answer = resp.choices?.[0]?.message?.content || "";
  return answer.trim();
}

/**
 * Регистрация хендлеров ассистента
 */
function registerAssistant(bot, ensureUser, logError) {
  bot.action("user_ask_question", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      questionState.add(ctx.from.id);

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("🔙 В меню", "back_main")],
      ]);

      await deliver(
        ctx,
        {
          text:
            "❓ Задай свой вопрос по обучению бариста.\n\n" +
            "Например:\n" +
            "• почему кофе получается кислым?\n" +
            "• как понять, что молоко взбито правильно?\n" +
            "• что делать, если эспрессо течёт слишком быстро?\n\n" +
            "Напиши вопрос одним сообщением.",
          extra: keyboard,
        },
        { edit: true }
      );
    } catch (err) {
      logError("user_ask_question", err);
    }
  });

  bot.on("text", async (ctx, next) => {
    try {
      const user = await ensureUser(ctx);
      if (!user) return next();

      if (!questionState.has(ctx.from.id)) return next();

      // это вопрос для ассистента
      questionState.delete(ctx.from.id);

      const question = (ctx.message.text || "").trim();
      if (!question) {
        await ctx.reply("Вопрос пустой. Напиши его словами 🙂");
        return;
      }

      // лимит 3 успешных ответа в день
      const allowed = await enforceDailyLimit(user.id);
      if (!allowed) {
        await ctx.reply(
          "🤖 Лимит вопросов к ИИ на сегодня исчерпан (3/день).\n" +
            "Попробуй завтра или обратись к наставнику."
        );
        return;
      }

      const thinkingMsg = await ctx.reply("Думаю над ответом…");

      let answer;
      try {
        answer = await getAssistantAnswer(question);
      } catch (err) {
        logError("getAssistantAnswer", err);
        await ctx.telegram.editMessageText(
          thinkingMsg.chat.id,
          thinkingMsg.message_id,
          undefined,
          "Не удалось получить подсказку от ассистента. Попробуй ещё раз позже."
        );
        return;
      }

      // ---- ЛОГИРУЕМ (успешный ответ = считается как “вопрос”) ----
      try {
        await pool.query(
          `
          INSERT INTO ai_chat_logs (user_id, question, answer)
          VALUES ($1, $2, $3)
          `,
          [user.id, question, answer]
        );

        // храним не больше MAX_AI_LOGS последних записей (глобально)
        await trimAiLogsToMax();
      } catch (err) {
        logError("ai_chat_logs_insert", err);
      }

      const keyboard = Markup.inlineKeyboard([
        [Markup.button.callback("❓ Задать ещё вопрос", "user_ask_question")],
        [Markup.button.callback("🔙 В меню", "back_main")],
      ]);

      await ctx.telegram.editMessageText(
        thinkingMsg.chat.id,
        thinkingMsg.message_id,
        undefined,
        `❓ Твой вопрос:\n${question}\n\n💡 Подсказка:\n${answer}`,
        { reply_markup: keyboard.reply_markup }
      );
    } catch (err) {
      logError("assistant_on_text", err);
      return next();
    }
  });
}

module.exports = {
  registerAssistant,
};
