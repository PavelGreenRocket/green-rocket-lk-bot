// src/bot/shifts/flow.js
const { Markup } = require("telegraf");
const pool = require("../../db/pool");
const { deliver } = require("../../utils/renderHelpers");
const { getUserState, setUserState, clearUserState } = require("../state");
const { toast, alert } = require("../../utils/toast");
const { showTodayTasks } = require("../tasks/today");
const MODE = "shift_open";

function getShiftState(tgId) {
  const st = getUserState(tgId);
  return st && st.mode === MODE ? st : null;
}
function setShiftState(tgId, patch) {
  const prev = getShiftState(tgId) || { mode: MODE };
  setUserState(tgId, { ...prev, ...patch });
}
function clearShiftState(tgId) {
  const st = getShiftState(tgId);
  if (st) clearUserState(tgId);
}

async function getActiveShift(userId) {
  const res = await pool.query(
    `
      SELECT id, status, trade_point_id
      FROM shifts
      WHERE user_id = $1
        AND opened_at::date = CURRENT_DATE
        AND status IN ('opening_in_progress','opened','closing_in_progress')
      ORDER BY opened_at DESC
      LIMIT 1
    `,
    [userId]
  );
  return res.rows[0] || null;
}

async function showPickPoint(ctx) {
  const res = await pool.query(
    `
      SELECT id, title
      FROM trade_points
      WHERE is_active = TRUE
      ORDER BY id
    `
  );

  const rows = [];
  for (const p of res.rows) {
    rows.push([
      Markup.button.callback(`🏬 ${p.title}`, `shift_open_point_${p.id}`),
    ]);
  }
  rows.push([Markup.button.callback("❌ Отмена", "shift_open_cancel")]);
  const total = openingTotal(0);
  await deliver(
    ctx,
    {
      text: `🚀 <b>1/${total}</b>\n\n<b>Выберите торговую точку:</b>`,
      extra: Markup.inlineKeyboard(rows),
    },
    { edit: true }
  );
}

async function showAskCash(ctx) {
  const st = getShiftState(ctx.from.id) || {};
  const tpTitle = await getTradePointTitle(st.tradePointId);
  const total = openingTotal(0);

  const head = openingHeader(tpTitle, null);

  const kb = Markup.inlineKeyboard([
    [{ text: "⬅️ Назад", callback_data: "shift_open_back_to_points" }],
    [{ text: "❌ Отмена", callback_data: "shift_open_cancel" }],
  ]);

  await deliver(
    ctx,
    {
      text: `🚀 <b>2/${total}</b>\n${head}\n\n<b>Введите количество наличных (числом):</b>`,
      extra: kb,
    },
    { edit: true }
  );
}

async function loadShiftQuestionsForUser(user, tradePointId) {
  // staff_status: intern/worker (candidate сюда не попадёт)
  const isIntern = user.staff_status === "intern";

  const commonRes = await pool.query(
    `
      SELECT id, title, answer_type, audience
      FROM shift_questions
      WHERE scope = 'common' AND is_active = TRUE
      ORDER BY order_index ASC, id ASC
    `
  );

  const pointRes = await pool.query(
    `
      SELECT id, title, answer_type, audience
      FROM shift_questions
      WHERE scope = 'point' AND trade_point_id = $1 AND is_active = TRUE
      ORDER BY order_index ASC, id ASC
    `,
    [tradePointId]
  );

  const filterAudience = (q) => {
    if (q.audience === "interns") return isIntern;
    return true; // all
  };

  const queue = [...commonRes.rows, ...pointRes.rows].filter(filterAudience);
  return queue.map((q) => ({
    questionId: q.id,
    title: q.title,
    answerType: q.answer_type, // text|number|photo|video
  }));
}

async function getTradePointTitle(tpId) {
  if (!tpId) return null;
  const r = await pool.query(
    `SELECT title FROM trade_points WHERE id=$1 LIMIT 1`,
    [tpId]
  );
  return r.rows[0]?.title || `#${tpId}`;
}

function fmtMoney(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n.toLocaleString("ru-RU");
}

function openingHeader(tpTitle, cashAmount) {
  const lines = [];
  if (tpTitle) lines.push(`<b>${tpTitle}</b>`);
  lines.push(new Date().toLocaleDateString("ru-RU"));
  if (cashAmount !== undefined && cashAmount !== null) {
    const c = fmtMoney(cashAmount);
    if (c) lines.push(`Наличные в кассе: <b>${c}</b>`);
  }
  return lines.join("\n");
}

