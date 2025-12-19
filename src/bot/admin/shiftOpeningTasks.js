// src/bot/admin/shiftOpeningTasks.js
const { Markup } = require("telegraf");
const pool = require("../../db/pool");
const { deliver } = require("../../utils/renderHelpers");
const { getUserState, setUserState, clearUserState } = require("../state");

const MODE = "admin_shift_opening";

function isAdmin(user) {
  return user && (user.role === "admin" || user.role === "super_admin");
}

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

function typeEmoji(t) {
  return t === "photo"
    ? "📷"
    : t === "video"
    ? "🎥"
    : t === "number"
    ? "🔢"
    : "📝";
}
function audEmoji(a) {
  return a === "interns" ? "🎓" : "👥";
}

async function showRoot(ctx) {
  const text = "🚀 <b>Задачи открытия смены</b>\n\nВыберите раздел:";
  const kb = Markup.inlineKeyboard([
    [{ text: "🌐 Общие", callback_data: "aso_open_common" }],
    [{ text: "🏬 Для конкретной точки", callback_data: "aso_open_point_pick" }],
    [{ text: "⬅️ Назад", callback_data: "admin_shift_settings" }],
  ]);
  await deliver(ctx, { text, extra: kb }, { edit: true });
}

async function fetchQuestions(scope, tradePointId) {
  const res = await pool.query(
    `
      SELECT id, title, answer_type, audience, order_index
      FROM shift_questions
      WHERE scope = $1
        AND is_active = TRUE
        AND ($2::bigint IS NULL OR trade_point_id = $2)
      ORDER BY order_index ASC, id ASC
    `,
    [scope, tradePointId ?? null]
  );
  return res.rows;
}

function buildListText(title, rows) {
  let text = `${title}\n\n`;
  if (!rows.length) {
    text += "Пока нет задач.\n";
    return text;
  }
  rows.forEach((r, i) => {
    text += `${i + 1}. ${typeEmoji(r.answer_type)} ${audEmoji(r.audience)} ${
      r.title
    }\n`;
  });
  return text;
}

function buildNumberKeyboard(rows, prefix) {
  const btns = rows.map((r, idx) => {
    const n = idx + 1;
    return Markup.button.callback(`${n}`, `${prefix}_${r.id}`);
  });
  const kbRows = [];
  for (let i = 0; i < btns.length; i += 5) kbRows.push(btns.slice(i, i + 5));
  return kbRows;
}

async function showCommonList(ctx) {
  const rows = await fetchQuestions("common", null);
  const text = buildListText("🌐 <b>Общие задачи открытия</b>", rows);

  const kb = [];
  if (rows.length) kb.push(...buildNumberKeyboard(rows, "aso_open_q"));
  kb.push([
    {
      text: "🔁 Изменить последовательность",
      callback_data: "aso_open_reorder_common",
    },
  ]);
  kb.push([
    { text: "➕ Добавить задачу", callback_data: "aso_open_add_common" },
  ]);
  kb.push([{ text: "⬅️ Назад", callback_data: "aso_open_root" }]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(kb) },
    { edit: true }
  );
}

async function showPickPoint(ctx) {
  const res = await pool.query(
    `SELECT id, title FROM trade_points WHERE is_active = TRUE ORDER BY id ASC`
  );
  const kb = res.rows.map((p) => [
    Markup.button.callback(`🏬 ${p.title}`, `aso_open_point_${p.id}`),
  ]);
  kb.push([Markup.button.callback("⬅️ Назад", "aso_open_root")]);

  await deliver(
    ctx,
    { text: "🏬 <b>Выберите точку</b>:", extra: Markup.inlineKeyboard(kb) },
    { edit: true }
  );
}

async function showPointList(ctx, tradePointId) {
  const tp = await pool.query(
    `SELECT title FROM trade_points WHERE id=$1 LIMIT 1`,
    [tradePointId]
  );
  const tpTitle = tp.rows[0]?.title || `#${tradePointId}`;

  const rows = await fetchQuestions("point", tradePointId);
  const text = buildListText(`🏬 <b>Задачи открытия: ${tpTitle}</b>`, rows);

  const kb = [];
  if (rows.length) kb.push(...buildNumberKeyboard(rows, "aso_open_q"));
  kb.push([
    {
      text: "🔁 Изменить последовательность",
      callback_data: `aso_open_reorder_point_${tradePointId}`,
    },
  ]);
  kb.push([
    {
      text: "➕ Добавить задачу",
      callback_data: `aso_open_add_point_${tradePointId}`,
    },
  ]);
  kb.push([{ text: "⬅️ Назад", callback_data: "aso_open_point_pick" }]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(kb) },
    { edit: true }
  );
}

