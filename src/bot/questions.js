// src/bot/questions.js
const { Markup } = require("telegraf");
const pool = require("../db/pool");
const { deliver } = require("../utils/renderHelpers");
const { getUserState, setUserState, clearUserState } = require("./state");

// Если у тебя уже есть свой клиент ИИ/ретривер — можешь заменить эти функции,
// но интерфейс оставь: answerText, isOfftopicSuspected.
const { GigaChat } = require("gigachat");

// ====== НАСТРОЙКИ ======
const MODE = "lk_ai_question_waiting";

// Модель / параметры можно менять
const GIGA_MODEL = process.env.GIGACHAT_MODEL || "GigaChat";
const GIGA_SCOPE = process.env.GIGACHAT_SCOPE || "GIGACHAT_API_PERS";

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

function buildAnswerKeyboard(logId) {
  return Markup.inlineKeyboard([
    [Markup.button.callback("🔁 Объяснить проще", `lk_ai_simplify_${logId}`)],
    [Markup.button.callback("❓ Задать ещё вопрос", "lk_ai_question")],
    [Markup.button.callback("⬅️ В меню", "lk_main_menu")],
  ]);
}

function initGiga() {
  const credentials = process.env.GIGACHAT_CREDENTIALS;
  if (!credentials) {
    throw new Error("GIGACHAT_CREDENTIALS is not set");
  }

  return new GigaChat({
    credentials,
    scope: GIGA_SCOPE,
  });
}

// --- 1) Основной промпт ответа (временно общий; дальше подключим “теорию/темы/запреты/контакты”) ---
function buildSystemPrompt() {
  return (
    "Ты — помощник сотрудника Green Rocket.\n" +
    "Отвечай по-деловому, структурно, коротко и понятно.\n" +
    "Если вопрос неясный — задай 1 уточняющий вопрос.\n" +
    "Если точного ответа нет — скажи честно и предложи, что проверить/у кого уточнить.\n" +
    "Не выдумывай фактов."
  );
}

// --- 2) Классификатор “похоже на не по работе?” ---
// Важно: мы НЕ блокируем ответ, только ставим флажок is_offtopic_suspected=true для админки.
async function detectOfftopic(giga, question) {
  const sys =
    "Ты классификатор. Определи: вопрос относится к рабочим вопросам Green Rocket или нет.\n" +
    "Рабочие: смены, стандарты, обязанности, регламенты, оборудование, качество, график, зарплата, точки, клиенты.\n" +
    "Нерабочие: развлечения, личная жизнь, политика, игры, мемы, вообще не про работу.\n" +
    "Ответь строго одним словом: WORK или OFFTOPIC.";

  const resp = await giga.chat({
    model: GIGA_MODEL,
    messages: [
      { role: "system", content: sys },
      { role: "user", content: question },
    ],
    temperature: 0,
  });

  const text = (resp?.choices?.[0]?.message?.content || "")
    .trim()
    .toUpperCase();
  return text.includes("OFFTOPIC");
}

// --- 3) Генерация ответа ---
async function generateAnswer(giga, question) {
  const resp = await giga.chat({
    model: GIGA_MODEL,
    messages: [
      { role: "system", content: buildSystemPrompt() },
      { role: "user", content: question },
    ],
    temperature: 0.2,
  });

  return (resp?.choices?.[0]?.message?.content || "").trim();
}

// --- 4) Переформулировать проще ---
async function simplifyAnswer(giga, question, currentAnswer) {
  const sys =
    "Ты помощник. Переформулируй ответ проще:\n" +
    "— Используй короткие фразы.\n" +
    "— Добавь простую ассоциацию/пример.\n" +
    "— Не добавляй фактов, которых не было в исходном ответе.\n" +
    "— Не пиши лишних вступлений.";

  const resp = await giga.chat({
    model: GIGA_MODEL,
    messages: [
      { role: "system", content: sys },
      {
        role: "user",
        content:
          "ВОПРОС:\n" +
          question +
          "\n\nТЕКУЩИЙ ОТВЕТ:\n" +
          currentAnswer +
          "\n\nСДЕЛАЙ ПРОЩЕ:",
      },
    ],
    temperature: 0.3,
  });

  return (resp?.choices?.[0]?.message?.content || "").trim();
}

function registerQuestions(bot, ensureUser, logError) {
  // ===== Вход в “Задать вопрос ИИ” =====
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

  // ===== Пришёл текст (сам вопрос) =====
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

      // чтобы пользователь не “залипал” в состоянии
      clearState(tgId);

      await ctx.reply("🤖 Думаю над ответом…");

      const giga = initGiga();

      // 1) подозрение “не по работе”
      let isOfftopicSuspected = false;
      try {
        isOfftopicSuspected = await detectOfftopic(giga, question);
      } catch (e) {
        // если классификатор упал — просто не ставим флаг
        isOfftopicSuspected = false;
      }

      // 2) основной ответ
      const answer = await generateAnswer(giga, question);

      // 3) логируем
      const ins = await pool.query(
        `
          INSERT INTO ai_chat_logs (user_id, question, answer, is_new_for_admin, is_offtopic_suspected)
          VALUES ($1, $2, $3, TRUE, $4)
          RETURNING id
        `,
        [user.id, question, answer, isOfftopicSuspected]
      );

      const logId = ins.rows?.[0]?.id;

      const flag = isOfftopicSuspected ? "❗ " : "";
      const text =
        `${flag}*Ответ ИИ:*\n\n` +
        `${
          answer ||
          "Не получилось сгенерировать ответ. Попробуй переформулировать вопрос."
        }`;

      await ctx.reply(text, {
        parse_mode: "Markdown",
        ...buildAnswerKeyboard(logId),
      });
    } catch (err) {
      logError("lk_ai_question_text", err);
      clearState(ctx.from.id);
      await ctx.reply(
        "Произошла ошибка при обработке вопроса. Попробуй ещё раз: нажми «🔮 Задать вопрос ИИ»."
      );
    }
  });

  // ===== “Объяснить проще” =====
  bot.action(/^lk_ai_simplify_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const logId = Number(ctx.match[1]);
      if (!Number.isFinite(logId)) return;

      const user = await ensureUser(ctx);
      if (!user) return;

      // берём исходный лог (проверяем, что это его вопрос)
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

      // по твоему требованию: НЕ храним две версии — перезаписываем answer
      await pool.query(`UPDATE ai_chat_logs SET answer = $1 WHERE id = $2`, [
        newAnswer,
        logId,
      ]);

      const flag = row.is_offtopic_suspected ? "❗ " : "";
      const text = `${flag}*Объяснение проще:*\n\n${newAnswer}`;

      // редактируем сообщение с кнопками (если не получилось — просто отправим новым)
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
}

module.exports = { registerQuestions };
