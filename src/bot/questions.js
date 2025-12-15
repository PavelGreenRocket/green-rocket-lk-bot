// src/bot/questions.js
const { Markup } = require("telegraf");
const pool = require("../db/pool");
const { deliver } = require("../utils/renderHelpers");
const { getUserState, setUserState, clearUserState } = require("./state");

const { initGiga } = require("../ai/client");
const { insertAiChatLog, updateAiChatAnswer } = require("../ai/logger");
const {
  loadActiveTheoryTopics,
  loadActiveBanTopics,
  loadActiveContactTopics,
} = require("../ai/repository");

const {
  pickTheoryTopicId,
  detectOfftopicFromBans,
  pickContactTopicId,
} = require("../ai/classifier");

const {
  buildSystemPromptWithTheory,
  generateAnswer,
  simplifyAnswer,
} = require("../ai/answerer");

const { registerAiContact } = require("../ai/contact");

// ====== НАСТРОЙКИ ======
const MODE = "lk_ai_question_waiting";

function getState(tgId) {
  const st = getUserState(tgId);
  return st && st.mode === MODE ? st : null;
}

function setState(tgId, patch) {
  const prev = getState(tgId) || { mode: MODE, step: "await_question" };
  setUserState(tgId, { ...prev, ...patch });
}

function clearState(tgId) {
  const st = getState(tgId);
  if (st) clearUserState(tgId);
}

function buildAskKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("⬅️ В меню", "lk_main_menu")],
  ]);
}

function buildAnswerKeyboard(logId, hasContact = false) {
  const rows = [];

  rows.push([
    Markup.button.callback("🔁 Объяснить проще", `lk_ai_simplify_${logId}`),
  ]);

  if (hasContact) {
    rows.push([
      Markup.button.callback(
        "📞 Связаться с администратором",
        `lk_ai_contact_${logId}`
      ),
    ]);
  }

  rows.push([Markup.button.callback("❓ Задать ещё вопрос", "lk_ai_question")]);
  rows.push([Markup.button.callback("⬅️ В меню", "lk_main_menu")]);

  return Markup.inlineKeyboard(rows);
}

