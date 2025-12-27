// src/bot/admin/cashCollectionAccess.js
const { Markup } = require("telegraf");
const pool = require("../../db/pool");
const { deliver } = require("../../utils/renderHelpers");
const { getUserState, setUserState, clearUserState } = require("../state");

const MODE = "admin_cash_access";
const EVENT_TYPE = "cash_collection_access";

function isAdmin(user) {
  return user && (user.role === "admin" || user.role === "super_admin");
}

// ---- state helpers ----
function stGet(tgId) {
  const st = getUserState(tgId);
  return st && st.mode === MODE ? st : null;
}
function stSet(tgId, patch) {
  const prev = stGet(tgId) || { mode: MODE };
  setUserState(tgId, { ...prev, ...patch });
}
function stClear(tgId) {
  const st = stGet(tgId);
  if (st) clearUserState(tgId);
}

// ---- db helpers ----
async function loadPoints() {
  const r = await pool.query(
    `SELECT id, title FROM trade_points WHERE is_active=TRUE ORDER BY title NULLS LAST, id`
  );
  return r.rows;
}

async function loadAccess(tradePointId) {
  const r = await pool.query(
    `
    SELECT
      tpr.id,
      tpr.user_id,
      COALESCE(u.full_name,'Без имени') AS full_name,
      u.username
    FROM trade_point_responsibles tpr
    JOIN users u ON u.id = tpr.user_id
    WHERE tpr.trade_point_id=$1
      AND tpr.event_type=$2
      AND tpr.is_active=TRUE
    ORDER BY u.full_name NULLS LAST, u.username NULLS LAST, u.id
    `,
    [tradePointId, EVENT_TYPE]
  );
  return r.rows;
}

async function loadUsersForPick() {
  // намеренно без фильтров по роли/статусу
  const r = await pool.query(
    `
    SELECT id, COALESCE(full_name,'Без имени') AS full_name, username
    FROM users
    ORDER BY full_name NULLS LAST, id
    LIMIT 80
    `
  );
  return r.rows;
}

async function grantAccess(tradePointId, userId) {
  // Без ON CONFLICT (на случай отсутствия уникального индекса)
  const upd = await pool.query(
    `
    UPDATE trade_point_responsibles
    SET is_active=TRUE
    WHERE trade_point_id=$1 AND event_type=$2 AND user_id=$3
    `,
    [tradePointId, EVENT_TYPE, userId]
  );
  if (upd.rowCount > 0) return;

  await pool.query(
    `
    INSERT INTO trade_point_responsibles (trade_point_id, event_type, user_id, is_active)
    VALUES ($1,$2,$3,TRUE)
    `,
    [tradePointId, EVENT_TYPE, userId]
  );
}

async function revokeAccessById(id) {
  await pool.query(
    `UPDATE trade_point_responsibles SET is_active=FALSE WHERE id=$1`,
    [id]
  );
}

// ---- ui ----
async function showRoot(ctx) {
  const text =
    "💰 <b>Доступ к инкассации</b>\n\n" +
    "Здесь назначаются сотрудники, которые могут быть выбраны как «кто инкассировал»\n" +
    "для конкретной торговой точки.\n\n" +
    "Выберите точку:";

  const points = await loadPoints();
  const rows = points.map((p) => [
    Markup.button.callback(
      p.title || `Точка #${p.id}`,
      `admin_cash_access_point_${p.id}`
    ),
  ]);
  rows.push([Markup.button.callback("⬅️ Назад", "admin_resp_root")]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(rows) },
    { edit: true }
  );
}

async function showPointCard(ctx, tradePointId) {
  const tp = await pool.query(
    `SELECT title FROM trade_points WHERE id=$1 LIMIT 1`,
    [tradePointId]
  );
  const title = tp.rows[0]?.title || `#${tradePointId}`;

  const list = await loadAccess(tradePointId);

  let text = "💰 <b>Доступ к инкассации</b>\n\n";
  text += `📍 Точка: <b>${title}</b>\n\n`;

  if (!list.length) {
    text += "Пока никто не назначен.\n";
  } else {
    text += "Назначены:\n";
    list.forEach((r, i) => {
      const tag = r.username ? ` (@${r.username})` : "";
      text += `${i + 1}. ${r.full_name}${tag}\n`;
    });
  }

  const kb = [];

  if (list.length) {
    const btns = list.map((r, idx) =>
      Markup.button.callback(
        `${idx + 1}`,
        `admin_cash_access_del_${r.id}_${tradePointId}`
      )
    );
    for (let i = 0; i < btns.length; i += 5) kb.push(btns.slice(i, i + 5));
    kb.push([{ text: "🗑 удалить (нажмите номер)", callback_data: "noop" }]);
  }

  kb.push([
    Markup.button.callback(
      "➕ Назначить доступ",
      `admin_cash_access_add_${tradePointId}`
    ),
  ]);
  kb.push([Markup.button.callback("⬅️ Назад", "admin_cash_access_root")]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(kb) },
    { edit: true }
  );
}

async function showPickUser(ctx, tradePointId) {
  stSet(ctx.from.id, { step: "pick_user", tradePointId });

  const users = await loadUsersForPick();
  const text =
    "➕ <b>Доступ к инкассации</b>\n\n" +
    "Выберите пользователя, которому дать доступ:";

  const rows = users.map((u) => [
    Markup.button.callback(
      `${u.full_name}${u.username ? ` (@${u.username})` : ""}`,
      `admin_cash_access_pick_${u.id}`
    ),
  ]);

  rows.push([
    Markup.button.callback(
      "⬅️ Назад",
      `admin_cash_access_point_${tradePointId}`
    ),
  ]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(rows) },
    { edit: true }
  );
}

// ---- registration ----
function registerAdminCashCollectionAccess(bot, ensureUser, logError) {
  bot.action("admin_cash_access_root", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      stClear(ctx.from.id);
      await showRoot(ctx);
    } catch (e) {
      logError("admin_cash_access_root", e);
    }
  });

  bot.action(/^admin_cash_access_point_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      stClear(ctx.from.id);
      await showPointCard(ctx, Number(ctx.match[1]));
    } catch (e) {
      logError("admin_cash_access_point", e);
    }
  });

  bot.action(/^admin_cash_access_add_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      await showPickUser(ctx, Number(ctx.match[1]));
    } catch (e) {
      logError("admin_cash_access_add", e);
    }
  });

  bot.action(/^admin_cash_access_pick_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const st = stGet(ctx.from.id);
      if (!st || st.step !== "pick_user") return;

      const pickedUserId = Number(ctx.match[1]);
      const tpId = Number(st.tradePointId);

      await grantAccess(tpId, pickedUserId);

      stClear(ctx.from.id);
      await ctx.answerCbQuery("✅ Назначено").catch(() => {});
      await showPointCard(ctx, tpId);
    } catch (e) {
      logError("admin_cash_access_pick", e);
    }
  });

  bot.action(/^admin_cash_access_del_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const id = Number(ctx.match[1]);
      const tpId = Number(ctx.match[2]);

      await revokeAccessById(id);

      await ctx.answerCbQuery("🗑 Удалено").catch(() => {});
      await showPointCard(ctx, tpId);
    } catch (e) {
      logError("admin_cash_access_del", e);
    }
  });

  bot.action("noop", async (ctx) => ctx.answerCbQuery().catch(() => {}));
}

module.exports = { registerAdminCashCollectionAccess };
