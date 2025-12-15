const { Markup } = require("telegraf");
const pool = require("../../db/pool");
const { deliver } = require("../../utils/renderHelpers");

// =======================
// STATE
// =======================
const aiLogsState = new Map();
// tgId -> { page, filterExpanded, mode }

function getState(tgId) {
  return (
    aiLogsState.get(tgId) || {
      page: 0,
      filterExpanded: false,
      mode: "all", // all | suspected | confirmed | new
    }
  );
}

function setState(tgId, patch) {
  aiLogsState.set(tgId, { ...getState(tgId), ...patch });
}

// =======================
// DB HELPERS
// =======================
async function getTotalCount(mode) {
  let where = "";
  if (mode === "suspected")
    where =
      "WHERE is_offtopic_suspected = true AND is_offtopic_confirmed IS NULL";
  if (mode === "confirmed") where = "WHERE is_offtopic_confirmed = true";
  if (mode === "new") where = "WHERE is_new_for_admin = true";

  const r = await pool.query(
    `SELECT COUNT(*)::int AS cnt FROM ai_chat_logs ${where}`
  );
  return r.rows[0]?.cnt || 0;
}

async function getPage({ page, pageSize = 10, mode }) {
  const offset = page * pageSize;

  let where = "";
  if (mode === "suspected")
    where =
      "WHERE l.is_offtopic_suspected = true AND l.is_offtopic_confirmed IS NULL";
  if (mode === "confirmed") where = "WHERE l.is_offtopic_confirmed = true";
  if (mode === "new") where = "WHERE l.is_new_for_admin = true";

  const r = await pool.query(
    `
    SELECT
      l.id,
      l.created_at,
      l.is_offtopic_suspected,
      l.is_offtopic_confirmed,
      l.is_new_for_admin,
      u.full_name
    FROM ai_chat_logs l
    JOIN users u ON u.id = l.user_id
    ${where}
    ORDER BY l.created_at DESC
    LIMIT $1 OFFSET $2
    `,
    [pageSize, offset]
  );

  return r.rows;
}

async function getOneLog(id) {
  const r = await pool.query(
    `
    SELECT
      l.*,
      u.full_name,
      u.work_phone,
      u.username
    FROM ai_chat_logs l
    JOIN users u ON u.id = l.user_id
    WHERE l.id = $1
    `,
    [id]
  );
  return r.rows[0] || null;
}

async function countConfirmedForUser(userId) {
  const r = await pool.query(
    `
    SELECT COUNT(*)::int AS cnt
    FROM ai_chat_logs
    WHERE user_id = $1 AND is_offtopic_confirmed = true
    `,
    [userId]
  );
  return r.rows[0]?.cnt || 0;
}

async function insertAdminActionLog({
  adminId,
  targetUserId,
  actionType,
  details,
}) {
  await pool.query(
    `
    INSERT INTO admin_action_logs (admin_id, target_user_id, action_type, details, created_at)
    VALUES ($1, $2, $3, $4, NOW())
    `,
    [adminId, targetUserId ?? null, actionType, details ?? null]
  );
}