function registerQuestions(bot, ensureUser, logError) {
  bot.action("lk_ai_question", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const staffStatus = user.staff_status || "worker";
      if (staffStatus === "candidate") {
        await ctx
          .answerCbQuery(
            "Ракета ещё на старте.\nЗадавать вопросы через ИИ можно будет после начала стажировки.",
            { show_alert: true }
          )
          .catch(() => {});
        return;
      }

      setState(ctx.from.id, { step: "await_question" });

      await deliver(
        ctx,
        {
          text:
            "🔮 *Вопрос ИИ*\n\n" +
            "Напиши свой вопрос сообщением в чат.\n" +
            "Например: “Что делать, если сломалась кофемашина?”\n\n" +
            "_ИИ отвечает по рабочим вопросам. Любые вопросы можно задать, но подозрительные будут отмечены для проверки админом._",
          extra: { parse_mode: "Markdown", ...buildAskKeyboard() },
        },
        { edit: true }
      );
    } catch (err) {
      logError("lk_ai_question", err);
    }
  });

  bot.on("text", async (ctx, next) => {
    const tgId = ctx.from.id;
    const st = getState(tgId);
    if (!st || st.step !== "await_question") return next();

    try {
      const user = await ensureUser(ctx);
      if (!user) return;

      const question = (ctx.message.text || "").trim();
      if (!question) {
        await ctx.reply("Напиши вопрос текстом 🙂");
        return;
      }

      clearState(tgId);

      await ctx.reply("🤖 Думаю над ответом…");

      const giga = initGiga();

      // 1) запреты -> подозрение
      const bans = await loadActiveBanTopics(50);

      let isOfftopicSuspected = false;
      let confidenceScore = null;

      try {
        const off = await detectOfftopicFromBans(giga, question, bans);
        isOfftopicSuspected = off.suspected;
        confidenceScore = off.confidence;
      } catch {
        isOfftopicSuspected = false;
        confidenceScore = null;
      }

      // 2) теория -> подбор темы -> prompt
      const theoryTopics = await loadActiveTheoryTopics(30);

      let matchedTheoryTopicId = null;
      let systemPrompt = buildSystemPromptWithTheory(null, null);

      try {
        matchedTheoryTopicId = await pickTheoryTopicId(
          giga,
          question,
          theoryTopics
        );
        if (matchedTheoryTopicId) {
          const t = theoryTopics.find(
            (x) => Number(x.id) === Number(matchedTheoryTopicId)
          );
          systemPrompt = buildSystemPromptWithTheory(t?.title, t?.content);
        }
      } catch {
        matchedTheoryTopicId = null;
        systemPrompt = buildSystemPromptWithTheory(null, null);
      }

      // 2.5) контактные темы
      const contactTopics = await loadActiveContactTopics(50);

      let matchedContactTopicId = null;
      try {
        matchedContactTopicId = await pickContactTopicId(
          giga,
          question,
          contactTopics
        );
      } catch {
        matchedContactTopicId = null;
      }

      // 3) ответ
      const answer = await generateAnswer(giga, question, systemPrompt);

      // 4) лог
      const logId = await insertAiChatLog({
        userId: user.id,
        question,
        answer,
        isOfftopicSuspected,
        confidenceScore,
        matchedTheoryTopicId,
        matchedContactTopicId,
      });

      const flag = isOfftopicSuspected ? "❗ " : "";
      const text =
        `${flag}*Ответ ИИ:*\n\n` +
        `${
          answer ||
          "Не получилось сгенерировать ответ. Попробуй переформулировать вопрос."
        }`;

      await ctx.reply(text, {
        parse_mode: "Markdown",
        ...buildAnswerKeyboard(logId, !!matchedContactTopicId),
      });
    } catch (err) {
      logError("lk_ai_question_text", err);
      clearState(ctx.from.id);
      await ctx.reply(
        "Произошла ошибка при обработке вопроса. Попробуй ещё раз: нажми «🔮 Задать вопрос ИИ»."
      );
    }
  });

  bot.action(/^lk_ai_simplify_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const logId = Number(ctx.match[1]);
      if (!Number.isFinite(logId)) return;

      const user = await ensureUser(ctx);
      if (!user) return;

      const res = await pool.query(
        `
          SELECT id, user_id, question, answer, is_offtopic_suspected
          FROM ai_chat_logs
          WHERE id = $1
          LIMIT 1
        `,
        [logId]
      );

      const row = res.rows?.[0];
      if (!row) {
        await ctx.reply("Не нашёл это сообщение. Возможно, оно уже удалено.");
        return;
      }

      if (Number(row.user_id) !== Number(user.id)) {
        await ctx.reply("Это не твой вопрос 🙂");
        return;
      }

      const giga = initGiga();
      const newAnswer = await simplifyAnswer(giga, row.question, row.answer);

      await updateAiChatAnswer({ logId, answer: newAnswer });

      const flag = row.is_offtopic_suspected ? "❗ " : "";
      const text = `${flag}*Объяснение проще:*\n\n${newAnswer}`;

      await ctx
        .editMessageText(text, {
          parse_mode: "Markdown",
          ...buildAnswerKeyboard(logId),
        })
        .catch(async () => {
          await ctx.reply(text, {
            parse_mode: "Markdown",
            ...buildAnswerKeyboard(logId),
          });
        });
    } catch (err) {
      logError("lk_ai_simplify", err);
      await ctx.reply("Не получилось упростить ответ. Попробуй ещё раз позже.");
    }
  });

  // Контактная эскалация вынесена в src/ai/contact.js
  registerAiContact(bot, ensureUser, logError);
}

module.exports = { registerQuestions };
