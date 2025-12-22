// src/bot/handover.js
const { Markup } = require("telegraf");
const pool = require("../db/pool");
const { deliver } = require("../utils/renderHelpers");
const { getUserState, setUserState, clearUserState } = require("./state");

const MODE = "handover_write";

function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function fmtDDMM(d) {
  if (!d) return "—";
  const dt = new Date(d);
  const dd = String(dt.getDate()).padStart(2, "0");
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  return `${dd}.${mm}`;
}

// ---- state helpers (в стиле today.js / shifts flow)
function getSt(tgId) {
  const st = getUserState(tgId);
  return st && st.mode === MODE ? st : null;
}
function setSt(tgId, patch) {
  const prev = getSt(tgId) || { mode: MODE, step: "idle" };
  setUserState(tgId, { ...prev, ...patch });
}
function clearSt(tgId) {
  const st = getSt(tgId);
  if (st) clearUserState(tgId);
}

// ---- DB helpers

async function loadActiveShiftForUser(userId) {
  const res = await pool.query(
    `
      SELECT s.id, s.trade_point_id, tp.title AS point_title
      FROM shifts s
      LEFT JOIN trade_points tp ON tp.id = s.trade_point_id
      WHERE s.user_id = $1
        AND opened_at::date = CURRENT_DATE
        AND status IN ('opening_in_progress','opened','closing_in_progress')
        AND trade_point_id IS NOT NULL
      ORDER BY opened_at DESC
      LIMIT 1
    `,
    [userId]
  );
  return res.rows[0] || null;
}

async function hasUnreadForPoint(tradePointId) {
  const r = await pool.query(
    `
      SELECT EXISTS (
        SELECT 1
        FROM shift_handover_comments
        WHERE trade_point_id = $1
          AND read_at IS NULL
      ) AS has_new
    `,
    [tradePointId]
  );
  return !!r.rows[0]?.has_new;
}

// кнопка в задачах должна быть видна всю смену:
async function hasForCurrentShift(tradePointId, shiftId) {
  const r = await pool.query(
    `
      SELECT EXISTS (
        SELECT 1
        FROM shift_handover_comments
        WHERE trade_point_id = $1
          AND (read_at IS NULL OR read_shift_id = $2)
      ) AS has_for_current_shift
    `,
    [tradePointId, shiftId]
  );
  return !!r.rows[0]?.has_for_current_shift;
}

async function loadForCurrentShift(tradePointId, shiftId) {
  const r = await pool.query(
    `
      SELECT
        c.id,
        c.text,
        c.created_at,
        s.opened_at::date AS from_shift_date,
        u.full_name AS author_name,
        u.username AS author_username
      FROM shift_handover_comments c
      LEFT JOIN shifts s ON s.id = c.from_shift_id
      LEFT JOIN users  u ON u.id = c.from_user_id
      WHERE c.trade_point_id = $1
        AND (c.read_at IS NULL OR c.read_shift_id = $2)
      ORDER BY c.created_at ASC
    `,
    [tradePointId, shiftId]
  );
  return r.rows || [];
}

async function markReadForShift(tradePointId, shiftId) {
  await pool.query(
    `
      UPDATE shift_handover_comments
      SET read_shift_id = $2,
          read_at = now()
      WHERE trade_point_id = $1
        AND read_at IS NULL
    `,
    [tradePointId, shiftId]
  );
}

// ---- UI builders

function buildReadText(rows) {
  let text =
    "📝 <b>Комментарии для вас</b>\n\n" +
    "Предыдущая смена оставила заметки для следующей смены:\n\n";

  if (!rows.length) return text + "Комментариев нет ✅";

  for (const r of rows) {
    const date = fmtDDMM(r.from_shift_date || r.created_at);
    const who = escHtml(r.author_name || "—");
    const uname = r.author_username ? ` (@${escHtml(r.author_username)})` : "";
    text += `• <b>${date}</b> — ${who}${uname}\n`;
    text += `${escHtml(r.text)}\n\n`;
  }
  return text.trim();
}

async function showReadScreen(
  ctx,
  tradePointId,
  shiftId,
  { edit = true } = {}
) {
  const rows = await loadForCurrentShift(tradePointId, shiftId);
  const text = buildReadText(rows);
  const kb = Markup.inlineKeyboard([
    [{ text: "⬅️ к задачам", callback_data: "lk_tasks_today" }],
  ]);
  await deliver(ctx, { text, extra: kb }, { edit });
}

async function loadWrittenForShift(tradePointId, fromShiftId) {
  const r = await pool.query(
    `
      SELECT id, text, created_at
      FROM shift_handover_comments
      WHERE trade_point_id = $1 AND from_shift_id = $2
      ORDER BY created_at ASC
    `,
    [tradePointId, fromShiftId]
  );
  return r.rows || [];
}

