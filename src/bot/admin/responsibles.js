// src/bot/admin/responsibles.js
const { Markup } = require("telegraf");
const pool = require("../../db/pool");
const { deliver } = require("../../utils/renderHelpers");
const { getUserState, setUserState, clearUserState } = require("../state");

const MODE = "admin_responsibles";

function isAdmin(user) {
  return user && (user.role === "admin" || user.role === "super_admin");
}

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

async function loadPoints() {
  const r = await pool.query(
    `SELECT id, title FROM trade_points WHERE is_active=TRUE ORDER BY id`
  );
  return r.rows;
}

async function loadResp(tradePointId, kind) {
  const r = await pool.query(
    `
    SELECT ra.id, ra.user_id, COALESCE(u.full_name,'Без имени') AS full_name
    FROM responsible_assignments ra
    JOIN users u ON u.id = ra.user_id
    WHERE ra.trade_point_id=$1 AND ra.kind=$2 AND ra.is_active=TRUE
    ORDER BY u.full_name NULLS LAST, ra.id
    `,
    [tradePointId, kind]
  );
  return r.rows;
}

async function loadUsersForPick(q) {
  // ВАЖНО: без фильтров staff_status/role, чтобы "виделись все"
  const r = await pool.query(
    `
    SELECT id, COALESCE(full_name,'Без имени') AS full_name
    FROM users
    ORDER BY full_name NULLS LAST, id
    LIMIT 60
    `
  );
  return r.rows;
}

function kindLabel(kind) {
  return kind === "uncompleted_tasks"
    ? "✅ Невыполненные задачи"
    : "📝 Жалобы на прошлую смену";
}

async function showRoot(ctx) {
  const text =
    "👤 <b>Назначение ответственных</b>\n\n" +
    "Здесь назначаются сотрудники, которые будут получать уведомления:\n" +
    "• если смена закрыта с невыполненными задачами\n" +
    "• если бариста оставил замечание по прошлой смене\n\n" +
    "Выберите тип:";
  const kb = Markup.inlineKeyboard([
    [
      {
        text: "✅ по невыполненным задачам за смену",
        callback_data: "admin_resp_kind_uncompleted_tasks",
      },
    ],
    [
      {
        text: "📝 по жалобам на прошлую смену",
        callback_data: "admin_resp_kind_complaints",
      },
    ],
    [{ text: "⬅️ Назад", callback_data: "admin_shift_settings" }],
  ]);
  await deliver(ctx, { text, extra: kb }, { edit: true });
}

async function showPickPoint(ctx, kind) {
  const points = await loadPoints();
  const text = `${kindLabel(kind)}\n\n📍 Выберите точку:`;
  const rows = points.map((p) => [
    Markup.button.callback(p.title, `admin_resp_point_${kind}_${p.id}`),
  ]);
  rows.push([Markup.button.callback("⬅️ Назад", "admin_resp_root")]);
  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(rows) },
    { edit: true }
  );
}

async function showPointCard(ctx, kind, tradePointId) {
  const tp = await pool.query(
    `SELECT title FROM trade_points WHERE id=$1 LIMIT 1`,
    [tradePointId]
  );
  const title = tp.rows[0]?.title || `#${tradePointId}`;

  const resp = await loadResp(tradePointId, kind);

  let text = `${kindLabel(kind)}\n\n` + `📍 Точка: <b>${title}</b>\n\n`;

  if (!resp.length) {
    text += "Пока нет назначенных ответственных.\n";
  } else {
    text += "Ответственные:\n";
    resp.forEach((r, i) => {
      text += `${i + 1}. ${r.full_name}\n`;
    });
  }

  const kb = [];

  if (resp.length) {
    // кнопки удаления 1..N
    const btns = resp.map((r, idx) =>
      Markup.button.callback(
        `${idx + 1}`,
        `admin_resp_del_${r.id}_${kind}_${tradePointId}`
      )
    );
    for (let i = 0; i < btns.length; i += 5) kb.push(btns.slice(i, i + 5));
    kb.push([{ text: "🗑 удалить (нажмите номер)", callback_data: "noop" }]);
  }

  kb.push([
    {
      text: "➕ Назначить ответственного",
      callback_data: `admin_resp_add_${kind}_${tradePointId}`,
    },
  ]);
  kb.push([{ text: "⬅️ Назад", callback_data: `admin_resp_kind_${kind}` }]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(kb) },
    { edit: true }
  );
}

