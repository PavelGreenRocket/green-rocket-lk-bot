// src/bot/admin/users/candidateInterview.js

const { Markup } = require("telegraf");
const pool = require("../../../db/pool");
const { showCandidateCardLk } = require("./candidateCard");

// Состояние опроса "итоги собеседования" по tg_id
const interviewResultByTgId = new Map();

function getState(tgId) {
  return interviewResultByTgId.get(tgId) || null;
}

function setState(tgId, patch) {
  const cur = interviewResultByTgId.get(tgId) || {};
  interviewResultByTgId.set(tgId, { ...cur, ...patch });
}

function clearState(tgId) {
  interviewResultByTgId.delete(tgId);
}

async function askOnTime(ctx, candidateId) {
  const text =
    "⏰ Кандидат пришёл вовремя?\n\n" + "Это важно для итогов собеседования.";

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "✅ Пришёл вовремя",
        `lk_cand_passed_on_time_yes_${candidateId}`
      ),
      Markup.button.callback(
        "⏱ Опоздал",
        `lk_cand_passed_on_time_no_${candidateId}`
      ),
    ],
    [
      Markup.button.callback(
        "❌ Отмена",
        `lk_cand_passed_cancel_${candidateId}`
      ),
    ],
  ]);

  if (ctx.updateType === "callback_query") {
    await ctx
      .editMessageText(text, { ...keyboard, parse_mode: "Markdown" })
      .catch(() => {});
  } else {
    await ctx.reply(text, { ...keyboard, parse_mode: "Markdown" });
  }
}

async function askLateMinutes(ctx, candidateId) {
  const text =
    "⏱ На сколько минут кандидат опоздал?\n\n" + "Напишите число, например: 5";

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "❌ Отмена",
        `lk_cand_passed_cancel_${candidateId}`
      ),
    ],
  ]);

  if (ctx.updateType === "callback_query") {
    await ctx
      .editMessageText(text, { ...keyboard, parse_mode: "Markdown" })
      .catch(() => {});
  } else {
    await ctx.reply(text, { ...keyboard, parse_mode: "Markdown" });
  }
}

async function askIssues(ctx, candidateId) {
  const text =
    "📝 Есть ли замечания по кандидату?\n\n" +
    "• Нажмите «Замечаний нет», если всё ок.\n" +
    "• Или напишите комментарий текстом.";

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "✅ Замечаний нет",
        `lk_cand_passed_issues_none_${candidateId}`
      ),
    ],
    [
      Markup.button.callback(
        "❌ Отмена",
        `lk_cand_passed_cancel_${candidateId}`
      ),
    ],
  ]);

  if (ctx.updateType === "callback_query") {
    await ctx
      .editMessageText(text, { ...keyboard, parse_mode: "Markdown" })
      .catch(() => {});
  } else {
    await ctx.reply(text, { ...keyboard, parse_mode: "Markdown" });
  }
}

async function finishInterviewResult(ctx, state) {
  const { candidateId, wasOnTime, lateMinutes, issues } = state;

  await pool.query(
    `
      UPDATE candidates
         SET status = 'interviewed',
             was_on_time = $2,
             late_minutes = $3,
             interview_comment = $4
       WHERE id = $1
    `,
    [candidateId, wasOnTime, lateMinutes ?? null, issues || null]
  );

  clearState(ctx.from.id);

  await showCandidateCardLk(ctx, candidateId, { edit: true });
}

// ---------------- РЕГИСТРАЦИЯ ----------------

function registerCandidateInterview(bot, ensureUser, logError) {
  // Старт: "✅ Собеседование пройдено"
  bot.action(/^lk_cand_passed_(\d+)$/, async (ctx) => {
    try {
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        await ctx.answerCbQuery("Нет доступа").catch(() => {});
        return;
      }
      const candidateId = Number(ctx.match[1]);
      setState(ctx.from.id, {
        candidateId,
        step: "on_time",
        wasOnTime: null,
        lateMinutes: null,
        issues: null,
      });

      await ctx.answerCbQuery().catch(() => {});
      await askOnTime(ctx, candidateId);
    } catch (err) {
      logError("lk_cand_passed_start", err);
    }
  });

  // Пришёл вовремя
  bot.action(/^lk_cand_passed_on_time_yes_(\d+)$/, async (ctx) => {
    try {
      const candidateId = Number(ctx.match[1]);
      setState(ctx.from.id, {
        candidateId,
        step: "issues",
        wasOnTime: true,
        lateMinutes: null,
      });
      await ctx.answerCbQuery().catch(() => {});
      await askIssues(ctx, candidateId);
    } catch (err) {
      logError("lk_cand_passed_on_time_yes", err);
    }
  });

  // Опоздал
  bot.action(/^lk_cand_passed_on_time_no_(\d+)$/, async (ctx) => {
    try {
      const candidateId = Number(ctx.match[1]);
      setState(ctx.from.id, {
        candidateId,
        step: "late_minutes",
        wasOnTime: false,
      });
      await ctx.answerCbQuery().catch(() => {});
      await askLateMinutes(ctx, candidateId);
    } catch (err) {
      logError("lk_cand_passed_on_time_no", err);
    }
  });

  // Замечаний нет
  bot.action(/^lk_cand_passed_issues_none_(\d+)$/, async (ctx) => {
    try {
      const candidateId = Number(ctx.match[1]);
      const state = getState(ctx.from.id);
      if (!state || state.candidateId !== candidateId) {
        await ctx.answerCbQuery().catch(() => {});
        return;
      }

      state.issues = "замечаний нет";
      await ctx.answerCbQuery().catch(() => {});
      await finishInterviewResult(ctx, state);
    } catch (err) {
      logError("lk_cand_passed_issues_none", err);
    }
  });

  // Отмена
  bot.action(/^lk_cand_passed_cancel_(\d+)$/, async (ctx) => {
    try {
      const candidateId = Number(ctx.match[1]);
      clearState(ctx.from.id);
      await ctx.answerCbQuery("Опрос отменён").catch(() => {});
      // просто вернёмся в карточку
      await showCandidateCardLk(ctx, candidateId, { edit: true });
    } catch (err) {
      logError("lk_cand_passed_cancel", err);
    }
  });

  // Текстовые шаги (опоздание / замечания)
  bot.on("text", async (ctx, next) => {
    const state = getState(ctx.from.id);
    if (!state) return next();

    try {
      if (state.step === "late_minutes") {
        const raw = (ctx.message.text || "").trim();
        const minutes = parseInt(raw, 10);
        if (!Number.isFinite(minutes) || minutes < 0 || minutes > 300) {
          await ctx.reply("Напишите целое количество минут, например: 5");
          return;
        }

        state.lateMinutes = minutes;
        state.step = "issues";
        await askIssues(ctx, state.candidateId);
        return;
      }

      if (state.step === "issues") {
        state.issues = (ctx.message.text || "").trim();
        await finishInterviewResult(ctx, state);
        return;
      }

      return next();
    } catch (err) {
      logError("lk_cand_passed_text", err);
      clearState(ctx.from.id);
      await ctx.reply("Не удалось сохранить итоги собеседования.");
    }
  });
}

module.exports = registerCandidateInterview;
