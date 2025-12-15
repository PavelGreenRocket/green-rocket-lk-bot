// src/bot/questions.js
const { Markup } = require("telegraf");
const pool = require("../db/pool");
const { deliver } = require("../utils/renderHelpers");
const { getUserState, setUserState, clearUserState } = require("./state");

const { initGiga, GIGA_MODEL } = require("../ai/client");
const { insertAiChatLog, updateAiChatAnswer } = require("../ai/logger");
const {
  loadActiveTheoryTopics,
  loadActiveBanTopics,
  loadActiveContactTopics,
  getContactTopic,
  getAdminsForContactTopic,
} = require("../ai/repository");

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

// ====== AI helpers (оставляем в файле пока) ======
async function pickTheoryTopicId(giga, question, topics) {
  if (!topics || topics.length === 0) return null;

  const list = topics
    .map((t) => `${t.id}: ${t.title}`)
    .join("\n")
    .slice(0, 6000);

  const sys =
    "Ты классификатор. Выбери наиболее подходящую тему по вопросу.\n" +
    "Отвечай строго числом — id темы из списка. Если ни одна не подходит, ответь 0.";

  const resp = await giga.chat({
    model: GIGA_MODEL,
    messages: [
      { role: "system", content: sys },
      {
        role: "user",
        content: `ВОПРОС:\n${question}\n\nТЕМЫ:\n${list}\n\nID:`,
      },
    ],
    temperature: 0,
  });

  const raw = (resp?.choices?.[0]?.message?.content || "").trim();
  const id = Number(raw.replace(/[^\d]/g, ""));
  if (!Number.isFinite(id) || id <= 0) return null;

  const exists = topics.some((t) => Number(t.id) === id);
  return exists ? id : null;
}

function buildSystemPromptWithTheory(theoryTitle, theoryContent) {
  const base =
    "Ты — помощник сотрудника Green Rocket.\n" +
    "Отвечай по-деловому, структурно, коротко и понятно.\n" +
    "Используй ТОЛЬКО информацию из блока ТЕОРИЯ, если она релевантна.\n" +
    "Если информации недостаточно — честно скажи и задай 1 уточняющий вопрос.\n" +
    "Не выдумывай фактов.\n";

  if (!theoryContent) return base;

  return (
    base +
    "\n=== ТЕОРИЯ ===\n" +
    `Тема: ${theoryTitle || "без названия"}\n` +
    `${theoryContent}\n` +
    "=== КОНЕЦ ТЕОРИИ ==="
  );
}

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

async function detectOfftopicFromBans(giga, question, bans) {
  if (!bans || bans.length === 0) {
    const suspected = await detectOfftopic(giga, question);
    return { suspected, confidence: null, matchedBanId: null };
  }

  const list = bans
    .map((b) => `${b.id}: ${b.title} — ${b.description}`)
    .join("\n")
    .slice(0, 9000);

  const sys =
    "Ты классификатор. Определи, относится ли вопрос к НЕрабочим темам из списка запретов.\n" +
    "Ответь строго JSON без текста вокруг:\n" +
    '{"suspected":true|false,"ban_id":number|null,"confidence":number}\n' +
    "confidence от 0 до 1.";

  const resp = await giga.chat({
    model: GIGA_MODEL,
    messages: [
      { role: "system", content: sys },
      {
        role: "user",
        content: `ВОПРОС:\n${question}\n\nЗАПРЕТЫ:\n${list}\n\nJSON:`,
      },
    ],
    temperature: 0,
  });

  const raw = (resp?.choices?.[0]?.message?.content || "").trim();

  try {
    const obj = JSON.parse(raw);
    const suspected = !!obj.suspected;
    const confidence =
      typeof obj.confidence === "number"
        ? Math.max(0, Math.min(1, obj.confidence))
        : null;

    const banId = Number(obj.ban_id);
    const matchedBanId =
      Number.isFinite(banId) &&
      banId > 0 &&
      bans.some((b) => Number(b.id) === banId)
        ? banId
        : null;

    return { suspected, confidence, matchedBanId };
  } catch {
    const suspected = await detectOfftopic(giga, question);
    return { suspected, confidence: null, matchedBanId: null };
  }
}

async function pickContactTopicId(giga, question, topics) {
  if (!topics || topics.length === 0) return null;

  const list = topics
    .map((t) => `${t.id}: ${t.title} — ${t.description}`)
    .join("\n")
    .slice(0, 9000);

  const sys =
    "Ты классификатор. Определи, нужна ли помощь человека по контактным темам.\n" +
    "Если вопрос подходит под одну из тем — верни id темы.\n" +
    "Если не подходит ни под одну — верни 0.\n" +
    "Ответ строго числом.";

  const resp = await giga.chat({
    model: GIGA_MODEL,
    messages: [
      { role: "system", content: sys },
      {
        role: "user",
        content: `ВОПРОС:\n${question}\n\nТЕМЫ:\n${list}\n\nID:`,
      },
    ],
    temperature: 0,
  });

  const raw = (resp?.choices?.[0]?.message?.content || "").trim();
  const id = Number(raw.replace(/[^\d]/g, ""));
  if (!Number.isFinite(id) || id <= 0) return null;

  const exists = topics.some((t) => Number(t.id) === id);
  return exists ? id : null;
}

async function generateAnswer(giga, question, systemPrompt) {
  const resp = await giga.chat({
    model: GIGA_MODEL,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: question },
    ],
    temperature: 0.2,
  });

  return (resp?.choices?.[0]?.message?.content || "").trim();
}

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

// Создаём “пользовательское” уведомление админам (через вашу систему notifications)
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

      const answer = await generateAnswer(giga, question, systemPrompt);

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

      const contactsText =
        `📞 *Контакты по теме: ${topic?.title || "—"}*\n\n` +
        admins
          .map((a) => {
            const pos = a.position ? `, ${a.position}` : "";
            const uname = a.username ? `\n@${a.username}` : "";
            const phone = a.work_phone ? `\n☎️ ${a.work_phone}` : "";
            return `• *${a.full_name}*${pos}${uname}${phone}`;
          })
          .join("\n\n");

      await ctx.reply(contactsText, {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback("⬅️ В меню", "lk_main_menu")],
        ]),
      });

      const notifyText =
        "📞 Запрос помощи по теме\n\n" +
        `От: ${user.full_name || "Пользователь"}\n` +
        (user.username ? `@${user.username}\n` : "") +
        (user.work_phone ? `☎️ ${user.work_phone}\n` : "") +
        `Тема: ${topic?.title || "—"}\n\n` +
        `Вопрос:\n${row.question}`;

      const recipientIds = admins.map((a) => a.id);

      await createNotificationForMany({
        createdBy: user.id,
        text: notifyText,
        recipientUserIds: recipientIds,
      });

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

module.exports = { registerQuestions };