function buildWriteText(pointTitle, rows) {
  let text =
    "📝 <b>Комментарий для следующей смены</b>\n\n" +
    "Оставьте заметку для сотрудника, который откроет следующую смену на этой точке.\n";
  if (pointTitle) text += `\n<b>Точка:</b> ${escHtml(pointTitle)}\n`;
  text += "\n<b>Добавленные комментарии:</b>\n";

  if (!rows.length) return (text + "— пока нет").trim();

  rows.forEach((r, i) => {
    text += `${i + 1}) ${escHtml(r.text)}\n`;
  });
  return text.trim();
}

async function showWriteScreen(ctx, user, { edit = true } = {}) {
  const shift = await loadActiveShiftForUser(user.id);
  if (!shift?.trade_point_id) {
    const kb = Markup.inlineKeyboard([
      [{ text: "⬅️ Назад", callback_data: "lk_profile_shift" }],
    ]);
    await deliver(
      ctx,
      {
        text: "Комментарий можно оставить только при активной смене.",
        extra: kb,
      },
      { edit }
    );
    return;
  }

  const rows = await loadWrittenForShift(shift.trade_point_id, shift.id);
  const text = buildWriteText(shift.point_title, rows);
  const kb = Markup.inlineKeyboard([
    [{ text: "➕ Добавить комментарий", callback_data: "lk_handover_add" }],
    [{ text: "⬅️ Назад", callback_data: "lk_profile_shift" }],
  ]);
  await deliver(ctx, { text, extra: kb }, { edit });
}

/**
 * Вызывается после открытия смены:
 * - если есть unread по точке → помечаем прочитанным в рамках shiftId
 * - показываем экран "Комментарии для вас" (и только после него уже можно попасть к задачам)
 * Возвращает true/false — показали ли экран.
 */
async function showHandoverAfterOpenIfAny(ctx, tradePointId, shiftId) {
  const has = await hasUnreadForPoint(tradePointId);
  if (!has) return false;
  await markReadForShift(tradePointId, shiftId);
  await showReadScreen(ctx, tradePointId, shiftId, { edit: false });
  return true;
}

// ---- register

function registerHandover(bot, ensureUser, logError) {
  // 1) вход из "Профиль / Смена"
  bot.action("lk_next_shift_comment", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      clearSt(ctx.from.id);
      await showWriteScreen(ctx, user, { edit: true });
    } catch (err) {
      logError("lk_next_shift_comment", err);
    }
  });

  // 2) добавить комментарий (переход в ожидание текста)
  bot.action("lk_handover_add", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const shift = await loadActiveShiftForUser(user.id);
      if (!shift?.trade_point_id) return;

      setSt(ctx.from.id, {
        step: "await_text",
        tradePointId: shift.trade_point_id,
        fromShiftId: shift.id,
      });

      const kb = Markup.inlineKeyboard([
        [{ text: "⬅️ Назад", callback_data: "lk_next_shift_comment" }],
        [{ text: "❌ Отмена", callback_data: "lk_handover_cancel" }],
      ]);

      await deliver(
        ctx,
        {
          text: "📝 <b>Новый комментарий</b>\n\nНапишите одним сообщением заметку для следующей смены.",
          extra: kb,
        },
        { edit: true }
      );
    } catch (err) {
      logError("lk_handover_add", err);
    }
  });

  bot.action("lk_handover_cancel", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      clearSt(ctx.from.id);
      const user = await ensureUser(ctx);
      if (!user) return;
      await showWriteScreen(ctx, user, { edit: true });
    } catch (err) {
      logError("lk_handover_cancel", err);
    }
  });

  // 3) просмотр из задач
  bot.action("lk_handover_view", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const shift = await loadActiveShiftForUser(user.id);
      if (!shift?.trade_point_id) return;

      await showReadScreen(ctx, shift.trade_point_id, shift.id, { edit: true });
    } catch (err) {
      logError("lk_handover_view", err);
    }
  });

  // 4) сохранение текста комментария
  bot.on("text", async (ctx, next) => {
    const st = getSt(ctx.from.id);
    if (!st || st.step !== "await_text") return next();

    try {
      const user = await ensureUser(ctx);
      if (!user) return;

      const txt = (ctx.message.text || "").trim();
      if (!txt) return;

      await pool.query(
        `
          INSERT INTO shift_handover_comments (trade_point_id, from_shift_id, from_user_id, text)
          VALUES ($1, $2, $3, $4)
        `,
        [st.tradePointId, st.fromShiftId, user.id, txt]
      );

      clearSt(ctx.from.id);
      await ctx.reply("✅ Сохранено!");
      await showWriteScreen(ctx, user, { edit: false });
    } catch (err) {
      logError("handover_write_text", err);
      await ctx.reply(
        "❌ Не удалось сохранить комментарий. Попробуйте ещё раз."
      );
    }
  });
}

module.exports = {
  registerHandover,
  showHandoverAfterOpenIfAny,
  hasForCurrentShift,
};