function openingTotal(queueLen) {
  return 2 + (queueLen || 0); // 1: точка, 2: наличные, дальше вопросы
}

function formatQuestionText(stepIndex, totalSteps, q, tpTitle, cashAmount) {
  const emoji =
    q.answerType === "photo"
      ? "📷"
      : q.answerType === "video"
      ? "🎥"
      : q.answerType === "number"
      ? "🔢"
      : "📝";

  const hint =
    q.answerType === "photo"
      ? "Пришлите фото."
      : q.answerType === "video"
      ? "Пришлите видео."
      : q.answerType === "number"
      ? "Введите число."
      : "Введите текст.";

  const head = openingHeader(tpTitle, cashAmount);

  return (
    `🚀 <b>${stepIndex}/${totalSteps}</b>\n` +
    `${head}\n\n` +
    `${emoji} <b>${q.title}</b>\n\n${hint}`
  );
}

async function showShiftQuestion(ctx, st) {
  const q = st.queue[st.idx];
  const totalSteps = openingTotal(st.queue.length);
  const stepIndex = 3 + st.idx; // 1:точка, 2:наличные, 3..N: вопросы

  const tpTitle = await getTradePointTitle(st.tradePointId);

  const text = formatQuestionText(
    stepIndex,
    totalSteps,
    q,
    tpTitle,
    st.cashAmount ?? null
  );

  const kb = Markup.inlineKeyboard([
    [{ text: "❌ Отмена", callback_data: "shift_open_cancel" }],
  ]);

  if (ctx.callbackQuery) {
    await deliver(ctx, { text, extra: kb }, { edit: true });
    return;
  }
  await ctx.reply(text, { parse_mode: "HTML", reply_markup: kb.reply_markup });
}