async function showPickUser(ctx, kind, tradePointId) {
  stSet(ctx.from.id, { step: "pick_user", kind, tradePointId });

  const users = await loadUsersForPick();
  const text =
    "➕ <b>Назначить ответственного</b>\n\n" +
    "Выберите пользователя (можно назначать любого сотрудника, не важно админ он или нет):";

  const rows = users.map((u) => [
    Markup.button.callback(u.full_name, `admin_resp_pick_${u.id}`),
  ]);
  rows.push([
    Markup.button.callback(
      "⬅️ Назад",
      `admin_resp_point_${kind}_${tradePointId}`
    ),
  ]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(rows) },
    { edit: true }
  );
}

function registerAdminResponsibles(bot, ensureUser, logError) {
  bot.action("admin_resp_root", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      stClear(ctx.from.id);
      await showRoot(ctx);
    } catch (e) {
      logError("admin_resp_root", e);
    }
  });

  bot.action(
    /^admin_resp_kind_(uncompleted_tasks|complaints)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery().catch(() => {});
        const user = await ensureUser(ctx);
        if (!isAdmin(user)) return;
        const kind = ctx.match[1];
        stClear(ctx.from.id);
        await showPickPoint(ctx, kind);
      } catch (e) {
        logError("admin_resp_kind", e);
      }
    }
  );

  bot.action(
    /^admin_resp_point_(uncompleted_tasks|complaints)_(\d+)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery().catch(() => {});
        const user = await ensureUser(ctx);
        if (!isAdmin(user)) return;
        const kind = ctx.match[1];
        const tpId = Number(ctx.match[2]);
        stClear(ctx.from.id);
        await showPointCard(ctx, kind, tpId);
      } catch (e) {
        logError("admin_resp_point", e);
      }
    }
  );

  bot.action(
    /^admin_resp_add_(uncompleted_tasks|complaints)_(\d+)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery().catch(() => {});
        const user = await ensureUser(ctx);
        if (!isAdmin(user)) return;
        const kind = ctx.match[1];
        const tpId = Number(ctx.match[2]);
        await showPickUser(ctx, kind, tpId);
      } catch (e) {
        logError("admin_resp_add", e);
      }
    }
  );

  bot.action(/^admin_resp_pick_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const st = stGet(ctx.from.id);
      if (!st || st.step !== "pick_user") return;

      const pickedUserId = Number(ctx.match[1]);

      await pool.query(
        `
        INSERT INTO responsible_assignments (trade_point_id, kind, user_id, is_active)
        VALUES ($1,$2,$3,TRUE)
        ON CONFLICT (trade_point_id, kind, user_id)
        DO UPDATE SET is_active=TRUE
        `,
        [Number(st.tradePointId), st.kind, pickedUserId]
      );

      stClear(ctx.from.id);
      await ctx.answerCbQuery("✅ Назначено").catch(() => {});
      await showPointCard(ctx, st.kind, Number(st.tradePointId));
    } catch (e) {
      logError("admin_resp_pick", e);
    }
  });

  bot.action(
    /^admin_resp_del_(\d+)_(uncompleted_tasks|complaints)_(\d+)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery().catch(() => {});
        const user = await ensureUser(ctx);
        if (!isAdmin(user)) return;

        const id = Number(ctx.match[1]);
        const kind = ctx.match[2];
        const tpId = Number(ctx.match[3]);

        await pool.query(
          `UPDATE responsible_assignments SET is_active=FALSE WHERE id=$1`,
          [id]
        );

        await ctx.answerCbQuery("🗑 Удалено").catch(() => {});
        await showPointCard(ctx, kind, tpId);
      } catch (e) {
        logError("admin_resp_del", e);
      }
    }
  );

  bot.action("noop", async (ctx) => ctx.answerCbQuery().catch(() => {}));
}

module.exports = { registerAdminResponsibles };