async function showAddAskTitle(ctx, scope, tradePointId) {
  const where = scope === "common" ? "🌐 общую" : "🏬 для точки";
  const text = `➕ Добавить ${where} задачу открытия\n\nОтправьте <b>название</b> одним сообщением:`;
  const kb = Markup.inlineKeyboard([
    [{ text: "❌ Отмена", callback_data: "aso_open_cancel_input" }],
  ]);
  setSt(ctx.from.id, {
    step: "add_title",
    scope,
    tradePointId: tradePointId ?? null,
  });
  await deliver(ctx, { text, extra: kb }, { edit: true });
}

async function showPickAnswerType(ctx) {
  const st = getSt(ctx.from.id);
  const text = `🧩 Выберите <b>вид ответа</b>:\n\n<b>${st.tmpTitle}</b>`;
  const kb = Markup.inlineKeyboard([
    [{ text: "📝 Текст", callback_data: "aso_open_type_text" }],
    [{ text: "🔢 Число", callback_data: "aso_open_type_number" }],
    [{ text: "📷 Фото", callback_data: "aso_open_type_photo" }],
    [{ text: "🎥 Видео", callback_data: "aso_open_type_video" }],
    [{ text: "❌ Отмена", callback_data: "aso_open_cancel_input" }],
  ]);
  await deliver(ctx, { text, extra: kb }, { edit: true });
}

async function showPickAudience(ctx) {
  const st = getSt(ctx.from.id);
  const text =
    `👥 Для кого задача?\n\n<b>${st.tmpTitle}</b>\n` +
    `Вид: ${typeEmoji(st.tmpAnswerType)} <b>${st.tmpAnswerType}</b>`;
  const kb = Markup.inlineKeyboard([
    [{ text: "👥 Для всех", callback_data: "aso_open_aud_all" }],
    [{ text: "🎓 Только для стажёров", callback_data: "aso_open_aud_interns" }],
    [{ text: "❌ Отмена", callback_data: "aso_open_cancel_input" }],
  ]);
  await deliver(ctx, { text, extra: kb }, { edit: true });
}

async function insertQuestion(
  scope,
  tradePointId,
  title,
  answerType,
  audience
) {
  const maxRes = await pool.query(
    `
      SELECT COALESCE(MAX(order_index), 0) AS mx
      FROM shift_questions
      WHERE scope = $1
        AND is_active = TRUE
        AND ($2::bigint IS NULL OR trade_point_id = $2)
    `,
    [scope, tradePointId ?? null]
  );
  const nextOrder = Number(maxRes.rows[0]?.mx || 0) + 1;

  const ins = await pool.query(
    `
      INSERT INTO shift_questions (scope, trade_point_id, title, answer_type, audience, is_active, order_index)
      VALUES ($1, $2, $3, $4, $5, TRUE, $6)
      RETURNING id
    `,
    [scope, tradePointId ?? null, title, answerType, audience, nextOrder]
  );
  return ins.rows[0].id;
}

async function showQuestionCard(ctx, qId) {
  const res = await pool.query(
    `
      SELECT id, scope, trade_point_id, title, answer_type, audience
      FROM shift_questions
      WHERE id=$1
      LIMIT 1
    `,
    [qId]
  );
  const q = res.rows[0];
  if (!q) {
    await deliver(
      ctx,
      {
        text: "Задача не найдена.",
        extra: Markup.inlineKeyboard([
          [{ text: "⬅️ Назад", callback_data: "aso_open_root" }],
        ]),
      },
      { edit: true }
    );
    return;
  }

  const backCb =
    q.scope === "common"
      ? "aso_open_common"
      : `aso_open_point_${q.trade_point_id}`;

  const text =
    `🧾 <b>Задача открытия смены</b>\n\n` +
    `Название: <b>${q.title}</b>\n` +
    `Вид: ${typeEmoji(q.answer_type)} <b>${q.answer_type}</b>\n` +
    `Статус: ${audEmoji(q.audience)} <b>${q.audience}</b>\n`;

  const kb = Markup.inlineKeyboard([
    [{ text: "✏️ Переименовать", callback_data: `aso_open_rename_${q.id}` }],
    [
      {
        text: "🧩 Изменить вид",
        callback_data: `aso_open_change_type_${q.id}`,
      },
    ],
    [{ text: "👥 По статусу", callback_data: `aso_open_change_aud_${q.id}` }],
    [{ text: "🗑 Удалить", callback_data: `aso_open_del_${q.id}` }],
    [{ text: "⬅️ Назад", callback_data: backCb }],
  ]);

  await deliver(ctx, { text, extra: kb }, { edit: true });
}

