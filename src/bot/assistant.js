// src/bot/assistant.js
const { Markup } = require("telegraf");
const { deliver } = require("../utils/renderHelpers");
const GigaChat = require("gigachat").default;
const pool = require("../db/pool");
const { getRelevantChunks } = require("./knowledge");
const { Agent } = require("node:https");

const { getAiConfig } = require("../ai/settings");

console.log(
  "GIGACHAT_CREDENTIALS length =",
  (process.env.GIGACHAT_CREDENTIALS || "").length
);
console.log("GIGACHAT_SCOPE =", process.env.GIGACHAT_SCOPE);
console.log("GIGACHAT_MODEL =", process.env.GIGACHAT_MODEL);

const httpsAgent = new Agent({ rejectUnauthorized: false });

const gigaClient = new GigaChat({
  timeout: 60,
  model: process.env.GIGACHAT_MODEL || "GigaChat-2",
  credentials: process.env.GIGACHAT_CREDENTIALS,
  scope: process.env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS",
  httpsAgent,
});

const questionState = new Set();

// сколько последних логов храним (глобально)
const MAX_AI_LOGS = 500;

async function getTodayAiAnswersCount(userId, companyTz) {
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
    [userId, companyTz]
  );
  return Number(res.rows[0]?.cnt || 0);
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

async function getAssistantAnswer(question, topK) {
  const chunks = await getRelevantChunks(question, topK);

  if (!chunks.length) {
    return (
      "Я не нашёл подходящего ответа в учебной базе. " +
      "Пожалуйста, обратись к наставнику или загляни в методичку."
    );
  }

  const contextText = chunks
    .map(
      (ch, idx) =>
        `[Фрагмент ${idx + 1} из источника "${ch.source}"]\n${ch.text}`
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
          "Если информации недостаточно, честно скажи, что по базе нет точного ответа.",
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

  return (resp.choices?.[0]?.message?.content || "").trim();
}

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
      questionState.delete(ctx.from.id);

      const question = (ctx.message.text || "").trim();
      if (!question) {
        await ctx.reply("Вопрос пустой. Напиши его словами 🙂");
        return;
      }

      const cfg = await getAiConfig();

      // override лимита через карточку пользователя (если поле появится позже)
      const userLimit = Number(user.ai_daily_limit);
      const dailyLimit =
        Number.isFinite(userLimit) && userLimit > 0
          ? userLimit
          : cfg.dailyLimitDefault;

      const usedToday = await getTodayAiAnswersCount(user.id, cfg.companyTz);
      if (usedToday >= dailyLimit) {
        await ctx.reply(
          `🤖 Лимит вопросов к ИИ на сегодня исчерпан (${dailyLimit}/день).\n` +
            "Попробуй завтра или обратись к наставнику."
        );
        return;
      }

      const thinkingMsg = await ctx.reply("Думаю над ответом…");

      let answer;
      try {
        // “вопрос считается” только при успешном answer — лог пишем только после успеха
        answer = await getAssistantAnswer(question, cfg.topK);
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

      try {
        await pool.query(
          `INSERT INTO ai_chat_logs (user_id, question, answer) VALUES ($1, $2, $3)`,
          [user.id, question, answer]
        );
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

module.exports = { registerAssistant };
