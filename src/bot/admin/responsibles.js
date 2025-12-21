// src/bot/admin/responsibles.js
const { Markup } = require("telegraf");
const pool = require("../../db/pool");
const { deliver } = require("../../utils/renderHelpers");

function isAdmin(user) {
  return user && (user.role === "admin" || user.role === "super_admin");
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// in-memory state (как в admin/shiftTasks.js)
const stByTg = new Map();
function getSt(tgId) {
  return stByTg.get(tgId) || null;
}
function setSt(tgId, patch) {
  const prev = getSt(tgId) || {
    step: "root", // root | pick_type | pick_point | list | pick_user
    eventType: null, // 'uncompleted_tasks' | 'complaints'
    pointId: null,
  };
  stByTg.set(tgId, { ...prev, ...patch });
}
function clearSt(tgId) {
  stByTg.delete(tgId);
}

async function loadPoints() {
  const r = await pool.query(
    `
    SELECT id, title
    FROM trade_points
    WHERE is_active = TRUE
    ORDER BY id
    `
  );
  return r.rows;
}

async function loadResponsibles(pointId, eventType) {
  const r = await pool.query(
    `
    SELECT
      r.user_id,
      u.full_name,
      u.username,
      u.work_phone
    FROM trade_point_responsibles r
    JOIN users u ON u.id = r.user_id
    WHERE r.trade_point_id = $1
      AND r.event_type = $2
      AND r.is_active = TRUE
    ORDER BY u.full_name NULLS LAST, u.id ASC
    `,
    [Number(pointId), eventType]
  );
  return r.rows;
}

async function loadUsersForPick(limit = 30) {
  const r = await pool.query(
    `
    SELECT id, full_name, username, work_phone, role, staff_status
    FROM users
    WHERE staff_status = 'employee'
    ORDER BY full_name NULLS LAST, id ASC
    LIMIT $1
    `,
    [Number(limit)]
  );
  return r.rows;
}

function eventTypeTitle(eventType) {
  if (eventType === "uncompleted_tasks") return "по невыполненным задачам";
  if (eventType === "complaints") return "по жалобам на прошлую смену";
  return "—";
}

async function renderRoot(ctx) {
  const text =
    "👤 <b>Назначение ответственных</b>\n\n" +
    "Здесь назначаются ответственные сотрудники по торговым точкам.\n" +
    "Ответственные будут получать уведомления по выбранному типу события.\n\n" +
    "Выберите тип:";

  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "1) По невыполненным задачам за смену",
        "admin_resp_type_uncompleted"
      ),
    ],
    [
      Markup.button.callback(
        "2) По жалобам на прошлую смену",
        "admin_resp_type_complaints"
      ),
    ],
    [Markup.button.callback("⬅️ Назад", "admin_shift_settings")],
  ]);

  await deliver(ctx, { text, extra: kb }, { edit: true });
}

async function renderPickPoint(ctx) {
  const st = getSt(ctx.from.id);
  const points = await loadPoints();

  let text = `📍 <b>Выбор точки</b>\n\n`;
  text += `Тип: <b>${esc(eventTypeTitle(st.eventType))}</b>\n\n`;
  text += `Выберите торговую точку:`;

  const rows = points.map((p) => [
    Markup.button.callback(`🏬 ${p.title}`, `admin_resp_point_${p.id}`),
  ]);
  rows.push([Markup.button.callback("⬅️ Назад", "admin_resp_root")]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(rows) },
    { edit: true }
  );
}

async function renderList(ctx) {
  const st = getSt(ctx.from.id);
  if (!st?.pointId || !st?.eventType) return renderRoot(ctx);

  const pRes = await pool.query(
    `SELECT id, title FROM trade_points WHERE id=$1 LIMIT 1`,
    [Number(st.pointId)]
  );
  const point = pRes.rows[0];
  if (!point) {
    await ctx
      .answerCbQuery("Точка не найдена", { show_alert: true })
      .catch(() => {});
    return renderPickPoint(ctx);
  }

  const list = await loadResponsibles(st.pointId, st.eventType);

  let text = `👤 <b>Ответственные</b>\n\n`;
  text += `• Тип: <b>${esc(eventTypeTitle(st.eventType))}</b>\n`;
  text += `• Точка: <b>${esc(point.title)}</b>\n\n`;

  if (!list.length) {
    text += `Пока никто не назначен.\n`;
  } else {
    text += `<b>Список:</b>\n`;
    list.forEach((u, i) => {
      const n = i + 1;
      const uname = u.username ? ` @${u.username}` : "";
      const phone = u.work_phone ? ` • ${u.work_phone}` : "";
      text += `${n}. ${esc(u.full_name || "Без имени")}${esc(uname)}${esc(
        phone
      )}\n`;
    });
    text += `\nНажмите на человека ниже, чтобы снять назначение.\n`;
  }

  const rows = [];
  if (list.length) {
    const btns = list.map((u, idx) =>
      Markup.button.callback(`${idx + 1}`, `admin_resp_remove_${u.user_id}`)
    );
    for (let i = 0; i < btns.length; i += 5) rows.push(btns.slice(i, i + 5));
  }

  rows.push([
    Markup.button.callback("➕ Назначить ещё", "admin_resp_add_pick_user"),
  ]);
  rows.push([Markup.button.callback("⬅️ Назад", "admin_resp_pick_point")]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(rows) },
    { edit: true }
  );
}

