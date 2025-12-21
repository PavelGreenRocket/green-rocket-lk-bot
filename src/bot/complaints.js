// src/bot/complaints.js
const { Markup } = require("telegraf");
const pool = require("../db/pool");
const { deliver } = require("../utils/renderHelpers");
const { insertNotificationAndFanout } = require("./notifications");

const CAT_COMPLAINTS = "[[complaints]]";

const state = new Map(); // tgId -> { step, currentShiftId, prevShiftId, tradePointId, text }

let _complSchema = null;

async function getComplaintsSchema() {
  if (_complSchema) return _complSchema;

  const r = await pool.query(
    `
    SELECT column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'shift_complaints'
    `
  );

  const cols = new Set(r.rows.map((x) => x.column_name));

  const schema = {
    textCol: cols.has("text")
      ? "text"
      : cols.has("complaint_text")
      ? "complaint_text"
      : null,
    photoCol: cols.has("photo_file_id") ? "photo_file_id" : null,

    // на что ссылается "предыдущая смена"
    prevShiftCol: cols.has("prev_shift_id")
      ? "prev_shift_id"
      : cols.has("about_shift_id")
      ? "about_shift_id"
      : null,

    // текущая смена (если есть)
    currentShiftCol: cols.has("current_shift_id")
      ? "current_shift_id"
      : cols.has("shift_id")
      ? "shift_id"
      : null,

    tradePointCol: cols.has("trade_point_id") ? "trade_point_id" : null,
    fromUserCol: cols.has("from_user_id") ? "from_user_id" : null,

    // кто был на прошлой смене (если есть)
    prevShiftUserCol: cols.has("prev_shift_user_id")
      ? "prev_shift_user_id"
      : cols.has("to_user_id")
      ? "to_user_id"
      : null,
  };

  if (!schema.textCol) {
    throw new Error(
      "shift_complaints: не найдена колонка текста (text или complaint_text)"
    );
  }
  if (!schema.prevShiftCol) {
    throw new Error(
      "shift_complaints: не найдена колонка связи с прошлой сменой (prev_shift_id/about_shift_id)"
    );
  }
  if (!schema.tradePointCol || !schema.fromUserCol) {
    throw new Error(
      "shift_complaints: не найдены обязательные колонки trade_point_id/from_user_id"
    );
  }

  _complSchema = schema;
  return schema;
}

async function getActiveShift(userId) {
  const r = await pool.query(
    `
    SELECT s.id, s.trade_point_id, s.opened_at
    FROM shifts s
    WHERE s.user_id = $1
      AND s.status IN ('opening_in_progress','opened')
      AND (s.opened_at AT TIME ZONE 'UTC')::date = CURRENT_DATE
    ORDER BY s.opened_at DESC
    LIMIT 1
    `,
    [userId]
  );
  return r.rows[0] || null;
}

async function getPrevShift(tradePointId, openedAt) {
  const r = await pool.query(
    `
    SELECT s.id, s.user_id, s.closed_at
    FROM shifts s
    WHERE s.trade_point_id = $1
      AND s.status = 'closed'
      AND s.closed_at < $2
    ORDER BY s.closed_at DESC
    LIMIT 1
    `,
    [tradePointId, openedAt]
  );
  return r.rows[0] || null;
}

async function listMyComplaints(userId, prevShiftId) {
  const s = await getComplaintsSchema();

  const sql = `
    SELECT
      id,
      ${s.textCol} AS text,
      ${s.photoCol ? s.photoCol : "NULL"} AS photo_file_id,
      created_at
    FROM shift_complaints
    WHERE ${s.fromUserCol} = $1
      AND ${s.prevShiftCol} IS NOT DISTINCT FROM $2
    ORDER BY created_at DESC
    LIMIT 20
  `;

  const r = await pool.query(sql, [userId, prevShiftId]);
  return r.rows;
}

async function getPointTitle(tradePointId) {
  const r = await pool.query(`SELECT title FROM trade_points WHERE id=$1`, [
    tradePointId,
  ]);
  return r.rows[0]?.title || "—";
}

async function getUserInfo(userId) {
  const r = await pool.query(
    `SELECT full_name, work_phone, username FROM users WHERE id=$1`,
    [userId]
  );
  return r.rows[0] || { full_name: "—", work_phone: null, username: null };
}

