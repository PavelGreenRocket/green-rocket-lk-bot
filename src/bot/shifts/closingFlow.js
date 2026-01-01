// src/bot/shifts/closingFlow.js
const { Markup } = require("telegraf");
const pool = require("../../db/pool");
const { deliver } = require("../../utils/renderHelpers");
const { getUserState, setUserState, clearUserState } = require("../state");
const { toast } = require("../../utils/toast");
const { buildStatusText, buildMainKeyboard } = require("../menu");
const {
  loadCashCollectorsPage,
  isCashCollectorForPoint,
} = require("./cashCollectors");

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
  const r = await pool.query(
    `
    SELECT
      sc.*,
      u.full_name AS cash_collection_by_name,
      u.username  AS cash_collection_by_username
    FROM shift_closings sc
    LEFT JOIN users u ON u.id = sc.cash_collection_by_user_id
    WHERE sc.shift_id = $1
    `,
    [shiftId]
  );
  return r.rows[0] || null;
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
  lines.push(tpTitle);
  lines.push(dateStr);
  lines.push(`Сумма продаж: <b>${fmtMoney(row.sales_total)}</b>`);
  lines.push(`Наличными: <b>${fmtMoney(row.sales_cash)}</b>`);
  lines.push(`Наличные в кассе: <b>${fmtMoney(row.cash_in_drawer)}</b>`);

  if (row.was_cash_collection) {
    const amount = fmtMoney(row.cash_collection_amount);
    const by =
      row.cash_collection_by_name ||
      (row.cash_collection_by_username
        ? "@" + row.cash_collection_by_username
        : null);
    lines.push(`Инкассация: <b>${amount}</b>${by ? ` (${by})` : ""}`);
  } else if (row.was_cash_collection === false) {
    lines.push(`Инкассация: <b>Нет</b>`);
  } else {
    lines.push(`Инкассация: <b>-</b>`);
  }

  if (row.checks_count != null) {
    lines.push(`Чеков: <b>${row.checks_count}</b>`);
  }

  return lines.join("\n");
}
function closeKb() {
  return Markup.inlineKeyboard([
    [{ text: "📝 Изменить", callback_data: "shift_close_edit_menu" }],
    [{ text: "❌ Отмена", callback_data: "shift_close_cancel" }],
    [{ text: "⬅️ К смене", callback_data: "shift_close_to_menu" }],
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
  const tpTitle = await getTradePointTitle(st.tradePointId);
  const dateStr = new Date().toLocaleDateString("ru-RU");
  const row = await getClosingRow(st.shiftId);
  const head = buildClosingSummary(tpTitle, dateStr, row);

  const text = `🛑 <b>${idx}/${total}</b>\n${head}\n\n${title}`;

  const kbRows = [
    [
      { text: "✅ Да", callback_data: `shift_close_yes_${stepKey}` },
      { text: "❌ Нет", callback_data: `shift_close_no_${stepKey}` },
    ],
    [{ text: "📝 Изменить", callback_data: "shift_close_edit_menu" }],
    [{ text: "❌ Отмена", callback_data: "shift_close_cancel" }],
    [{ text: "⬅️ К смене", callback_data: "shift_close_to_menu" }],
  ];

  return deliver(
    ctx,
    {
      text,
      extra: Markup.inlineKeyboard(kbRows),
    },
    { edit: true }
  );
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

async function showRegulatedQuestion(ctx, user, st, { edit = true } = {}) {
  const queue = st.queue || [];
  const qIdx = Number.isInteger(st.qIdx) ? st.qIdx : 0;
  const q = queue[qIdx];

  if (!q) {
    return showFinishScreen(ctx, user, { edit });
  }

  const TOTAL = 5 + queue.length;
  const idx = 5 + qIdx + 1;

  const tpTitle = await getTradePointTitle(st.tradePointId);
  const dateStr = new Date().toLocaleDateString("ru-RU");
  const row = await getClosingRow(st.shiftId);
  const head = buildClosingSummary(tpTitle, dateStr, row);

  const emoji =
    q.answerType === "number"
      ? "🔢"
      : q.answerType === "photo"
      ? "📷"
      : q.answerType === "video"
      ? "🎥"
      : "📝";

  const hint =
    q.answerType === "number"
      ? "Введите число."
      : q.answerType === "photo"
      ? "Отправьте фото."
      : q.answerType === "video"
      ? "Отправьте видео."
      : "Введите текст.";

  const text = `🛑 <b>${idx}/${TOTAL}</b>\n${head}\n\n${emoji} <b>${q.title}</b>\n\n${hint}`;

  return deliver(ctx, { text, extra: closeKb() }, { edit });
}

async function showFinishScreen(ctx, user, { edit = true } = {}) {
  const st = getSt(ctx.from.id);
  if (!st) return;

  const queueLen = Array.isArray(st.queue) ? st.queue.length : 0;
  const TOTAL = 5 + queueLen;

  const tpTitle = await getTradePointTitle(st.tradePointId);
  const dateStr = new Date().toLocaleDateString("ru-RU");
  const row = await getClosingRow(st.shiftId);
  const head = buildClosingSummary(tpTitle, dateStr, row);

  const hasOpen = await hasOpenTodayTasks(user.id);
  const question = hasOpen
    ? "⚠️ Внимание: у вас есть незакрытые задачи за сегодня.\n\nВсё заполнено. Закрыть смену всё равно?"
    : "Всё заполнено. Закрыть смену?";

  const tr = await pool.query(
    `
    SELECT id
    FROM shift_transfer_requests
   WHERE from_shift_id = $1
  AND status = 'accepted'
    ORDER BY id DESC
    LIMIT 1
    `,
    [Number(st.shiftId)]
  );

  const isTransfer = !!tr.rows[0];

  const kb = Markup.inlineKeyboard([
    [
      {
        text: isTransfer ? "🔁 Передать смену" : "🛑 Закрыть смену",
        callback_data: "shift_close_finish",
      },
    ],
    [{ text: "📝 Изменить", callback_data: "shift_close_edit_menu" }],
    [{ text: "❌ Отмена", callback_data: "shift_close_cancel" }],
    [{ text: "⬅️ К смене", callback_data: "shift_close_to_menu" }],
  ]);

  const text = `🛑 <b>${TOTAL}/${TOTAL}</b>\n${head}\n\n${question}`;

  return deliver(ctx, { text, extra: kb }, { edit });
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
  let st = getSt(ctx.from.id);
  if (!st) return;

  // Подгружаем доп. вопросы заранее, чтобы:
  // 1) считать корректный TOTAL (5 + N)
  // 2) иметь список для шага regulated
  if (!Array.isArray(st.queue)) {
    let queue = [];
    try {
      queue = await loadClosingQuestionsForUser(user, st.tradePointId);
    } catch (e) {
      queue = [];
    }
    st = { ...st, queue };
    setSt(ctx.from.id, st);
  }

  const TOTAL = 5 + (st.queue?.length || 0);

  // 1) сумма продаж
  if (step === "sales_total") {
    return showTextStep(
      ctx,
      user,
      "Введите сумму продаж за день",
      "sales_total",
      1,
      TOTAL,
      "Введите числом:"
    );
  }

  // 2) наличные
  if (step === "sales_cash") {
    return showTextStep(
      ctx,
      user,
      "Введите сумму наличных продаж",
      "sales_cash",
      2,
      TOTAL,
      "Введите числом:"
    );
  }

  // 3) наличные в кассе
  if (step === "cash_in_drawer") {
    return showTextStep(
      ctx,
      user,
      "Введите сумму наличных в кассе",
      "cash_in_drawer",
      3,
      TOTAL,
      "Введите числом:"
    );
  }

  // 4) была инкассация?
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

  // 4) сумма инкассации
  if (step === "cash_collection_amount") {
    return showTextStep(
      ctx,
      user,
      "Введите сумму инкассации",
      "cash_collection_amount",
      4,
      TOTAL,
      "Введите числом:"
    );
  }

  // 4) кто инкассировал
  if (step === "cash_collection_by") {
    setSt(ctx.from.id, { step: "cash_collection_by" });

    const tpTitle = await getTradePointTitle(st.tradePointId);
    const dateStr = new Date().toLocaleDateString("ru-RU");
    const row = await getClosingRow(st.shiftId);
    const head = buildClosingSummary(tpTitle, dateStr, row);

    // Берём назначенных через trade_point_responsibles (event_type = cash_collection_access)
    // Если ничего не назначено — показываем fallback "Я".
    const PAGE = 10;
    const page = Number.isInteger(st.cashByPage) ? st.cashByPage : 0;
    let collectors = [];
    let hasMore = false;
    try {
      const r = await loadCashCollectorsPage(pool, st.tradePointId, page, PAGE);
      collectors = r.rows;
      hasMore = r.hasMore;
    } catch (_) {
      collectors = [];
      hasMore = false;
    }

    const kbRows = [];

    // "Я" показываем только если:
    // - вообще никто не назначен (fallback), или
    // - текущий пользователь назначен к этой точке
    let showMe = false;
    if (!collectors.length) {
      showMe = true; // fallback
    } else {
      try {
        showMe = await isCashCollectorForPoint(pool, st.tradePointId, user.id);
      } catch (_) {
        showMe = false;
      }
    }
    if (showMe) {
      kbRows.push([{ text: "🙋 Я", callback_data: "shift_close_cash_by_me" }]);
    }

    for (const u of collectors) {
      const label =
        u.full_name || (u.username ? "@" + u.username : `ID ${u.id}`);
      kbRows.push([
        {
          text: label,
          callback_data: `shift_close_cash_by_${u.id}`,
        },
      ]);
    }

    if (page > 0 || hasMore) {
      kbRows.push([
        ...(page > 0
          ? [{ text: "⬅️", callback_data: "shift_close_cash_by_prev" }]
          : []),
        ...(hasMore
          ? [{ text: "➡️", callback_data: "shift_close_cash_by_next" }]
          : []),
      ]);
    }

    kbRows.push([
      { text: "📝 Изменить", callback_data: "shift_close_edit_menu" },
    ]);
    kbRows.push([{ text: "❌ Отмена", callback_data: "shift_close_cancel" }]);
    kbRows.push([{ text: "⬅️ К смене", callback_data: "shift_close_to_menu" }]);

    const text = `🛑 <b>4/${TOTAL}</b>\n${head}\n\nКто инкассировал?`;

    return deliver(
      ctx,
      {
        text,
        extra: Markup.inlineKeyboard(kbRows),
      },
      { edit: true }
    );
  }

  // 5) количество чеков
  if (step === "checks_count") {
    return showTextStep(
      ctx,
      user,
      "Введите количество чеков",
      "checks_count",
      5,
      TOTAL,
      "Введите целым числом:"
    );
  }

  // доп. вопросы (shift_questions)
  if (step === "regulated") {
    const queue = Array.isArray(st.queue) ? st.queue : [];

    // если нет вопросов — сразу финал
    if (!queue.length) {
      return showFinishScreen(ctx, user, { edit: true });
    }

    let qIdx = Number.isInteger(st.qIdx) ? st.qIdx : null;

    // восстановление позиции (если бот перезапускали и локальный state пуст)
    if (qIdx === null) {
      try {
        const ans = await pool.query(
          `SELECT shift_question_id FROM shift_answers WHERE shift_id = $1`,
          [st.shiftId]
        );
        const answered = new Set(
          ans.rows.map((r) => Number(r.shift_question_id))
        );
        let i = 0;
        while (i < queue.length && answered.has(Number(queue[i].questionId)))
          i++;
        qIdx = i;
      } catch (e) {
        qIdx = 0;
      }
    }

    if (qIdx >= queue.length) {
      setSt(ctx.from.id, { qIdx: queue.length });
      return showFinishScreen(ctx, user, { edit: true });
    }

    st = { ...st, step: "regulated", qIdx };
    setSt(ctx.from.id, st);

    return showRegulatedQuestion(ctx, user, st, { edit: true });
  }

  // финал (подтверждение)
  if (step === "finish") {
    return showFinishScreen(ctx, user, { edit: true });
  }
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

  // удалить (только разовые задачи)
  bot.action(/^lk_uncompl_del_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const shiftId = Number(ctx.match[1]);
      const n = await deleteSingleTasks(shiftId);

      await ctx
        .answerCbQuery(
          n ? `Удалено разовых задач: ${n}` : "Разовых задач нет",
          {
            show_alert: false,
          }
        )
        .catch(() => {});
    } catch (e) {
      logError("lk_uncompl_del", e);
    }
  });

  async function fetchUncompletedForShift(shiftId) {
    const s = await pool.query(
      `
    SELECT
      s.id,
      s.trade_point_id,
      tp.title AS point_title,
      u.full_name AS worker_name,
      u.work_phone AS worker_phone,
      u.username AS worker_username
    FROM shifts s
    JOIN users u ON u.id = s.user_id
    JOIN trade_points tp ON tp.id = s.trade_point_id
    WHERE s.id = $1
    `,
      [shiftId]
    );
    const shift = s.rows[0];
    if (!shift) return null;

    const t = await pool.query(
      `
    SELECT
      ti.id,
      tt.title,
      COALESCE(ts.schedule_type, 'single') AS schedule_type
    FROM task_instances ti
    JOIN task_templates tt ON tt.id = ti.template_id
    LEFT JOIN task_schedules ts ON ts.assignment_id = ti.assignment_id
    WHERE ti.user_id = (SELECT user_id FROM shifts WHERE id = $1)
      AND ti.trade_point_id = (SELECT trade_point_id FROM shifts WHERE id = $1)
      AND ti.for_date = CURRENT_DATE
      AND ti.status = 'open'
    ORDER BY ti.id
    `,
      [shiftId]
    );

    const items = t.rows.map((r) => ({
      id: Number(r.id),
      title: r.title,
      schedule_type: r.schedule_type,
    }));

    return { shift, items };
  }

  function buildUncomplText(shift, items) {
    const lines = [];
    lines.push("⚠️ *Смена закрыта с невыполненными задачами*");
    lines.push("");
    lines.push(`Точка: *${shift.point_title}*`);
    lines.push(`Дата: *${new Date().toLocaleDateString("ru-RU")}*`);
    lines.push("");
    lines.push(`Сотрудник: *${shift.worker_name || "—"}*`);
    lines.push(`Тел: ${shift.worker_phone || "—"}`);
    lines.push(
      `Username: ${shift.worker_username ? `@${shift.worker_username}` : "—"}`
    );
    lines.push("");
    lines.push("Невыполнено:");
    if (!items.length) lines.push("—");
    items.forEach((t, i) => {
      const tag = t.schedule_type === "single" ? "разовая" : "по расписанию";
      lines.push(`${i + 1}. ${t.title} (${tag})`);
    });
    return lines.join("\n");
  }

  bot.action(/^lk_uncompl_delpart_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const shiftId = Number(ctx.match[1]);
      const data = await fetchUncompletedForShift(shiftId);
      if (!data) return;

      // показываем только разовые задачи
      const singles = data.items.filter((x) => x.schedule_type === "single");

      const rows = [];
      singles.forEach((t, idx) => {
        rows.push([
          Markup.button.callback(
            `${idx + 1}`,
            `lk_uncompl_delone_${shiftId}_${t.id}`
          ),
        ]);
      });
      rows.push([
        Markup.button.callback(
          "✅ Готово",
          `lk_uncompl_delpart_done_${shiftId}`
        ),
      ]);

      const text = buildUncomplText(data.shift, data.items);

      await ctx.editMessageText(
        "🧩 *Удалить часть задач*\n\nНажимай номер — задача будет удалена.\n\n" +
          text,
        { parse_mode: "Markdown", ...Markup.inlineKeyboard(rows) }
      );
    } catch (e) {
      logError("lk_uncompl_delpart", e);
    }
  });

  bot.action(/^lk_uncompl_delone_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const shiftId = Number(ctx.match[1]);
      const taskId = Number(ctx.match[2]);

      await pool.query(`DELETE FROM task_instances WHERE id = $1`, [taskId]);

      const data = await fetchUncompletedForShift(shiftId);
      if (!data) return;

      const singles = data.items.filter((x) => x.schedule_type === "single");

      const rows = [];
      singles.forEach((t, idx) => {
        rows.push([
          Markup.button.callback(
            `${idx + 1}`,
            `lk_uncompl_delone_${shiftId}_${t.id}`
          ),
        ]);
      });
      rows.push([
        Markup.button.callback(
          "✅ Готово",
          `lk_uncompl_delpart_done_${shiftId}`
        ),
      ]);

      const text = buildUncomplText(data.shift, data.items);

      await ctx.editMessageText(
        "🧩 *Удалить часть задач*\n\nНажимай номер — задача будет удалена.\n\n" +
          text,
        { parse_mode: "Markdown", ...Markup.inlineKeyboard(rows) }
      );
    } catch (e) {
      logError("lk_uncompl_delone", e);
    }
  });

  bot.action(/^lk_uncompl_delpart_done_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const shiftId = Number(ctx.match[1]);
      const data = await fetchUncompletedForShift(shiftId);
      if (!data) return;

      const singles = data.items.filter((x) => x.schedule_type === "single");

      const rows = [];
      if (singles.length) {
        rows.push([
          Markup.button.callback("📅 Перенести", `lk_uncompl_move_${shiftId}`),
          Markup.button.callback(
            "🧩 Удалить часть",
            `lk_uncompl_delpart_${shiftId}`
          ),
        ]);
        rows.push([
          Markup.button.callback("🗑 Удалить все", `lk_uncompl_del_${shiftId}`),
        ]);
      }

      const text = buildUncomplText(data.shift, data.items);

      await ctx.editMessageText(text, {
        parse_mode: "Markdown",
        ...(rows.length ? Markup.inlineKeyboard(rows) : {}),
      });
    } catch (e) {
      logError("lk_uncompl_delpart_done", e);
    }
  });

  // перенести -> показать выбор дат
  bot.action(/^lk_uncompl_move_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const shiftId = Number(ctx.match[1]);

      const dates = [];
      // ближайшие 7 дней (как “выбрать другую дату” по смыслу)
      for (let i = 0; i < 7; i++) {
        const d = new Date();
        d.setDate(d.getDate() + i);
        const yyyy = d.getFullYear();
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");
        const iso = `${yyyy}-${mm}-${dd}`;
        const ru = `${dd}.${mm}.${yyyy}`;
        dates.push({ iso, ru });
      }

      const rows = dates.map((x) => [
        Markup.button.callback(
          x.ru,
          `lk_uncompl_move_date_${shiftId}_${x.iso}`
        ),
      ]);
      rows.push([
        Markup.button.callback("⬅️ Назад", `lk_uncompl_back_${shiftId}`),
      ]);

      await ctx
        .editMessageText(
          "📅 *Перенос разовых задач*\n\nВыберите дату, на которую перенести *разовые* невыполненные задачи:",
          { parse_mode: "Markdown", ...Markup.inlineKeyboard(rows) }
        )
        .catch(async () => {
          // если нельзя edit (например, сообщение уже старое) — просто ответим новым
          await ctx.reply(
            "📅 *Перенос разовых задач*\n\nВыберите дату, на которую перенести *разовые* невыполненные задачи:",
            { parse_mode: "Markdown", ...Markup.inlineKeyboard(rows) }
          );
        });
    } catch (e) {
      logError("lk_uncompl_move", e);
    }
  });

  // выбор даты переноса
  bot.action(
    /^lk_uncompl_move_date_(\d+)_(\d{4}-\d{2}-\d{2})$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery().catch(() => {});
        const user = await ensureUser(ctx);
        if (!user) return;

        const shiftId = Number(ctx.match[1]);
        const isoDate = ctx.match[2];

        const moved = await moveSingleTasksToDate(shiftId, isoDate);

        const dd = isoDate.slice(8, 10);
        const mm = isoDate.slice(5, 7);
        const yyyy = isoDate.slice(0, 4);
        const ru = `${dd}.${mm}.${yyyy}`;

        await ctx
          .editMessageText(
            moved
              ? `✅ Перенесено разовых задач: *${moved}*\nДата: *${ru}*`
              : "Разовых задач для переноса нет.",
            { parse_mode: "Markdown" }
          )
          .catch(async () => {
            await ctx.reply(
              moved
                ? `✅ Перенесено разовых задач: *${moved}*\nДата: *${ru}*`
                : "Разовых задач для переноса нет.",
              { parse_mode: "Markdown" }
            );
          });
      } catch (e) {
        logError("lk_uncompl_move_date", e);
      }
    }
  );

  // назад из выбора дат (возвращаем исходное уведомление с кнопками)
  bot.action(/^lk_uncompl_back_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const shiftId = Number(ctx.match[1]);

      await ctx
        .editMessageReplyMarkup(
          Markup.inlineKeyboard([
            [
              Markup.button.callback(
                "📅 Перенести",
                `lk_uncompl_move_${shiftId}`
              ),
              Markup.button.callback("🗑 Удалить", `lk_uncompl_del_${shiftId}`),
            ],
          ]).reply_markup
        )
        .catch(() => {});
    } catch (e) {
      logError("lk_uncompl_back", e);
    }
  });

  async function getCurrentDateStr() {
    const r = await pool.query(`SELECT CURRENT_DATE::text AS d`);
    return r.rows[0]?.d; // 'YYYY-MM-DD'
  }

  function addDays(isoDate, days) {
    const [y, m, d] = isoDate.split("-").map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + days);
    const yy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
    const dd = String(dt.getUTCDate()).padStart(2, "0");
    return `${yy}-${mm}-${dd}`;
  }

  function buildMoveDateKeyboard(shiftId, startIso) {
    const days = [];
    for (let i = 0; i < 14; i++) days.push(addDays(startIso, i));

    const rows = [];
    for (let i = 0; i < days.length; i += 3) {
      rows.push(
        days
          .slice(i, i + 3)
          .map((d) =>
            Markup.button.callback(d, `lk_uncompl_move_date_${shiftId}_${d}`)
          )
      );
    }
    rows.push([Markup.button.callback("⬅️ Назад", "lk_notifications")]);
    return Markup.inlineKeyboard(rows);
  }

  bot.action("shift_close_to_menu", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      // Важно: ничего не сбрасываем в БД — закрытие можно продолжить
      clrSt(ctx.from.id);

      await deliver(
        ctx,
        {
          text: "Ок. Можно продолжить позже.",
          extra: Markup.inlineKeyboard([
            [{ text: "⬅️ К смене", callback_data: "lk_profile_shift" }],
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

  bot.action("shift_close_edit_menu_regulated", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const st = getSt(ctx.from.id);
      if (!st?.shiftId) return;

      // Переходим к доп. вопросам
      setSt(ctx.from.id, { step: "regulated", qIdx: 0 });

      await showByStep(ctx, user, "regulated");
    } catch (e) {
      logError("shift_close_edit_menu_regulated", e);
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

  bot.action(/^shift_close_cash_by_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const chosenId = Number(ctx.match[1]);

      const user = await ensureUser(ctx);
      if (!user) return;

      const st = getSt(ctx.from.id);
      if (!st?.shiftId) return;

      await pool.query(
        `UPDATE shift_closings
         SET cash_collection_by_user_id = $1,
             step = 'checks_count'
         WHERE shift_id = $2`,
        [chosenId, st.shiftId]
      );

      setSt(ctx.from.id, { step: "checks_count", cashByPage: 0 });

      await showByStep(ctx, user, "checks_count");
    } catch (e) {
      logError("shift_close_cash_by_id", e);
    }
  });

  bot.action("shift_close_cash_by_prev", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const st = getSt(ctx.from.id);
      if (!st?.shiftId) return;

      const page = Number.isInteger(st.cashByPage) ? st.cashByPage : 0;
      setSt(ctx.from.id, { cashByPage: Math.max(0, page - 1) });

      await showByStep(ctx, user, "cash_collection_by");
    } catch (e) {
      logError("shift_close_cash_by_prev", e);
    }
  });

  bot.action("shift_close_cash_by_next", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const st = getSt(ctx.from.id);
      if (!st?.shiftId) return;

      const page = Number.isInteger(st.cashByPage) ? st.cashByPage : 0;
      setSt(ctx.from.id, { cashByPage: page + 1 });

      await showByStep(ctx, user, "cash_collection_by");
    } catch (e) {
      logError("shift_close_cash_by_next", e);
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
        await showFinishScreen(ctx, user, { edit: true });
        return;
      }

      setSt(ctx.from.id, { ...st, qIdx: nextIdx });
      await showRegulatedQuestion(
        ctx,
        user,
        { ...st, qIdx: nextIdx },
        { edit: true }
      );
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
        await showFinishScreen(ctx, user, { edit: true });
        return;
      }
      setSt(ctx.from.id, { ...st, qIdx: nextIdx });
      await showRegulatedQuestion(
        ctx,
        user,
        { ...st, qIdx: nextIdx },
        { edit: true }
      );
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
        await showFinishScreen(ctx, user, { edit: true });
        return;
      }
      setSt(ctx.from.id, { ...st, qIdx: nextIdx });
      await showRegulatedQuestion(
        ctx,
        user,
        { ...st, qIdx: nextIdx },
        { edit: true }
      );
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

      // 1) добиваем состояние (если надо) и закрываем смену
      await pool.query(
        `
  UPDATE shifts
SET status = 'closed',
    closed_at = NOW()
WHERE id = $1
`,
        [Number(st.shiftId)]
      );

      // ==== если это закрытие по передаче смены — завершаем transfer и уведомляем B
      try {
        const tr = await pool.query(
          `
          SELECT
            tr.id,
            tr.to_user_id,
            tr.to_shift_id,
            tr.trade_point_id,
            u.telegram_id AS to_telegram_id,
            tp.title AS point_title
          FROM shift_transfer_requests tr
          JOIN users u ON u.id = tr.to_user_id
          JOIN trade_points tp ON tp.id = tr.trade_point_id
         WHERE tr.from_shift_id = $1
  AND tr.status = 'accepted'
          ORDER BY tr.id DESC
          LIMIT 1
          `,
          [Number(st.shiftId)]
        );

        const req = tr.rows[0];

        if (req) {
          await pool.query(
            `UPDATE shift_transfer_requests
             SET status='completed', responded_at=now()
             WHERE id=$1 AND status='accepted'`,
            [Number(req.id)]
          );

          if (req.to_telegram_id) {
            const kb = Markup.inlineKeyboard([
              [
                Markup.button.callback(
                  `✅ Открыть смену на ${req.point_title}`,
                  `shift_transfer_open_${req.id}`
                ),
              ],
            ]);

            await ctx.telegram.sendMessage(
              req.to_telegram_id,
              `🔁 Вам передали смену на *${req.point_title}*.\n\nОткрыть смену?`,
              { parse_mode: "Markdown", reply_markup: kb.reply_markup }
            );
          }
        }
      } catch (e) {
        // не валим закрытие из-за передачи
        logError("shift_transfer_finish", e);
      }

      // уведомление по порогам (после того как все поля уже введены)
      try {
        const mod = await import("../cashDiffAlerts.js");
        const fn =
          mod.checkCashDiffAndNotify || mod.default?.checkCashDiffAndNotify;
        if (typeof fn === "function") {
          const res = await fn({
            shiftId: Number(st.shiftId),
            stage: "close",
            actorUserId: user.id,
          });

          // PUSH всем ответственным
          if (res?.userIds?.length && res?.text) {
            const r = await pool.query(
              `SELECT telegram_id FROM users WHERE id = ANY($1::int[]) AND telegram_id IS NOT NULL`,
              [res.userIds]
            );
            await Promise.allSettled(
              (r.rows || []).map((x) =>
                ctx.telegram
                  .sendMessage(x.telegram_id, res.text, {
                    parse_mode: "Markdown",
                    reply_markup: kb.reply_markup,
                  })
                  .catch(() => {})
              )
            );
          }
        }
      } catch (_) {
        // не валим закрытие смены из-за уведомлений
      }

      clrSt(ctx.from.id);

      // 2) сразу в главное меню (без промежуточного "Смена закрыта ✅")
      const text = await buildStatusText(user);
      const keyboard = await buildMainKeyboard(user);

      await deliver(
        ctx,
        { text, extra: { ...(keyboard || {}), parse_mode: "HTML" } },
        { edit: true }
      );
    } catch (err) {
      logError("shift_close_finish", err);
      await ctx.reply("❌ Не удалось закрыть смену. Попробуйте ещё раз.");
    }
  });
}

module.exports = { registerShiftClosingFlow, startOrContinueClosing };