async function renderPickUser(ctx) {
  const st = getSt(ctx.from.id);
  const users = await loadUsersForPick(40);

  let text = `➕ <b>Назначить ответственного</b>\n\n`;
  text += `Выберите пользователя (можно назначать любого сотрудника, не важно админ он или нет):\n`;

  const rows = [];
  users.forEach((u) => {
    const uname = u.username ? ` @${u.username}` : "";
    const label = `${u.full_name || "Без имени"}${uname}`;
    rows.push([Markup.button.callback(label, `admin_resp_add_user_${u.id}`)]);
  });

  rows.push([Markup.button.callback("⬅️ Назад", "admin_resp_list")]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(rows) },
    { edit: true }
  );
}

function registerAdminResponsibles(bot, ensureUser, logError) {
  // entry
  bot.action("admin_resp_root", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      setSt(ctx.from.id, { step: "root", eventType: null, pointId: null });
      await renderRoot(ctx);
    } catch (e) {
      logError("admin_resp_root", e);
    }
  });

  bot.action("admin_resp_type_uncompleted", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      setSt(ctx.from.id, {
        step: "pick_point",
        eventType: "uncompleted_tasks",
        pointId: null,
      });
      await renderPickPoint(ctx);
    } catch (e) {
      logError("admin_resp_type_uncompleted", e);
    }
  });

  bot.action("admin_resp_type_complaints", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      setSt(ctx.from.id, {
        step: "pick_point",
        eventType: "complaints",
        pointId: null,
      });
      await renderPickPoint(ctx);
    } catch (e) {
      logError("admin_resp_type_complaints", e);
    }
  });

  bot.action("admin_resp_pick_point", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      await renderPickPoint(ctx);
    } catch (e) {
      logError("admin_resp_pick_point", e);
    }
  });

  bot.action(/^admin_resp_point_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const pointId = Number(ctx.match[1]);
      const st = getSt(ctx.from.id);
      if (!st?.eventType) {
        setSt(ctx.from.id, { step: "root", pointId: null });
        return renderRoot(ctx);
      }

      setSt(ctx.from.id, { step: "list", pointId });
      await renderList(ctx);
    } catch (e) {
      logError("admin_resp_point_pick", e);
    }
  });

  bot.action("admin_resp_list", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      await renderList(ctx);
    } catch (e) {
      logError("admin_resp_list", e);
    }
  });

  bot.action("admin_resp_add_pick_user", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getSt(ctx.from.id);
      if (!st?.pointId || !st?.eventType) return renderRoot(ctx);

      setSt(ctx.from.id, { step: "pick_user" });
      await renderPickUser(ctx);
    } catch (e) {
      logError("admin_resp_add_pick_user", e);
    }
  });

  bot.action(/^admin_resp_add_user_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const userId = Number(ctx.match[1]);
      const st = getSt(ctx.from.id);
      if (!st?.pointId || !st?.eventType) return renderRoot(ctx);

      await pool.query(
        `
        INSERT INTO trade_point_responsibles (trade_point_id, event_type, user_id, created_by_user_id, is_active)
        VALUES ($1, $2, $3, $4, TRUE)
        ON CONFLICT (trade_point_id, event_type, user_id)
        DO UPDATE SET is_active = TRUE, created_by_user_id = EXCLUDED.created_by_user_id
        `,
        [Number(st.pointId), st.eventType, userId, admin.id]
      );

      await ctx.answerCbQuery("✅ Назначено").catch(() => {});
      setSt(ctx.from.id, { step: "list" });
      await renderList(ctx);
    } catch (e) {
      logError("admin_resp_add_user", e);
    }
  });

  bot.action(/^admin_resp_remove_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const removeUserId = Number(ctx.match[1]);
      const st = getSt(ctx.from.id);
      if (!st?.pointId || !st?.eventType) return renderRoot(ctx);

      await pool.query(
        `
        UPDATE trade_point_responsibles
        SET is_active = FALSE
        WHERE trade_point_id = $1
          AND event_type = $2
          AND user_id = $3
        `,
        [Number(st.pointId), st.eventType, removeUserId]
      );

      await ctx.answerCbQuery("🗑 Удалено").catch(() => {});
      await renderList(ctx);
    } catch (e) {
      logError("admin_resp_remove", e);
    }
  });

  // optional: очистка стейта если надо
  bot.action("admin_resp_clear_state", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      clearSt(ctx.from.id);
      await renderRoot(ctx);
    } catch (e) {
      logError("admin_resp_clear_state", e);
    }
  });
}

module.exports = { registerAdminResponsibles };