async function showReorder(ctx, scope, tradePointId) {
  const rows = await fetchQuestions(scope, tradePointId);
  const title =
    scope === "common"
      ? "🔁 <b>Порядок: общие задачи открытия</b>"
      : "🔁 <b>Порядок: задачи открытия точки</b>";

  let text = `${title}\n\n`;
  if (!rows.length) text += "Нет задач.\n";
  else rows.forEach((r, i) => (text += `${i + 1}. ${r.title}\n`));

  const kb = [];
  for (const r of rows) {
    kb.push([
      Markup.button.callback("⬆️", `aso_open_up_${r.id}`),
      Markup.button.callback("⬇️", `aso_open_down_${r.id}`),
      Markup.button.callback(`${r.title}`, `aso_open_q_${r.id}`),
    ]);
  }
  kb.push([
    {
      text: "✅ Закончить изменение порядка",
      callback_data:
        scope === "common"
          ? "aso_open_common"
          : `aso_open_point_${tradePointId}`,
    },
  ]);

  // сохраняем контекст reorder, чтобы up/down знали scope/point
  setSt(ctx.from.id, {
    step: "reorder",
    scope,
    tradePointId: tradePointId ?? null,
  });

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(kb) },
    { edit: true }
  );
}

async function swapOrder(questionId, dir, scope, tradePointId) {
  const rows = await fetchQuestions(scope, tradePointId);
  const idx = rows.findIndex((r) => Number(r.id) === Number(questionId));
  if (idx === -1) return;
  const swapWith = dir === "up" ? idx - 1 : idx + 1;
  if (swapWith < 0 || swapWith >= rows.length) return;

  const a = rows[idx];
  const b = rows[swapWith];

  await pool.query(`UPDATE shift_questions SET order_index=$1 WHERE id=$2`, [
    b.order_index,
    a.id,
  ]);
  await pool.query(`UPDATE shift_questions SET order_index=$1 WHERE id=$2`, [
    a.order_index,
    b.id,
  ]);
}