async function insertNotificationForUser({ createdBy, text, recipientUserId }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const ins = await client.query(
      `
      INSERT INTO notifications (text, created_by, created_at)
      VALUES ($1, $2, NOW())
      RETURNING id
      `,
      [text, createdBy ?? null]
    );

    const notificationId = ins.rows[0]?.id;
    if (!notificationId)
      throw new Error("Не удалось создать notifications row");

    await client.query(
      `
      INSERT INTO user_notifications (user_id, notification_id, is_read, read_at)
      VALUES ($1, $2, false, NULL)
      `,
      [recipientUserId, notificationId]
    );

    await client.query("COMMIT");
    return notificationId;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

async function sendTelegramToUser(bot, userId, text) {
  const r = await pool.query(`SELECT telegram_id FROM users WHERE id = $1`, [
    userId,
  ]);
  const tg = r.rows[0]?.telegram_id;
  if (!tg) return;

  // без кнопок пока (позже можно добавить "🔔 Уведомления")
  await bot.telegram.sendMessage(Number(tg), text).catch(() => {});
}

// =======================
// RENDER LIST
// =======================
async function renderList(ctx, { edit = true } = {}) {
  const tgId = ctx.from.id;
  const st = getState(tgId);
  const pageSize = 10;

  const total = await getTotalCount(st.mode);
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(st.page, totalPages - 1);

  setState(tgId, { page });

  const items = await getPage({ page, pageSize, mode: st.mode });

  let text =
    "🤖 *История обращений к ИИ*\n\n" +
    `Фильтр: *${st.mode}*\n` +
    `Страница: ${page + 1} / ${totalPages}\n\n` +
    "Выберите обращение:";

  const kb = [];

  // ---- items as buttons
  if (!items.length) {
    kb.push([Markup.button.callback("— нет обращений —", "noop")]);
  } else {
    for (const it of items) {
      const flags = [];
      if (it.is_offtopic_suspected || it.is_offtopic_confirmed)
        flags.push("❗");
      if (it.is_new_for_admin) flags.push("🆕");

      const label = `${flags.join("")} ${it.created_at.toLocaleDateString(
        "ru-RU"
      )} — ${it.full_name}`;

      kb.push([
        Markup.button.callback(label.slice(0, 64), `admin_ai_open_${it.id}`),
      ]);
    }
  }

  // ---- pagination
  const nav = [];
  if (page > 0) nav.push(Markup.button.callback("⬅️", "admin_ai_prev"));
  if (page < totalPages - 1)
    nav.push(Markup.button.callback("➡️", "admin_ai_next"));
  if (nav.length) kb.push(nav);

  // ---- filter toggle
  kb.push([
    Markup.button.callback(
      st.filterExpanded ? "🔎 Фильтр (скрыть)" : "🔎 Фильтр",
      "admin_ai_filter_toggle"
    ),
  ]);

  // ---- filter panel
  if (st.filterExpanded) {
    kb.push([
      Markup.button.callback(
        st.mode === "all" ? "✅ Все" : "Все",
        "admin_ai_mode_all"
      ),
    ]);
    kb.push([
      Markup.button.callback(
        st.mode === "suspected" ? "✅ ❗ Подозрение" : "❗ Подозрение",
        "admin_ai_mode_suspected"
      ),
    ]);
    kb.push([
      Markup.button.callback(
        st.mode === "confirmed" ? "✅ Подтверждённые" : "Подтверждённые",
        "admin_ai_mode_confirmed"
      ),
    ]);
    kb.push([
      Markup.button.callback(
        st.mode === "new" ? "✅ 🆕 Новые" : "🆕 Новые",
        "admin_ai_mode_new"
      ),
    ]);
  }

  kb.push([Markup.button.callback("📊 Статистика", "admin_ai_stats")]);

  kb.push([Markup.button.callback("⬅️ Назад", "lk_admin_menu")]);

  await deliver(
    ctx,
    {
      text,
      extra: { ...Markup.inlineKeyboard(kb), parse_mode: "Markdown" },
    },
    { edit }
  );
}

// =======================
// RENDER ONE LOG
// =======================
async function renderOne(ctx, id, { edit = true } = {}) {
  const log = await getOneLog(id);
  if (!log) {
    await ctx.answerCbQuery("Не найдено").catch(() => {});
    return;
  }

  // mark as read for admin
  if (log.is_new_for_admin) {
    await pool.query(
      `UPDATE ai_chat_logs SET is_new_for_admin = false WHERE id = $1`,
      [id]
    );
  }

  const confirmedCount = await countConfirmedForUser(log.user_id);

  let text =
    `📄 *Обращение #${log.id}*\n\n` +
    `👤 ${log.full_name}\n` +
    `📅 ${log.created_at.toLocaleString("ru-RU")}\n` +
    `⚠️ Замечаний: ${confirmedCount}\n\n` +
    `❓ *Вопрос:*\n${log.question}\n\n` +
    `🤖 *Ответ ИИ:*\n${log.answer}\n\n`;

  if (log.is_offtopic_confirmed) {
    text += "✅ *Подтверждено: не по работе*\n";
  } else if (log.is_offtopic_suspected) {
    text +=
      "❗ *Система считает, что вопрос не по работе.*\nПодтвердите, если это так.\n";
  }

  const kb = [];

  if (log.is_offtopic_suspected && log.is_offtopic_confirmed === null) {
    kb.push([
      Markup.button.callback("❗ Вопрос не по работе", `admin_ai_mark_${id}`),
    ]);
  }

  kb.push([Markup.button.callback("⬅️ Назад к списку", "admin_ai_logs")]);

  await deliver(
    ctx,
    {
      text,
      extra: { ...Markup.inlineKeyboard(kb), parse_mode: "Markdown" },
    },
    { edit }
  );
}

// =======================
// REGISTER
// =======================
function registerAiLogs(bot, ensureUser, logError) {
  // entry
  bot.action("admin_ai_logs", async (ctx) => {
    try {
      await ctx.answerCbQuery();
      const admin = await ensureUser(ctx);
      if (!admin || admin.role === "user") return;

      setState(ctx.from.id, { page: 0, filterExpanded: false, mode: "all" });
      await renderList(ctx);
    } catch (e) {
      logError("admin_ai_logs", e);
    }
  });

  bot.action("admin_ai_prev", async (ctx) => {
    const st = getState(ctx.from.id);
    setState(ctx.from.id, { page: Math.max(0, st.page - 1) });
    await renderList(ctx);
  });

  bot.action("admin_ai_next", async (ctx) => {
    const st = getState(ctx.from.id);
    setState(ctx.from.id, { page: st.page + 1 });
    await renderList(ctx);
  });

  bot.action("admin_ai_filter_toggle", async (ctx) => {
    const st = getState(ctx.from.id);
    setState(ctx.from.id, { filterExpanded: !st.filterExpanded });
    await renderList(ctx);
  });

  bot.action(/admin_ai_mode_(all|suspected|confirmed|new)/, async (ctx) => {
    const mode = ctx.match[1];
    setState(ctx.from.id, { mode, page: 0 });
    await renderList(ctx);
  });

  bot.action(/admin_ai_open_(\d+)/, async (ctx) => {
    const id = Number(ctx.match[1]);
    await renderOne(ctx, id);
  });

  bot.action(/admin_ai_mark_(\d+)/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin"))
        return;

      const id = Number(ctx.match[1]);
      const log = await getOneLog(id);
      if (!log) return;

      const confirmedCount = await countConfirmedForUser(log.user_id);

      // 1) Первое нарушение -> сразу предупреждение
      if (confirmedCount === 0) {
        await pool.query(
          `UPDATE ai_chat_logs SET is_offtopic_confirmed = true WHERE id = $1`,
          [id]
        );

        await insertAdminActionLog({
          adminId: admin.id,
          targetUserId: log.user_id,
          actionType: "ai_offtopic_warning",
          details: { logId: id },
        });

        const warnText =
          "⚠️ Предупреждение\n\n" +
          "Ваш вопрос был отмечен администратором как *не относящийся к работе*.\n" +
          "Пожалуйста, задавайте вопросы по рабочим задачам.";

        await insertNotificationForUser({
          createdBy: admin.id, // это “пользовательское” (из админки)
          recipientUserId: log.user_id,
          text: warnText,
        });

        await sendTelegramToUser(bot, log.user_id, warnText);

        await renderOne(ctx, id);
        return;
      }

      // 2) Повтор -> спрашиваем про штраф
      await deliver(ctx, {
        text: "Это повторное нарушение.\nНазначить штраф 100₽?",
        extra: Markup.inlineKeyboard([
          [Markup.button.callback("✅ Штраф 100₽", `admin_ai_fine_yes_${id}`)],
          [
            Markup.button.callback(
              "⚠️ Только предупреждение",
              `admin_ai_fine_no_${id}`
            ),
          ],
          [Markup.button.callback("⬅️ Отмена", `admin_ai_open_${id}`)],
        ]),
      });
    } catch (e) {
      logError("admin_ai_mark", e);
    }
  });

  bot.action(/admin_ai_fine_(yes|no)_(\d+)/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin"))
        return;

      const yes = ctx.match[1] === "yes";
      const id = Number(ctx.match[2]);

      const log = await getOneLog(id);
      if (!log) return;

      await pool.query(
        `UPDATE ai_chat_logs SET is_offtopic_confirmed = true WHERE id = $1`,
        [id]
      );

      if (yes) {
        await insertAdminActionLog({
          adminId: admin.id,
          targetUserId: log.user_id,
          actionType: "ai_offtopic_fine",
          details: { logId: id, amount: 100 },
        });

        const fineText =
          "💸 Штраф 100₽\n\n" +
          "Ваш вопрос был отмечен администратором как *не относящийся к работе*.\n" +
          "Повторные нарушения фиксируются.";

        await insertNotificationForUser({
          createdBy: admin.id,
          recipientUserId: log.user_id,
          text: fineText,
        });

        await sendTelegramToUser(bot, log.user_id, fineText);
      } else {
        await insertAdminActionLog({
          adminId: admin.id,
          targetUserId: log.user_id,
          actionType: "ai_offtopic_warning_repeat",
          details: { logId: id },
        });

        const warnText =
          "⚠️ Повторное предупреждение\n\n" +
          "Ваш вопрос был отмечен администратором как *не относящийся к работе*.\n" +
          "Пожалуйста, задавайте вопросы по рабочим задачам.";

        await insertNotificationForUser({
          createdBy: admin.id,
          recipientUserId: log.user_id,
          text: warnText,
        });

        await sendTelegramToUser(bot, log.user_id, warnText);
      }

      await renderOne(ctx, id);
    } catch (e) {
      logError("admin_ai_fine", e);
    }
  });

  bot.action("admin_ai_stats", async (ctx) => {
    const r = await pool.query(`
      SELECT
        COUNT(*) AS total,
        COUNT(DISTINCT user_id) AS users,
        COUNT(*) FILTER (WHERE is_offtopic_confirmed = true) AS confirmed,
        COUNT(*) FILTER (WHERE is_offtopic_suspected = true) AS suspected
      FROM ai_chat_logs
    `);

    const s = r.rows[0];

    await deliver(ctx, {
      text:
        "📊 *Статистика ИИ*\n\n" +
        `Всего обращений: ${s.total}\n` +
        `Пользователей: ${s.users}\n` +
        `Подтверждено не по работе: ${s.confirmed}\n` +
        `Подозрений: ${s.suspected}`,
      extra: Markup.inlineKeyboard([
        [Markup.button.callback("⬅️ К списку", "admin_ai_logs")],
      ]),
      parse_mode: "Markdown",
    });
  });

  bot.action("noop", (ctx) => ctx.answerCbQuery().catch(() => {}));
}

module.exports = { registerAiLogs };