function registerShiftFlow(bot, ensureUser, logError) {
  // Entry point: Open/Close toggle
  bot.action("lk_shift_toggle", async (ctx) => {
    try {
      const user = await ensureUser(ctx);
      if (!user) {
        await ctx.answerCbQuery().catch(() => {});
        return;
      }

      const staffStatus = user.staff_status || "worker";
      if (staffStatus === "candidate") {
        await ctx
          .answerCbQuery(
            "Ракета ещё на старте.\nОткрыть смену можно будет после начала стажировки.",
            { show_alert: true }
          )
          .catch(() => {});
        return;
      }

      const active = await getActiveShift(user.id);

      // Пока закрытие смены сделаем позже: если смена уже есть — просто алерт
      // Пока закрытие смены сделаем позже: если смена уже есть — просто алерт
      if (active) {
        await toast(ctx, "Смена уже открыта сегодня ✅");
        return;
      }

      // Создаём смену СРАЗУ (как ты хотел): opened_at фиксируется в момент нажатия
      const ins = await pool.query(
        `
          INSERT INTO shifts (user_id, status)
          VALUES ($1, 'opening_in_progress')
          RETURNING id
        `,
        [user.id]
      );

      const shiftId = ins.rows[0].id;

      setShiftState(ctx.from.id, {
        step: "pick_point",
        shiftId,
      });

      await ctx.answerCbQuery().catch(() => {});
      await showPickPoint(ctx);
    } catch (err) {
      logError("lk_shift_toggle", err);
      await ctx.answerCbQuery("Ошибка", { show_alert: true }).catch(() => {});
    }
  });

  // Cancel opening
  bot.action("shift_open_cancel", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const st = getShiftState(ctx.from.id);
      if (st?.shiftId) {
        // можно пометить отменённую смену как closed, чтобы не висела
        await pool.query(
          `UPDATE shifts SET status='closed', closed_at=NOW() WHERE id=$1 AND user_id=$2`,
          [st.shiftId, user.id]
        );
      }
      clearShiftState(ctx.from.id);

      await deliver(
        ctx,
        {
          text: "Ок, открытие смены отменено.",
          extra: Markup.inlineKeyboard([
            [Markup.button.callback("⬅️ В меню", "lk_main_menu")],
          ]),
        },
        { edit: true }
      );
    } catch (err) {
      logError("shift_open_cancel", err);
    }
  });

  // Back to points
  bot.action("shift_open_back_to_points", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const st = getShiftState(ctx.from.id);
      if (!st) return;
      st.step = "pick_point";
      setShiftState(ctx.from.id, st);
      await showPickPoint(ctx);
    } catch (err) {
      logError("shift_open_back_to_points", err);
    }
  });

  // Pick point
  bot.action(/^shift_open_point_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const st = getShiftState(ctx.from.id);
      if (!st || st.step !== "pick_point") return;

      const pointId = Number(ctx.match[1]);

      await pool.query(
        `UPDATE shifts SET trade_point_id=$1 WHERE id=$2 AND user_id=$3`,
        [pointId, st.shiftId, user.id]
      );

      setShiftState(ctx.from.id, {
        ...st,
        step: "cash",
        tradePointId: pointId,
      });

      await showAskCash(ctx);
    } catch (err) {
      logError("shift_open_point", err);
    }
  });

  // Cash input (text)
  bot.on("text", async (ctx, next) => {
    const st = getShiftState(ctx.from.id);
    if (!st || st.step !== "cash") return next();

    try {
      const user = await ensureUser(ctx);
      if (!user) return;

      const raw = (ctx.message.text || "").trim();
      const num = Number(raw.replace(",", "."));

      if (!Number.isFinite(num)) {
        await ctx.reply("❌ Нужно число. Пример: 1200 или 1200.50");
        return;
      }

      await pool.query(
        `UPDATE shifts SET cash_amount=$1 WHERE id=$2 AND user_id=$3`,
        [num, st.shiftId, user.id]
      );

      // запускаем регулируемый опрос
      const queue = await loadShiftQuestionsForUser(user, st.tradePointId);

      if (!queue.length) {
        await pool.query(
          `UPDATE shifts SET status='opened' WHERE id=$1 AND user_id=$2`,
          [st.shiftId, user.id]
        );
        clearShiftState(ctx.from.id);

        // ✅ сразу показываем задачи на сегодня
        await showTodayTasks(ctx, user);
        return;
      }

      setShiftState(ctx.from.id, {
        ...st,
        step: "survey",
        queue,
        idx: 0,
        cashAmount: num,
      });

      // покажем первый вопрос
      await showShiftQuestion(ctx, { ...st, step: "survey", queue, idx: 0 });
      return;
    } catch (err) {
      logError("shift_cash_input", err);
      await ctx.reply("❌ Ошибка при сохранении. Попробуйте ещё раз.");
    }
  });

  bot.on("text", async (ctx, next) => {
    const st = getShiftState(ctx.from.id);
    if (!st || st.step !== "survey") return next();

    try {
      const user = await ensureUser(ctx);
      if (!user) return;

      const q = st.queue[st.idx];
      const raw = (ctx.message.text || "").trim();

      if (q.answerType === "number") {
        const num = Number(raw.replace(",", "."));
        if (!Number.isFinite(num)) {
          await ctx.reply("❌ Нужно число. Пример: 12 или 12.5");
          return;
        }
        await pool.query(
          `
            INSERT INTO shift_answers (shift_id, question_id, answer_number)
            VALUES ($1, $2, $3)
            ON CONFLICT (shift_id, question_id) DO UPDATE SET answer_number = EXCLUDED.answer_number
          `,
          [st.shiftId, q.questionId, num]
        );
      } else if (q.answerType === "text") {
        await pool.query(
          `
            INSERT INTO shift_answers (shift_id, question_id, answer_text)
            VALUES ($1, $2, $3)
            ON CONFLICT (shift_id, question_id) DO UPDATE SET answer_text = EXCLUDED.answer_text
          `,
          [st.shiftId, q.questionId, raw]
        );
      } else {
        // ждали фото/видео, а пришёл текст
        await ctx.reply(
          "❌ Для этой задачи нужно фото/видео. Отправьте нужный формат."
        );
        return;
      }

      // следующий вопрос
      const nextIdx = st.idx + 1;
      if (nextIdx >= st.queue.length) {
        // опрос завершён — открываем смену (следующий шаг: чек-лист)
        await pool.query(
          `UPDATE shifts SET status='opened' WHERE id=$1 AND user_id=$2`,
          [st.shiftId, user.id]
        );
        await pool.query(
          `UPDATE shifts SET status='opened' WHERE id=$1 AND user_id=$2`,
          [st.shiftId, user.id]
        );
        clearShiftState(ctx.from.id);

        // ✅ сразу показываем экран задач на сегодня
        await showTodayTasks(ctx, user);
        return;
      }
      const newSt = { ...st, idx: nextIdx };
      setShiftState(ctx.from.id, newSt);
      await showShiftQuestion(ctx, newSt);
    } catch (err) {
      logError("shift_survey_text", err);
      await ctx.reply("❌ Ошибка при сохранении ответа. Попробуйте ещё раз.");
    }
  });

  bot.on("photo", async (ctx, next) => {
    const st = getShiftState(ctx.from.id);
    if (!st || st.step !== "survey") return next();

    try {
      const user = await ensureUser(ctx);
      if (!user) return;

      const q = st.queue[st.idx];
      if (q.answerType !== "photo") return next();

      const photos = ctx.message.photo || [];
      const best = photos[photos.length - 1];
      if (!best?.file_id) return next();

      await pool.query(
        `
          INSERT INTO shift_answers (shift_id, question_id, file_id)
          VALUES ($1, $2, $3)
          ON CONFLICT (shift_id, question_id) DO UPDATE SET file_id = EXCLUDED.file_id
        `,
        [st.shiftId, q.questionId, best.file_id]
      );

      const nextIdx = st.idx + 1;
      if (nextIdx >= st.queue.length) {
        await pool.query(
          `UPDATE shifts SET status='opened' WHERE id=$1 AND user_id=$2`,
          [st.shiftId, user.id]
        );
        await pool.query(
          `UPDATE shifts SET status='opened' WHERE id=$1 AND user_id=$2`,
          [st.shiftId, user.id]
        );
        clearShiftState(ctx.from.id);

        // ✅ сразу показываем экран задач на сегодня
        await showTodayTasks(ctx, user);
        return;
      }

      setShiftState(ctx.from.id, { ...st, idx: nextIdx });
      await ctx.reply(
        formatQuestionText(nextIdx + 1, st.queue.length, st.queue[nextIdx]),
        {
          parse_mode: "HTML",
          reply_markup: Markup.inlineKeyboard([
            [{ text: "❌ Отмена", callback_data: "shift_open_cancel" }],
          ]).reply_markup,
        }
      );
    } catch (err) {
      logError("shift_survey_photo", err);
      await ctx.reply("❌ Ошибка при сохранении фото. Попробуйте ещё раз.");
    }
  });

  bot.on("video", async (ctx, next) => {
    const st = getShiftState(ctx.from.id);
    if (!st || st.step !== "survey") return next();

    try {
      const user = await ensureUser(ctx);
      if (!user) return;

      const q = st.queue[st.idx];
      if (q.answerType !== "video") return next();

      const v = ctx.message.video;
      if (!v?.file_id) return next();

      await pool.query(
        `
          INSERT INTO shift_answers (shift_id, question_id, file_id)
          VALUES ($1, $2, $3)
          ON CONFLICT (shift_id, question_id) DO UPDATE SET file_id = EXCLUDED.file_id
        `,
        [st.shiftId, q.questionId, v.file_id]
      );

      const nextIdx = st.idx + 1;
      if (nextIdx >= st.queue.length) {
        await pool.query(
          `UPDATE shifts SET status='opened' WHERE id=$1 AND user_id=$2`,
          [st.shiftId, user.id]
        );
        clearShiftState(ctx.from.id);
        await pool.query(
          `UPDATE shifts SET status='opened' WHERE id=$1 AND user_id=$2`,
          [st.shiftId, user.id]
        );
        clearShiftState(ctx.from.id);

        await showTodayTasks(ctx, user);
        return;
      }

      setShiftState(ctx.from.id, { ...st, idx: nextIdx });
      await ctx.reply(
        formatQuestionText(nextIdx + 1, st.queue.length, st.queue[nextIdx]),
        {
          parse_mode: "HTML",
          reply_markup: Markup.inlineKeyboard([
            [{ text: "❌ Отмена", callback_data: "shift_open_cancel" }],
          ]).reply_markup,
        }
      );
    } catch (err) {
      logError("shift_survey_video", err);
      await ctx.reply("❌ Ошибка при сохранении видео. Попробуйте ещё раз.");
    }
  });
}

module.exports = { registerShiftFlow };