function registerAdminShiftOpeningTasks(bot, ensureUser, logError) {
  // Root entry from shiftSettings module
  bot.action("admin_shift_opening_root", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      clrSt(ctx.from.id);
      await showRoot(ctx);
    } catch (e) {
      logError("admin_shift_opening_root", e);
    }
  });

  bot.action("aso_open_root", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      clrSt(ctx.from.id);
      await showRoot(ctx);
    } catch (e) {
      logError("aso_open_root", e);
    }
  });

  // Common list
  bot.action("aso_open_common", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      clrSt(ctx.from.id);
      await showCommonList(ctx);
    } catch (e) {
      logError("aso_open_common", e);
    }
  });

  // Point pick
  bot.action("aso_open_point_pick", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      clrSt(ctx.from.id);
      await showPickPoint(ctx);
    } catch (e) {
      logError("aso_open_point_pick", e);
    }
  });

  // Point list
  bot.action(/^aso_open_point_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      clrSt(ctx.from.id);
      const tpId = Number(ctx.match[1]);
      await showPointList(ctx, tpId);
    } catch (e) {
      logError("aso_open_point_list", e);
    }
  });

  // Open card by id (from numbers or reorder rows)
  bot.action(/^aso_open_q_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      const qId = Number(ctx.match[1]);
      await showQuestionCard(ctx, qId);
    } catch (e) {
      logError("aso_open_q_card", e);
    }
  });

  // Add common
  bot.action("aso_open_add_common", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      await showAddAskTitle(ctx, "common", null);
    } catch (e) {
      logError("aso_open_add_common", e);
    }
  });

  // Add point
  bot.action(/^aso_open_add_point_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      const tpId = Number(ctx.match[1]);
      await showAddAskTitle(ctx, "point", tpId);
    } catch (e) {
      logError("aso_open_add_point", e);
    }
  });

  // Cancel input flow
  bot.action("aso_open_cancel_input", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const st = getSt(ctx.from.id);
      clrSt(ctx.from.id);

      if (st?.scope === "common") return showCommonList(ctx);
      if (st?.scope === "point" && st?.tradePointId)
        return showPointList(ctx, st.tradePointId);
      return showRoot(ctx);
    } catch (e) {
      logError("aso_open_cancel_input", e);
    }
  });

  // Receive title (text)
  bot.on("text", async (ctx, next) => {
    const st = getSt(ctx.from.id);
    if (!st || st.step !== "add_title") return next();

    try {
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const title = (ctx.message.text || "").trim();
      if (!title) return;

      setSt(ctx.from.id, { ...st, step: "add_type", tmpTitle: title });
      await ctx.reply("Ок. Теперь выберите вид ответа (кнопками ниже).");
      // показать кнопки отдельным сообщением (это не callback)
      const fakeCtx = ctx; // используем ctx.reply внутри deliver нельзя; просто отправим через reply с markup
      await fakeCtx.reply("🧩 Выберите вид ответа:", {
        reply_markup: Markup.inlineKeyboard([
          [{ text: "📝 Текст", callback_data: "aso_open_type_text" }],
          [{ text: "🔢 Число", callback_data: "aso_open_type_number" }],
          [{ text: "📷 Фото", callback_data: "aso_open_type_photo" }],
          [{ text: "🎥 Видео", callback_data: "aso_open_type_video" }],
          [{ text: "❌ Отмена", callback_data: "aso_open_cancel_input" }],
        ]).reply_markup,
      });
    } catch (e) {
      logError("aso_open_add_title_text", e);
      await ctx.reply("❌ Ошибка. Попробуйте ещё раз.");
    }
  });

  // Pick type
  bot.action(/^aso_open_type_(text|number|photo|video)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getSt(ctx.from.id);
      if (!st || st.step !== "add_type") return;

      setSt(ctx.from.id, {
        ...st,
        step: "add_aud",
        tmpAnswerType: ctx.match[1],
      });
      await showPickAudience(ctx);
    } catch (e) {
      logError("aso_open_pick_type", e);
    }
  });

  // Pick audience -> insert
  bot.action(/^aso_open_aud_(all|interns)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getSt(ctx.from.id);
      if (!st || st.step !== "add_aud") return;

      const audience = ctx.match[1];
      const qId = await insertQuestion(
        st.scope,
        st.tradePointId,
        st.tmpTitle,
        st.tmpAnswerType,
        audience
      );

      clrSt(ctx.from.id);

      // вернёмся в список
      if (st.scope === "common") {
        await showCommonList(ctx);
      } else {
        await showPointList(ctx, st.tradePointId);
      }
    } catch (e) {
      logError("aso_open_pick_audience", e);
    }
  });

  // -------- Card actions: rename / change type / change audience / delete --------

  bot.action(/^aso_open_rename_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      const qId = Number(ctx.match[1]);
      setSt(ctx.from.id, { step: "rename", qId });
      await deliver(
        ctx,
        {
          text: "✏️ Отправьте новое <b>название</b> одним сообщением:",
          extra: Markup.inlineKeyboard([
            [{ text: "❌ Отмена", callback_data: `aso_open_q_${qId}` }],
          ]),
        },
        { edit: true }
      );
    } catch (e) {
      logError("aso_open_rename", e);
    }
  });

  bot.on("text", async (ctx, next) => {
    const st = getSt(ctx.from.id);
    if (!st || st.step !== "rename") return next();

    try {
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const title = (ctx.message.text || "").trim();
      if (!title) return;

      await pool.query(`UPDATE shift_questions SET title=$1 WHERE id=$2`, [
        title,
        st.qId,
      ]);
      clrSt(ctx.from.id);
      await ctx.reply("✅ Переименовано");
    } catch (e) {
      logError("aso_open_rename_text", e);
      await ctx.reply("❌ Ошибка при переименовании");
    }
  });

  bot.action(/^aso_open_change_type_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      const qId = Number(ctx.match[1]);

      const kb = Markup.inlineKeyboard([
        [{ text: "📝 Текст", callback_data: `aso_open_set_type_${qId}_text` }],
        [
          {
            text: "🔢 Число",
            callback_data: `aso_open_set_type_${qId}_number`,
          },
        ],
        [{ text: "📷 Фото", callback_data: `aso_open_set_type_${qId}_photo` }],
        [{ text: "🎥 Видео", callback_data: `aso_open_set_type_${qId}_video` }],
        [{ text: "⬅️ Назад", callback_data: `aso_open_q_${qId}` }],
      ]);

      await deliver(
        ctx,
        { text: "🧩 Выберите новый вид:", extra: kb },
        { edit: true }
      );
    } catch (e) {
      logError("aso_open_change_type", e);
    }
  });

  bot.action(
    /^aso_open_set_type_(\d+)_(text|number|photo|video)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery().catch(() => {});
        const user = await ensureUser(ctx);
        if (!isAdmin(user)) return;
        const qId = Number(ctx.match[1]);
        const t = ctx.match[2];
        await pool.query(
          `UPDATE shift_questions SET answer_type=$1 WHERE id=$2`,
          [t, qId]
        );
        await showQuestionCard(ctx, qId);
      } catch (e) {
        logError("aso_open_set_type", e);
      }
    }
  );

  bot.action(/^aso_open_change_aud_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      const qId = Number(ctx.match[1]);

      const kb = Markup.inlineKeyboard([
        [{ text: "👥 Для всех", callback_data: `aso_open_set_aud_${qId}_all` }],
        [
          {
            text: "🎓 Только стажёры",
            callback_data: `aso_open_set_aud_${qId}_interns`,
          },
        ],
        [{ text: "⬅️ Назад", callback_data: `aso_open_q_${qId}` }],
      ]);
      await deliver(
        ctx,
        { text: "👥 Выберите аудиторию:", extra: kb },
        { edit: true }
      );
    } catch (e) {
      logError("aso_open_change_aud", e);
    }
  });

  bot.action(/^aso_open_set_aud_(\d+)_(all|interns)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      const qId = Number(ctx.match[1]);
      const a = ctx.match[2];
      await pool.query(`UPDATE shift_questions SET audience=$1 WHERE id=$2`, [
        a,
        qId,
      ]);
      await showQuestionCard(ctx, qId);
    } catch (e) {
      logError("aso_open_set_aud", e);
    }
  });

  bot.action(/^aso_open_del_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      const qId = Number(ctx.match[1]);

      const kb = Markup.inlineKeyboard([
        [{ text: "🗑 Да, удалить", callback_data: `aso_open_del_yes_${qId}` }],
        [{ text: "⬅️ Нет", callback_data: `aso_open_q_${qId}` }],
      ]);

      await deliver(
        ctx,
        { text: "Точно удалить задачу?", extra: kb },
        { edit: true }
      );
    } catch (e) {
      logError("aso_open_del_confirm", e);
    }
  });

  bot.action(/^aso_open_del_yes_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      const qId = Number(ctx.match[1]);

      // мягкое удаление
      await pool.query(
        `UPDATE shift_questions SET is_active=FALSE WHERE id=$1`,
        [qId]
      );

      await deliver(
        ctx,
        {
          text: "✅ Удалено",
          extra: Markup.inlineKeyboard([
            [{ text: "⬅️ Назад", callback_data: "aso_open_root" }],
          ]),
        },
        { edit: true }
      );
    } catch (e) {
      logError("aso_open_del_yes", e);
    }
  });

  // -------- Reorder --------
  bot.action("aso_open_reorder_common", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      await showReorder(ctx, "common", null);
    } catch (e) {
      logError("aso_open_reorder_common", e);
    }
  });

  bot.action(/^aso_open_reorder_point_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      const tpId = Number(ctx.match[1]);
      await showReorder(ctx, "point", tpId);
    } catch (e) {
      logError("aso_open_reorder_point", e);
    }
  });

  bot.action(/^aso_open_(up|down)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getSt(ctx.from.id);
      if (!st || st.step !== "reorder") return;

      const dir = ctx.match[1];
      const qId = Number(ctx.match[2]);

      await swapOrder(qId, dir, st.scope, st.tradePointId);
      await showReorder(ctx, st.scope, st.tradePointId);
    } catch (e) {
      logError("aso_open_reorder_move", e);
    }
  });
}

module.exports = { registerAdminShiftOpeningTasks };