async function getResponsibles(tradePointId) {
  const r = await pool.query(
    `
    SELECT u.id
    FROM responsible_assignments  r
    JOIN users u ON u.id = r.user_id
    WHERE r.trade_point_id = $1
      AND r.kind = 'complaints'
      AND r.is_active = true
    ORDER BY u.id
    `,
    [tradePointId]
  );
  return r.rows.map((x) => Number(x.id));
}

async function showComplaintsRoot(ctx, user, { edit = true } = {}) {
  const active = await getActiveShift(user.id);
  if (!active) {
    await deliver(
      ctx,
      {
        text: "💬 Замечания по прошлой смене доступны только при активной смене.",
        extra: Markup.inlineKeyboard([
          [Markup.button.callback("⬅️ В меню", "lk_main_menu")],
        ]),
      },
      { edit }
    );
    return;
  }

  const prev = await getPrevShift(active.trade_point_id, active.opened_at);
  const pointTitle = await getPointTitle(active.trade_point_id);

  let text =
    "💬 *Замечания по прошлой смене*\n\n" +
    "Писать замечания — нормально. Это помогает улучшать работу точки.\n\n" +
    `Точка: *${pointTitle}*\n`;

  if (!prev) {
    text += "\nПредыдущая смена по этой точке не найдена.\n";
  } else {
    const items = await listMyComplaints(user.id, prev.id);
    text += `Предыдущая смена: *#${prev.id}*\n\n`;

    if (!items.length) text += "_Пока замечаний нет._\n";
    else {
      text += "Ваши замечания:\n";
      for (const x of items) {
        text += `• ${x.text}\n`;
      }
    }
  }

  const kb = [
    [
      Markup.button.callback(
        "➕ Добавить замечание",
        "lk_prev_shift_compl_add"
      ),
    ],
    [Markup.button.callback("⬅️ В меню", "lk_main_menu")],
  ];

  await deliver(
    ctx,
    { text, extra: { ...Markup.inlineKeyboard(kb), parse_mode: "Markdown" } },
    { edit }
  );

  // store state
  state.set(ctx.from.id, {
    step: "idle",
    currentShiftId: Number(active.id),
    prevShiftId: prev ? Number(prev.id) : null,
    tradePointId: Number(active.trade_point_id),
    text: null,
  });
}

async function startAdd(ctx) {
  const st = state.get(ctx.from.id);
  if (!st?.currentShiftId) return;

  st.step = "await_text";
  st.text = null;
  state.set(ctx.from.id, st);

  await ctx.reply(
    "Введите текст замечания одним сообщением.\n\nМожно будет добавить 1 фото.",
    Markup.inlineKeyboard([
      [Markup.button.callback("❌ Отмена", "lk_prev_shift_compl_cancel")],
    ])
  );
}

async function saveComplaintAndNotify(ctx, user, { text, photoFileId }) {
  const st = state.get(ctx.from.id);
  if (!st?.currentShiftId) return;

  const prevShiftId = st.prevShiftId;
  const tradePointId = st.tradePointId;

  const prevShiftUser = prevShiftId
    ? await pool.query(`SELECT user_id FROM shifts WHERE id=$1`, [prevShiftId])
    : null;
  const prevShiftUserId = prevShiftUser?.rows?.[0]?.user_id
    ? Number(prevShiftUser.rows[0].user_id)
    : null;

  const s = await getComplaintsSchema();

  // формируем список колонок/значений только для реально существующих колонок
  const cols = [s.tradePointCol, s.prevShiftCol, s.fromUserCol, s.textCol];
  const vals = [tradePointId, prevShiftId, user.id, text];

  if (s.currentShiftCol) {
    cols.push(s.currentShiftCol);
    vals.push(st.currentShiftId);
  }
  if (s.prevShiftUserCol) {
    cols.push(s.prevShiftUserCol);
    vals.push(prevShiftUserId);
  }
  if (s.photoCol) {
    cols.push(s.photoCol);
    vals.push(photoFileId || null);
  }

  const placeholders = cols.map((_, i) => `$${i + 1}`).join(",");

  await pool.query(
    `INSERT INTO shift_complaints (${cols.join(",")}) VALUES (${placeholders})`,
    vals
  );

  const pointTitle = await getPointTitle(tradePointId);
  const fromU = await getUserInfo(user.id);
  const prevU = prevShiftUserId ? await getUserInfo(prevShiftUserId) : null;

  const notifText =
    `📝 ${CAT_COMPLAINTS}\n` +
    `*Замечание по прошлой смене*\n\n` +
    `Точка: *${pointTitle}*\n` +
    (prevShiftId ? `Предыдущая смена: *#${prevShiftId}*\n\n` : "\n") +
    `Отправил: *${fromU.full_name || "—"}*\n` +
    `Тел: ${fromU.work_phone || "—"}\n` +
    `Username: ${fromU.username ? `@${fromU.username}` : "—"}\n\n` +
    (prevU
      ? `Предыдущая смена (сотрудник): *${prevU.full_name || "—"}*\nТел: ${
          prevU.work_phone || "—"
        }\nUsername: ${prevU.username ? `@${prevU.username}` : "—"}\n\n`
      : "") +
    `Текст:\n${text}`;

  const respIds = await getResponsibles(tradePointId);
  if (respIds.length) {
    await insertNotificationAndFanout({
      createdBy: user.id,
      text: notifText,
      recipientUserIds: respIds,
    });
  }
}

