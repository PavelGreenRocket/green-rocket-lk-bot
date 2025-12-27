// src/bot/admin/cashCollectionAccess.js
const { Markup } = require("telegraf");
const pool = require("../../db/pool");
const { deliver } = require("../../utils/renderHelpers");

function isAdmin(user) {
  return user && (user.role === "admin" || user.role === "super_admin");
}

// tgId -> { step, tradePointId }
const stMap = new Map();
function getSt(tgId) {
  return stMap.get(tgId) || null;
}
function setSt(tgId, st) {
  stMap.set(tgId, st);
}
function clrSt(tgId) {
  stMap.delete(tgId);
}

async function loadPoints() {
  const r = await pool.query(
    `SELECT id, title, is_active FROM trade_points ORDER BY title NULLS LAST, id`
  );
  return r.rows;
}

async function loadAssigned(tradePointId) {
  const r = await pool.query(
    `
    SELECT
      tpr.id AS tpr_id,
      u.id AS user_id,
      u.full_name,
      u.username
    FROM trade_point_responsibles tpr
    JOIN users u ON u.id = tpr.user_id
    WHERE tpr.trade_point_id = $1
      AND tpr.event_type = 'cash_collection_access'
      AND tpr.is_active = true
    ORDER BY u.full_name NULLS LAST, u.username NULLS LAST, u.id
    `,
    [Number(tradePointId)]
  );
  return r.rows;
}

async function loadUsers(limit = 60) {
  const r = await pool.query(
    `SELECT id, full_name, username FROM users ORDER BY full_name NULLS LAST, id LIMIT $1`,
    [Number(limit)]
  );
  return r.rows;
}

async function renderRoot(ctx) {
  const points = await loadPoints();
  const rows = [];

  for (const tp of points) {
    const status = tp.is_active === false ? "⚪️" : "🟢";
    rows.push([
      Markup.button.callback(
        `${status} ${tp.title || `Точка #${tp.id}`}`.slice(0, 64),
        `admin_cash_access_point_${tp.id}`
      ),
    ]);
  }

  rows.push([Markup.button.callback("⬅️ Назад", "admin_resp_root")]);

  await deliver(
    ctx,
    {
      text: "💰 <b>Доступ к инкассации</b>\n\nВыберите торговую точку:",
      extra: Markup.inlineKeyboard(rows),
    },
    { edit: true }
  );
}

async function renderPoint(ctx, tradePointId) {
  const tp = await pool.query(
    `SELECT id, title FROM trade_points WHERE id=$1`,
    [Number(tradePointId)]
  );
  const title = tp.rows[0]?.title || `Точка #${tradePointId}`;

  const assigned = await loadAssigned(tradePointId);

  let text = `💰 <b>Доступ к инкассации</b>\n\n🏬 <b>${title}</b>\n\n`;
  if (!assigned.length) {
    text += "Пока никто не назначен.\n";
  } else {
    text += "Назначены:\n";
    assigned.forEach((u, i) => {
      const label =
        u.full_name || (u.username ? `@${u.username}` : `#${u.user_id}`);
      text += `${i + 1}) ${label}\n`;
    });
  }

  const kb = [];
  kb.push([
    Markup.button.callback(
      "➕ Добавить",
      `admin_cash_access_add_${tradePointId}`
    ),
  ]);

  if (assigned.length) {
    // кнопки удаления (по одному в строке, чтобы не упереться в лимиты)
    assigned.forEach((u, i) => {
      kb.push([
        Markup.button.callback(
          `❌ Убрать: ${i + 1}`,
          `admin_cash_access_del_${u.tpr_id}_${tradePointId}`
        ),
      ]);
    });
  }

  kb.push([
    Markup.button.callback("⬅️ К списку точек", "admin_cash_access_root"),
  ]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(kb) },
    { edit: true }
  );
}

async function renderPickUser(ctx, tradePointId) {
  const users = await loadUsers(60);

  const rows = [];
  for (const u of users) {
    const label = `${u.full_name || "—"}${
      u.username ? ` (@${u.username})` : ""
    }`;
    rows.push([
      Markup.button.callback(
        label.slice(0, 64),
        `admin_cash_access_pick_${tradePointId}_${u.id}`
      ),
    ]);
  }

  rows.push([
    Markup.button.callback(
      "⬅️ Назад",
      `admin_cash_access_point_${tradePointId}`
    ),
  ]);

  await deliver(
    ctx,
    {
      text:
        "➕ <b>Добавить доступ к инкассации</b>\n\n" +
        "Выберите сотрудника (пока показываю первые 60):",
      extra: Markup.inlineKeyboard(rows),
    },
    { edit: true }
  );
}

function registerAdminCashCollectionAccess(bot, ensureUser, logError) {
  // вход с кнопки из responsibles:
  bot.action("admin_cash_access_root", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      clrSt(ctx.from.id);
      return renderRoot(ctx);
    } catch (e) {
      logError("admin_cash_access_root", e);
    }
  });

  bot.action(/^admin_cash_access_point_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const tpId = Number(ctx.match[1]);
      setSt(ctx.from.id, { step: "point", tradePointId: tpId });
      return renderPoint(ctx, tpId);
    } catch (e) {
      logError("admin_cash_access_point", e);
    }
  });

  bot.action(/^admin_cash_access_add_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const tpId = Number(ctx.match[1]);
      setSt(ctx.from.id, { step: "pick_user", tradePointId: tpId });
      return renderPickUser(ctx, tpId);
    } catch (e) {
      logError("admin_cash_access_add", e);
    }
  });

  bot.action(/^admin_cash_access_pick_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const tpId = Number(ctx.match[1]);
      const userId = Number(ctx.match[2]);

      await pool.query(
        `
        INSERT INTO trade_point_responsibles (trade_point_id, event_type, user_id, created_by_user_id, is_active)
        VALUES ($1, 'cash_collection_access', $2, $3, true)
        ON CONFLICT (trade_point_id, event_type, user_id)
        DO UPDATE SET is_active = true, created_by_user_id = EXCLUDED.created_by_user_id
        `,
        [tpId, userId, admin.id]
      );

      return renderPoint(ctx, tpId);
    } catch (e) {
      logError("admin_cash_access_pick", e);
    }
  });

  bot.action(/^admin_cash_access_del_(\d+)_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const tprId = Number(ctx.match[1]);
      const tpId = Number(ctx.match[2]);

      await pool.query(
        `
        UPDATE trade_point_responsibles
        SET is_active = false, created_by_user_id = $2
        WHERE id = $1
        `,
        [tprId, admin.id]
      );

      return renderPoint(ctx, tpId);
    } catch (e) {
      logError("admin_cash_access_del", e);
    }
  });
}

module.exports = { registerAdminCashCollectionAccess };
