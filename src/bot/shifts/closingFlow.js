// src/bot/shifts/closingFlow.js
const { Markup } = require("telegraf");
const pool = require("../../db/pool");
const { deliver } = require("../../utils/renderHelpers");
const { getUserState, setUserState, clearUserState } = require("../state");
const { toast } = require("../../utils/toast");

const MODE = "shift_close";

// ---------- state helpers ----------
function getSt(tgId) {
  const st = getUserState(tgId);
  return st && st.mode === MODE ? st : null;
}
function setSt(tgId, patch) {
  const prev = getSt(tgId) || { mode: MODE };
  setUserState(tgId, { ...prev, ...patch });
}
function clrSt(tgId) {
  const st = getSt(tgId);
  if (st) clearUserState(tgId);
}

// ---------- helpers ----------
function isFiniteNumber(x) {
  return Number.isFinite(x) && !Number.isNaN(x);
}
function parseNumber(text) {
  const raw = String(text || "")
    .trim()
    .replace(",", ".");
  const n = Number(raw);
  return isFiniteNumber(n) ? n : null;
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

async function ensureClosingRow(shiftId) {
  await pool.query(
    `
    INSERT INTO shift_closings (shift_id)
    VALUES ($1)
    ON CONFLICT (shift_id) DO NOTHING
    `,
    [shiftId]
  );
}

async function getClosingRow(shiftId) {
  const res = await pool.query(
    `SELECT * FROM shift_closings WHERE shift_id=$1`,
    [shiftId]
  );
  return res.rows[0] || null;
}

// дневные задачи: есть ли открытые task_instances на сегодня?
async function hasOpenTodayTasks(userId) {
  try {
    const r = await pool.query(
      `
      SELECT COUNT(*)::int AS cnt
      FROM task_instances
      WHERE user_id=$1
        AND for_date = CURRENT_DATE
        AND status IN ('open')
      `,
      [userId]
    );
    return (r.rows[0]?.cnt || 0) > 0;
  } catch (e) {
    // если таблиц нет/не подключено — просто не блокируем
    return false;
  }
}

// ---------- regulated closing questions ----------
async function loadClosingQuestionsForUser(user, tradePointId) {
  const isIntern = user.staff_status === "intern";

  const commonRes = await pool.query(
    `
      SELECT id, title, answer_type, audience
      FROM shift_questions
      WHERE scope = 'closing_common' AND is_active = TRUE
      ORDER BY order_index ASC, id ASC
    `
  );

  const pointRes = await pool.query(
    `
      SELECT id, title, answer_type, audience
      FROM shift_questions
      WHERE scope = 'closing_point'
        AND trade_point_id = $1
        AND is_active = TRUE
      ORDER BY order_index ASC, id ASC
    `,
    [tradePointId]
  );

  const okAudience = (q) => (q.audience === "interns" ? isIntern : true);

  const queue = [...commonRes.rows, ...pointRes.rows].filter(okAudience);
  return queue.map((q) => ({
    questionId: q.id,
    title: q.title,
    answerType: q.answer_type, // text|number|photo|video
  }));
}

function formatQ(idx, total, q) {
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

  return `${emoji} <b>${idx}/${total}</b>\n<b>${q.title}</b>\n\n${hint}`;
}

function fmtMoney(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  return n.toLocaleString("ru-RU");
}

async function getTradePointTitle(tradePointId) {
  const r = await pool.query(
    `SELECT title FROM trade_points WHERE id=$1 LIMIT 1`,
    [tradePointId]
  );
  return r.rows[0]?.title || `#${tradePointId}`;
}

function buildClosingSummary(tpTitle, dateStr, row) {
  const lines = [];
  lines.push(`<b>${tpTitle}</b>`);
  lines.push(`${dateStr}`);

  const s1 = fmtMoney(row?.sales_total);
  if (s1) lines.push(`Сумма продаж: <b>${s1}</b>`);

  const s2 = fmtMoney(row?.sales_cash);
  if (s2) lines.push(`Наличными: <b>${s2}</b>`);

  const s3 = fmtMoney(row?.cash_in_drawer);
  if (s3) lines.push(`Наличные в кассе: <b>${s3}</b>`);

  if (row?.was_cash_collection === true) {
    const s4 = fmtMoney(row?.cash_collection_amount);
    lines.push(`Инкассация: <b>Да</b>${s4 ? ` (${s4})` : ""}`);
  } else if (row?.was_cash_collection === false) {
    lines.push(`Инкассация: <b>Нет</b>`);
  }

  if (row?.checks_count !== null && row?.checks_count !== undefined) {
    lines.push(`Чеков: <b>${row.checks_count}</b>`);
  }

  return lines.join("\n");
}

function closeKb() {
  return Markup.inlineKeyboard([
    [{ text: "📝 Изменить", callback_data: "shift_close_edit_menu" }],
    [{ text: "❌ Отмена", callback_data: "shift_close_cancel" }],
    [{ text: "⬅️ В меню", callback_data: "shift_close_to_menu" }],
  ]);
}

async function showTextStep(
  ctx,
  user,
  title,
  stepKey,
  idx,
  total,
  hint = "Введите числом:"
) {
  setSt(ctx.from.id, { step: stepKey });

  const st = getSt(ctx.from.id);
  const row = await getClosingRow(st.shiftId);

  const tpTitle = await getTradePointTitle(st.tradePointId);
  const dateStr = new Date().toLocaleDateString("ru-RU");

  const head = buildClosingSummary(tpTitle, dateStr, row);

  const text =
    `🛑 <b>${idx}/${total}</b>\n` +
    `${head}\n\n` +
    `<b>${title}</b>\n\n` +
    `${hint}`;

  await deliver(ctx, { text, extra: closeKb() }, { edit: true });
}

async function showYesNo(ctx, user, title, stepKey, idx, total) {
  setSt(ctx.from.id, { step: stepKey });

  const st = getSt(ctx.from.id);
  const row = await getClosingRow(st.shiftId);

  const tpTitle = await getTradePointTitle(st.tradePointId);
  const dateStr = new Date().toLocaleDateString("ru-RU");

  const head = buildClosingSummary(tpTitle, dateStr, row);

  const text =
    `🛑 <b>${idx}/${total}</b>\n` + `${head}\n\n` + `<b>${title}</b>`;

  const kb = Markup.inlineKeyboard([
    [{ text: "✅ Да", callback_data: `shift_close_yes_${stepKey}` }],
    [{ text: "❌ Нет", callback_data: `shift_close_no_${stepKey}` }],
    [{ text: "📝 Изменить", callback_data: "shift_close_edit_menu" }],
    [{ text: "❌ Отмена", callback_data: "shift_close_cancel" }],
    [{ text: "⬅️ В меню", callback_data: "shift_close_to_menu" }],
  ]);

  await deliver(ctx, { text, extra: kb }, { edit: true });
}

async function showEditMenu(ctx) {
  const kb = Markup.inlineKeyboard([
    [
      {
        text: "1) Общая сумма продаж",
        callback_data: "shift_close_jump_sales_total",
      },
    ],
    [
      {
        text: "2) Продажи за наличные",
        callback_data: "shift_close_jump_sales_cash",
      },
    ],
    [
      {
        text: "3) Наличные в кассе",
        callback_data: "shift_close_jump_cash_in_drawer",
      },
    ],
    [
      {
        text: "4) Инкассация (Да/Нет)",
        callback_data: "shift_close_jump_was_cash_collection",
      },
    ],
    [
      {
        text: "5) Кол-во чеков",
        callback_data: "shift_close_jump_checks_count",
      },
    ],
    [{ text: "⬅️ Назад", callback_data: "shift_close_continue" }],
  ]);
  await deliver(ctx, { text: "📝 Что изменить?", extra: kb }, { edit: true });
}

async function showRegulatedQuestion(ctx, st) {
  const q = st.queue[st.qIdx];
  const text = formatQ(st.qIdx + 1, st.queue.length, q);
  const kb = Markup.inlineKeyboard([
    [{ text: "❌ Отмена", callback_data: "shift_close_cancel" }],
    [{ text: "📝 Изменить", callback_data: "shift_close_edit_menu" }],
  ]);

  if (ctx.callbackQuery) {
    await deliver(ctx, { text, extra: kb }, { edit: true });
  } else {
    await ctx.reply(text, {
      parse_mode: "HTML",
      reply_markup: kb.reply_markup,
    });
  }
}

async function showFinishScreen(ctx, shiftId, userId) {
  const hasOpen = await hasOpenTodayTasks(userId);

  const text =
    "🛑 <b>Закрытие смены</b>\n\n" +
    (hasOpen
      ? "⚠️ Есть невыполненные задачи на сегодня.\n\nЗакрыть смену всё равно?"
      : "Всё заполнено. Закрыть смену?");

  const kb = Markup.inlineKeyboard([
    [{ text: "🛑 Закрыть смену", callback_data: "shift_close_finish" }],
    [{ text: "📝 Изменить", callback_data: "shift_close_edit_menu" }],
    [{ text: "❌ Отмена", callback_data: "shift_close_cancel" }],
  ]);

  await deliver(ctx, { text, extra: kb }, { edit: true });
}

// ---------- main start/continue ----------
async function startOrContinueClosing(ctx, user) {
  const active = await getActiveShift(user.id);
  if (!active || !active.trade_point_id) {
    await toast(ctx, "Нет активной смены (или не выбрана точка)");
    return false;
  }

  // переводим смену в closing_in_progress
  await pool.query(
    `UPDATE shifts SET status='closing_in_progress' WHERE id=$1 AND user_id=$2`,
    [active.id, user.id]
  );

  await ensureClosingRow(active.id);

  // поднимем шаг из БД
  const row = await getClosingRow(active.id);

  setSt(ctx.from.id, {
    shiftId: active.id,
    tradePointId: active.trade_point_id,
    step: row?.step || "sales_total",
  });

  // показать текущий шаг
  await showByStep(ctx, user, row?.step || "sales_total");
  return true;
}

async function showByStep(ctx, user, step) {
  const st = getSt(ctx.from.id);
  const shiftId = st.shiftId;

  // читаем актуальную строку закрытия
  const row = await getClosingRow(shiftId);
  const TOTAL = 5;

  if (step === "sales_total") {
    return showTextStep(
      ctx,
      user,
      "Введите общую сумму продаж за день",
      "sales_total",
      1,
      TOTAL
    );
  }
  if (step === "sales_cash") {
    return showTextStep(
      ctx,
      user,
      "Введите сумму продаж за наличные",
      "sales_cash",
      2,
      TOTAL
    );
  }
  if (step === "cash_in_drawer") {
    return showTextStep(
      ctx,
      user,
      "Сколько наличных в кассе? (ПЕРЕСЧИТАТЬ!)",
      "cash_in_drawer",
      3,
      TOTAL
    );
  }
  if (step === "was_cash_collection") {
    return showYesNo(
      ctx,
      user,
      "Была ли инкассация?",
      "was_cash_collection",
      4,
      TOTAL
    );
  }
  if (step === "cash_collection_amount") {
    // это подпункт 4, по UX оставляем 4/5
    return showTextStep(
      ctx,
      user,
      "Введите сумму инкассации",
      "cash_collection_amount",
      4,
      TOTAL
    );
  }
  if (step === "cash_collection_by") {
    setSt(ctx.from.id, { step: "cash_collection_by" });

    const st = getSt(ctx.from.id);
    const row = await getClosingRow(st.shiftId);

    const tpTitle = await getTradePointTitle(st.tradePointId);
    const dateStr = new Date().toLocaleDateString("ru-RU");
    const head = buildClosingSummary(tpTitle, dateStr, row);

    const text = `🛑 <b>4/5</b>\n` + `${head}\n\n` + `<b>Кто инкассировал?</b>`;

    // пока минимально: "Я" (как и было), позже расширим списком разрешённых
    const kb = Markup.inlineKeyboard([
      [{ text: "🙋 Я", callback_data: "shift_close_cash_by_me" }],
      [{ text: "📝 Изменить", callback_data: "shift_close_edit_menu" }],
      [{ text: "❌ Отмена", callback_data: "shift_close_cancel" }],
      [{ text: "⬅️ В меню", callback_data: "shift_close_to_menu" }],
    ]);

    return deliver(ctx, { text, extra: kb }, { edit: true });
  }

  if (step === "checks_count") {
    return showTextStep(
      ctx,
      user,
      "Введите количество чеков за день",
      "checks_count",
      5,
      TOTAL,
      "Введите целым числом:"
    );
  }

  if (step === "regulated") {
    // подгружаем очереди, если нет
    let stNow = getSt(ctx.from.id);
    if (!stNow.queue) {
      const queue = await loadClosingQuestionsForUser(user, stNow.tradePointId);
      stNow = { ...stNow, queue, qIdx: 0, step: "regulated" };
      setSt(ctx.from.id, stNow);

      if (!queue.length) {
        // сразу финал
        return showFinishScreen(ctx, stNow.shiftId, user.id);
      }
    }
    return showRegulatedQuestion(ctx, stNow);
  }

  // финал
  return showFinishScreen(ctx, st.shiftId, user.id);
}

// ---------- registration ----------
function registerShiftClosingFlow(bot, ensureUser, logError) {
  // Вход/продолжить закрытие (будем дергать из close.js)
  bot.action("shift_close_continue", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      await startOrContinueClosing(ctx, user);
    } catch (e) {
      logError("shift_close_continue", e);
    }
  });

  const {
    moveSingleTasksToDate,
    deleteSingleTasks,
  } = require("../../bot/uncompletedAlerts");

  // удалить
  bot.action(
    /^lk_uncompl_del_(\d+)$/,
    ensureUser(async (ctx) => {
      const shiftId = Number(ctx.match[1]);
      const n = await deleteSingleTasks(shiftId);
      await ctx
        .answerCbQuery(n ? `Удалено задач: ${n}` : "Нет разовых задач")
        .catch(() => {});
    })
  );

  // перенести -> открываем выбор дат (используем тот же UI что “Выбрать другую дату”)
  bot.action(
    /^lk_uncompl_move_(\d+)$/,
    ensureUser(async (ctx) => {
      const shiftId = Number(ctx.match[1]);
      // тут надо переиспользовать уже существующий экран выбора даты из админки
      // я делаю точный патч после того как ты скажешь: КАКОЙ callback у твоего пикера дат
      // (в проекте он точно есть, раз ты говорил что уже реализован)
    })
  );

  bot.action("shift_close_to_menu", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      // Важно: ничего не сбрасываем в БД — закрытие можно продолжить
      clrSt(ctx.from.id);

      await deliver(
        ctx,
        {
          text: "Ок. Можно продолжить закрытие смены позже.",
          extra: Markup.inlineKeyboard([
            [{ text: "⬅️ В меню", callback_data: "lk_main_menu" }],
          ]),
        },
        { edit: true }
      );
    } catch (e) {
      logError("shift_close_to_menu", e);
    }
  });

  bot.action("shift_close_edit_menu", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      await showEditMenu(ctx);
    } catch (e) {
      logError("shift_close_edit_menu", e);
    }
  });

  bot.action(/^shift_close_jump_(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      const step = ctx.match[1];

      const st = getSt(ctx.from.id);
      if (!st?.shiftId) return;

      await pool.query(`UPDATE shift_closings SET step=$1 WHERE shift_id=$2`, [
        step,
        st.shiftId,
      ]);
      setSt(ctx.from.id, { ...st, step });
      await showByStep(ctx, user, step);
    } catch (e) {
      logError("shift_close_jump", e);
    }
  });

  bot.action("shift_close_cancel", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      clrSt(ctx.from.id);
      await toast(ctx, "Ок");
      await deliver(
        ctx,
        {
          text: "Закрытие смены отменено.",
          extra: Markup.inlineKeyboard([
            [{ text: "⬅️ В меню", callback_data: "lk_main_menu" }],
          ]),
        },
        { edit: true }
      );
    } catch (e) {
      logError("shift_close_cancel", e);
    }
  });

  // yes/no по инкассации
  bot.action(/^shift_close_(yes|no)_was_cash_collection$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const st = getSt(ctx.from.id);
      if (!st?.shiftId) return;

      const was = ctx.match[1] === "yes";

      await pool.query(
        `UPDATE shift_closings
         SET was_cash_collection=$1, step=$2
         WHERE shift_id=$3`,
        [was, was ? "cash_collection_amount" : "checks_count", st.shiftId]
      );

      setSt(ctx.from.id, {
        ...st,
        step: was ? "cash_collection_amount" : "checks_count",
      });
      await showByStep(
        ctx,
        user,
        was ? "cash_collection_amount" : "checks_count"
      );
    } catch (e) {
      logError("shift_close_yesno", e);
    }
  });

  bot.action("shift_close_cash_by_me", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const st = getSt(ctx.from.id);
      if (!st?.shiftId) return;

      await pool.query(
        `UPDATE shift_closings
         SET cash_collection_by_user_id=$1, step='checks_count'
         WHERE shift_id=$2`,
        [user.id, st.shiftId]
      );

      setSt(ctx.from.id, { ...st, step: "checks_count" });
      await showByStep(ctx, user, "checks_count");
    } catch (e) {
      logError("shift_close_cash_by_me", e);
    }
  });

  // --- ввод числовых полей (text) ---
  bot.on("text", async (ctx, next) => {
    const st = getSt(ctx.from.id);
    if (!st?.shiftId) return next();

    const user = await ensureUser(ctx);
    if (!user) return;

    try {
      const step = st.step;

      if (
        ![
          "sales_total",
          "sales_cash",
          "cash_in_drawer",
          "cash_collection_amount",
          "checks_count",
        ].includes(step)
      ) {
        return next();
      }

      const n = parseNumber(ctx.message.text);
      if (n === null) {
        await ctx.reply("❌ Нужно число. Пример: 1200 или 1200.50");
        return;
      }

      if (step === "checks_count") {
        const intVal = Math.floor(n);
        if (!Number.isInteger(intVal) || intVal < 0) {
          await ctx.reply("❌ Введите целое число чеков (0, 1, 2...)");
          return;
        }
        await pool.query(
          `UPDATE shift_closings SET checks_count=$1, step='regulated' WHERE shift_id=$2`,
          [intVal, st.shiftId]
        );
        setSt(ctx.from.id, { ...st, step: "regulated" });
        await showByStep(ctx, user, "regulated");
        return;
      }

      const fieldMap = {
        sales_total: ["sales_total", "sales_cash"],
        sales_cash: ["sales_cash", "cash_in_drawer"],
        cash_in_drawer: ["cash_in_drawer", "was_cash_collection"],
        cash_collection_amount: [
          "cash_collection_amount",
          "cash_collection_by",
        ],
      };

      const [field, nextStep] = fieldMap[step];
      await pool.query(
        `UPDATE shift_closings SET ${field}=$1, step=$2 WHERE shift_id=$3`,
        [n, nextStep, st.shiftId]
      );

      setSt(ctx.from.id, { ...st, step: nextStep });
      await showByStep(ctx, user, nextStep);
    } catch (e) {
      logError("shift_close_text_step", e);
      await ctx.reply("❌ Ошибка сохранения, попробуйте ещё раз.");
    }
  });

  // --- regulated answers (text/number/photo/video) ---
  bot.on("text", async (ctx, next) => {
    const st = getSt(ctx.from.id);
    if (!st?.shiftId || st.step !== "regulated") return next();

    const user = await ensureUser(ctx);
    if (!user) return;

    try {
      const q = st.queue?.[st.qIdx];
      if (!q) return next();

      const raw = (ctx.message.text || "").trim();

      if (q.answerType === "number") {
        const n = parseNumber(raw);
        if (n === null) {
          await ctx.reply("❌ Нужно число.");
          return;
        }
        await pool.query(
          `
          INSERT INTO shift_answers (shift_id, question_id, answer_number)
          VALUES ($1,$2,$3)
          ON CONFLICT (shift_id, question_id)
          DO UPDATE SET answer_number=EXCLUDED.answer_number
          `,
          [st.shiftId, q.questionId, n]
        );
      } else if (q.answerType === "text") {
        await pool.query(
          `
          INSERT INTO shift_answers (shift_id, question_id, answer_text)
          VALUES ($1,$2,$3)
          ON CONFLICT (shift_id, question_id)
          DO UPDATE SET answer_text=EXCLUDED.answer_text
          `,
          [st.shiftId, q.questionId, raw]
        );
      } else {
        await ctx.reply("❌ Для этого вопроса нужно фото/видео.");
        return;
      }

      const nextIdx = st.qIdx + 1;
      if (nextIdx >= st.queue.length) {
        // регулируемые закончились -> финал
        setSt(ctx.from.id, { ...st, step: "finish" });
        await showFinishScreen(ctx, st.shiftId, user.id);
        return;
      }

      setSt(ctx.from.id, { ...st, qIdx: nextIdx });
      await showRegulatedQuestion(ctx, { ...st, qIdx: nextIdx });
    } catch (e) {
      logError("shift_close_regulated_text", e);
      await ctx.reply("❌ Ошибка сохранения ответа.");
    }
  });

  bot.on("photo", async (ctx, next) => {
    const st = getSt(ctx.from.id);
    if (!st?.shiftId || st.step !== "regulated") return next();
    const user = await ensureUser(ctx);
    if (!user) return;

    try {
      const q = st.queue?.[st.qIdx];
      if (!q || q.answerType !== "photo") return next();

      const photos = ctx.message.photo || [];
      const best = photos[photos.length - 1];
      if (!best?.file_id) return next();

      await pool.query(
        `
        INSERT INTO shift_answers (shift_id, question_id, file_id)
        VALUES ($1,$2,$3)
        ON CONFLICT (shift_id, question_id)
        DO UPDATE SET file_id=EXCLUDED.file_id
        `,
        [st.shiftId, q.questionId, best.file_id]
      );

      const nextIdx = st.qIdx + 1;
      if (nextIdx >= st.queue.length) {
        setSt(ctx.from.id, { ...st, step: "finish" });
        await showFinishScreen(ctx, st.shiftId, user.id);
        return;
      }
      setSt(ctx.from.id, { ...st, qIdx: nextIdx });
      await showRegulatedQuestion(ctx, { ...st, qIdx: nextIdx });
    } catch (e) {
      logError("shift_close_regulated_photo", e);
      await ctx.reply("❌ Ошибка сохранения фото.");
    }
  });

  bot.on("video", async (ctx, next) => {
    const st = getSt(ctx.from.id);
    if (!st?.shiftId || st.step !== "regulated") return next();
    const user = await ensureUser(ctx);
    if (!user) return;

    try {
      const q = st.queue?.[st.qIdx];
      if (!q || q.answerType !== "video") return next();

      const v = ctx.message.video;
      if (!v?.file_id) return next();

      await pool.query(
        `
        INSERT INTO shift_answers (shift_id, question_id, file_id)
        VALUES ($1,$2,$3)
        ON CONFLICT (shift_id, question_id)
        DO UPDATE SET file_id=EXCLUDED.file_id
        `,
        [st.shiftId, q.questionId, v.file_id]
      );

      const nextIdx = st.qIdx + 1;
      if (nextIdx >= st.queue.length) {
        setSt(ctx.from.id, { ...st, step: "finish" });
        await showFinishScreen(ctx, st.shiftId, user.id);
        return;
      }
      setSt(ctx.from.id, { ...st, qIdx: nextIdx });
      await showRegulatedQuestion(ctx, { ...st, qIdx: nextIdx });
    } catch (e) {
      logError("shift_close_regulated_video", e);
      await ctx.reply("❌ Ошибка сохранения видео.");
    }
  });

  // финальное закрытие
  bot.action("shift_close_finish", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const st = getSt(ctx.from.id);
      if (!st?.shiftId) return;

      // закрываем смену
      await pool.query(
        `UPDATE shifts SET status='closed', closed_at=NOW() WHERE id=$1 AND user_id=$2`,
        [st.shiftId, user.id]
      );

      const { createAlert } = require("../uncompletedAlerts"); // путь подправь по месту

      await createAlert(bot, { shiftId: st.shiftId });

      await pool.query(
        `UPDATE shift_closings SET finished_at=NOW() WHERE shift_id=$1`,
        [st.shiftId]
      );

      clrSt(ctx.from.id);
      await toast(ctx, "Смена закрыта ✅");
      await deliver(
        ctx,
        {
          text: "🛑 Смена закрыта ✅",
          extra: Markup.inlineKeyboard([
            [{ text: "⬅️ В меню", callback_data: "lk_main_menu" }],
          ]),
        },
        { edit: true }
      );
    } catch (e) {
      logError("shift_close_finish", e);
    }
  });
}

module.exports = { registerShiftClosingFlow, startOrContinueClosing };