function registerComplaints(bot, ensureUser, logError) {
  bot.action("lk_prev_shift_complaints", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      await showComplaintsRoot(ctx, user, { edit: true });
    } catch (e) {
      logError?.("lk_prev_shift_complaints", e);
    }
  });

  bot.action("lk_prev_shift_compl_add", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      await startAdd(ctx);
    } catch (e) {
      logError?.("lk_prev_shift_compl_add", e);
    }
  });

  bot.action("lk_prev_shift_compl_cancel", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      state.delete(ctx.from.id);
      await showComplaintsRoot(ctx, user, { edit: true });
    } catch (e) {
      logError?.("lk_prev_shift_compl_cancel", e);
    }
  });

  bot.on("text", async (ctx, next) => {
    try {
      const st = state.get(ctx.from.id);
      if (!st || st.step !== "await_text") return next();

      const user = await ensureUser(ctx);
      if (!user) return;

      st.text = (ctx.message.text || "").trim();
      st.step = "await_photo_decision";
      state.set(ctx.from.id, st);

      await ctx.reply(
        "Добавить фото? (одно фото)\n\nЕсли отправишь новое фото — оно заменит предыдущее.",
        Markup.inlineKeyboard([
          [
            Markup.button.callback(
              "📷 Добавить фото",
              "lk_prev_shift_compl_photo"
            ),
          ],
          [
            Markup.button.callback(
              "➡️ Без фото",
              "lk_prev_shift_compl_nophoto"
            ),
          ],
          [Markup.button.callback("❌ Отмена", "lk_prev_shift_compl_cancel")],
        ])
      );
    } catch (e) {
      logError?.("compl_text", e);
      return next();
    }
  });

  bot.action("lk_prev_shift_compl_nophoto", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const st = state.get(ctx.from.id);
      if (!st?.text) return;

      await saveComplaintAndNotify(ctx, user, {
        text: st.text,
        photoFileId: null,
      });
      state.delete(ctx.from.id);

      await ctx.reply("✅ Замечание отправлено ответственным.");
      await showComplaintsRoot(ctx, user, { edit: false });
    } catch (e) {
      logError?.("lk_prev_shift_compl_nophoto", e);
    }
  });

  bot.action("lk_prev_shift_compl_photo", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const st = state.get(ctx.from.id);
      if (!st?.text) return;

      st.step = "await_photo";
      state.set(ctx.from.id, st);

      await ctx.reply(
        "Отправь 1 фото сообщением.",
        Markup.inlineKeyboard([
          [Markup.button.callback("❌ Отмена", "lk_prev_shift_compl_cancel")],
        ])
      );
    } catch (e) {
      logError?.("lk_prev_shift_compl_photo", e);
    }
  });

  bot.on("photo", async (ctx, next) => {
    try {
      const st = state.get(ctx.from.id);
      if (!st || st.step !== "await_photo") return next();

      const user = await ensureUser(ctx);
      if (!user) return;

      const ph = ctx.message.photo?.[ctx.message.photo.length - 1];
      const fileId = ph?.file_id;
      if (!fileId) return;

      await saveComplaintAndNotify(ctx, user, {
        text: st.text,
        photoFileId: fileId,
      });
      state.delete(ctx.from.id);

      await ctx.reply("✅ Замечание (с фото) отправлено ответственным.");
      await showComplaintsRoot(ctx, user, { edit: false });
    } catch (e) {
      logError?.("compl_photo", e);
      return next();
    }
  });
}

module.exports = { registerComplaints };

module.exports = { registerComplaints };
