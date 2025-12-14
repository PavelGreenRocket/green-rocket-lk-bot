// src/bot/notifications.js

const { Markup } = require("telegraf");
const pool = require("../db/pool");
const { deliver } = require("../utils/renderHelpers");

// --------------------
// helpers
// --------------------

function posLabel(position) {
  if (!position) return "должность не указана";
  if (position === "barista") return "бариста";
  if (position === "point_admin") return "администратор точки";
  if (position === "senior_admin") return "старший администратор";
  if (position === "quality_manager") return "менеджер по качеству";
  if (position === "manager") return "управляющий";
  return position;
}

function formatDtRu(dt) {
  if (!dt) return "";
  const d = new Date(dt);
  if (Number.isNaN(d.getTime())) return "";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mi = String(d.getMinutes()).padStart(2, "0");
  return `${dd}.${mm} ${hh}:${mi}`;
}

function safeTrim(text, max = 3500) {
  const t = String(text || "").trim();
  if (t.length <= max) return t;
  return t.slice(0, max - 1) + "…";
}

// --------------------
// DB queries (assumptions based on current project)
// notifications: id, text, created_at, created_by (nullable for system later)
// user_notifications: user_id, notification_id, is_read, read_at
// --------------------

async function getUnreadCount(userId) {
  const r = await pool.query(
    `
    SELECT COUNT(*)::int AS cnt
    FROM user_notifications un
    JOIN notifications n ON n.id = un.notification_id
    WHERE un.user_id = $1
      AND COALESCE(un.is_read, false) = false
    `,
    [userId]
  );
  return Number(r.rows[0]?.cnt || 0);
}

async function getUnreadCountByKind(userId, kind) {
  // kind: "user" | "system"
  const isSystem = kind === "system";
  const r = await pool.query(
    `
    SELECT COUNT(*)::int AS cnt
    FROM user_notifications un
    JOIN notifications n ON n.id = un.notification_id
    WHERE un.user_id = $1
      AND COALESCE(un.is_read, false) = false
      AND (CASE WHEN n.created_by IS NULL THEN true ELSE false END) = $2
    `,
    [userId, isSystem]
  );
  return Number(r.rows[0]?.cnt || 0);
}

async function getLatestUnread(userId, kind) {
  const isSystem = kind === "system";
  const r = await pool.query(
    `
    SELECT
      n.id,
      n.text,
      n.created_at,
      n.created_by,
      u.full_name AS sender_name,
      u.position  AS sender_position
    FROM user_notifications un
    JOIN notifications n ON n.id = un.notification_id
    LEFT JOIN users u ON u.id = n.created_by
    WHERE un.user_id = $1
      AND COALESCE(un.is_read, false) = false
      AND (CASE WHEN n.created_by IS NULL THEN true ELSE false END) = $2
    ORDER BY n.created_at DESC, n.id DESC
    LIMIT 1
    `,
    [userId, isSystem]
  );
  return r.rows[0] || null;
}

async function markAllAsRead(userId, kind) {
  const isSystem = kind === "system";
  await pool.query(
    `
    UPDATE user_notifications un
    SET is_read = true,
        read_at = NOW()
    FROM notifications n
    WHERE n.id = un.notification_id
      AND un.user_id = $1
      AND COALESCE(un.is_read, false) = false
      AND (CASE WHEN n.created_by IS NULL THEN true ELSE false END) = $2
    `,
    [userId, isSystem]
  );
}

async function insertNotificationAndFanout({
  createdBy,
  text,
  recipientUserIds,
}) {
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

    // fan-out
    if (recipientUserIds.length) {
      await client.query(
        `
        INSERT INTO user_notifications (user_id, notification_id, is_read, read_at)
        SELECT x.user_id, $1, false, NULL
        FROM UNNEST($2::int[]) AS x(user_id)
        `,
        [notificationId, recipientUserIds]
      );
    }

    await client.query("COMMIT");
    return notificationId;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// --------------------
// USER SCREEN state
// --------------------

const userViewState = new Map(); // tgId -> { tab: "user" | "system" }

function getUserViewState(tgId) {
  return userViewState.get(tgId) || { tab: "user" };
}
function setUserViewState(tgId, patch) {
  const prev = getUserViewState(tgId);
  userViewState.set(tgId, { ...prev, ...patch });
}

// --------------------
// ADMIN COMPOSER state (new mailing)
// --------------------

const adminComposer = new Map();
/**
 * tgId -> {
 *   step: "idle" | "await_text",
 *   filter: "workers" | "workers_interns" | "interns",
 *   excludeIds: number[],
 *   pickIds: number[], // if not empty => send to these конкретным
 * }
 */
function getComposer(tgId) {
  return (
    adminComposer.get(tgId) || {
      step: "idle",
      filter: "workers",
      excludeIds: [],
      pickIds: [],
    }
  );
}
function setComposer(tgId, patch) {
  adminComposer.set(tgId, { ...getComposer(tgId), ...patch });
}
function clearComposer(tgId) {
  adminComposer.delete(tgId);
}

function filterLabel(f) {
  if (f === "workers") return "Только сотрудники";
  if (f === "workers_interns") return "Сотрудники и стажёры";
  if (f === "interns") return "Только стажёры";
  return f;
}

function buildAdminComposerKeyboard(st) {
  const isWorkers = st.filter === "workers";
  const isWI = st.filter === "workers_interns";
  const isInterns = st.filter === "interns";

  const pickMode = (st.pickIds || []).length > 0;
  const pickCount = (st.pickIds || []).length;
  const exclCount = (st.excludeIds || []).length;

  return Markup.inlineKeyboard([
    [
      Markup.button.callback(
        `${isWorkers ? "✅ " : ""}Только сотрудники`,
        "lk_notif_admin_filter_workers"
      ),
    ],
    [
      Markup.button.callback(
        `${isWI ? "✅ " : ""}Сотрудники и стажёры`,
        "lk_notif_admin_filter_workers_interns"
      ),
    ],
    [
      Markup.button.callback(
        `${isInterns ? "✅ " : ""}Только стажёры`,
        "lk_notif_admin_filter_interns"
      ),
    ],
    [
      Markup.button.callback(
        pickMode ? `👥 Выбранные (${pickCount})` : "👥 Отправить конкретным",
        "lk_notif_admin_pick_users"
      ),
    ],
    [
      Markup.button.callback(
        exclCount
          ? `➖ Исключения (${exclCount})`
          : "➖ Исключить пользователя",
        "lk_notif_admin_exclude_users"
      ),
    ],
    [
      Markup.button.callback("⬅️ Назад", "lk_admin_notifications"),
      Markup.button.callback("❌ Отмена", "lk_notif_admin_cancel"),
    ],
  ]);
}

async function resolveRecipientsByFilter(filter) {
  // важно: пользователь сказал, что считаем статусы как в меню (worker/intern/candidate) — верно
  // тут используются worker/intern
  let where = "u.staff_status = 'worker'";
  if (filter === "workers_interns") {
    where = "u.staff_status IN ('worker','intern')";
  } else if (filter === "interns") {
    where = "u.staff_status = 'intern'";
  }

  const r = await pool.query(
    `
    SELECT u.id, u.telegram_id
    FROM users u
    WHERE ${where}
      AND u.telegram_id IS NOT NULL
    ORDER BY u.id
    `,
    []
  );

  return r.rows.map((x) => ({
    id: Number(x.id),
    telegram_id: Number(x.telegram_id),
  }));
}

// --------------------
// ADMIN lists for pick/exclude
// --------------------

const adminPickState = new Map(); // tgId -> { mode: "pick"|"exclude", page, ids: number[] }

function getPickState(tgId) {
  return adminPickState.get(tgId) || { mode: "pick", page: 0 };
}
function setPickState(tgId, patch) {
  adminPickState.set(tgId, { ...getPickState(tgId), ...patch });
}
function clearPickState(tgId) {
  adminPickState.delete(tgId);
}

async function loadUsersPage({ page, pageSize = 20 }) {
  const offset = page * pageSize;
  const r = await pool.query(
    `
    SELECT id, full_name, staff_status, position
    FROM users
    WHERE telegram_id IS NOT NULL
    ORDER BY id DESC
    LIMIT $1 OFFSET $2
    `,
    [pageSize, offset]
  );
  return r.rows.map((u) => ({
    id: Number(u.id),
    full_name: u.full_name || "Без имени",
    staff_status: u.staff_status || "worker",
    position: u.position || null,
  }));
}

function buildUsersPageText(title, st, users, selectedIds) {
  let text = `👥 *${title}*\n\n`;
  if (!users.length) {
    text += "_Пользователей не найдено._\n";
    return text;
  }
  text += `Страница: ${st.page + 1}\n\n`;
  for (const u of users) {
    const mark = selectedIds.includes(u.id) ? "✅" : "▫️";
    text += `${mark} [${u.id}] ${u.full_name} — ${u.staff_status}${
      u.position ? `, ${posLabel(u.position)}` : ""
    }\n`;
  }
  return text;
}

function buildUsersPageKeyboard(prefix, users, selectedIds, page) {
  const rows = [];

  for (const u of users) {
    const mark = selectedIds.includes(u.id) ? "✅" : "▫️";
    rows.push([
      Markup.button.callback(
        `${mark} ${u.full_name}`,
        `${prefix}_toggle_${u.id}`
      ),
    ]);
  }

  const nav = [];
  if (page > 0) nav.push(Markup.button.callback("⬅️", `${prefix}_prev`));
  nav.push(Markup.button.callback("➡️", `${prefix}_next`));
  rows.push(nav);

  rows.push([
    Markup.button.callback("✅ Готово", `${prefix}_done`),
    Markup.button.callback("⬅️ Назад", "lk_notif_admin_new"),
  ]);

  return Markup.inlineKeyboard(rows);
}

// --------------------
// ADMIN: status last + history
// --------------------

const adminHistoryState = new Map(); // tgId -> { page:0, sender:"all"|number }
function getAdminHistoryState(tgId) {
  return adminHistoryState.get(tgId) || { page: 0, sender: "all" };
}
function setAdminHistoryState(tgId, patch) {
  adminHistoryState.set(tgId, { ...getAdminHistoryState(tgId), ...patch });
}

async function getLastNotification() {
  const r = await pool.query(
    `
    SELECT n.id, n.text, n.created_at, n.created_by,
           u.full_name AS sender_name, u.position AS sender_position
    FROM notifications n
    LEFT JOIN users u ON u.id = n.created_by
    ORDER BY n.created_at DESC, n.id DESC
    LIMIT 1
    `
  );
  return r.rows[0] || null;
}

async function getUnreadUsersForNotification(notificationId, limit = 60) {
  const r = await pool.query(
    `
    SELECT u.id, u.full_name, u.staff_status, u.position
    FROM user_notifications un
    JOIN users u ON u.id = un.user_id
    WHERE un.notification_id = $1
      AND COALESCE(un.is_read, false) = false
    ORDER BY u.staff_status, u.full_name
    LIMIT $2
    `,
    [notificationId, limit]
  );
  return r.rows.map((u) => ({
    id: Number(u.id),
    full_name: u.full_name || "Без имени",
    staff_status: u.staff_status || "worker",
    position: u.position || null,
  }));
}

async function countUnreadUsersForNotification(notificationId) {
  const r = await pool.query(
    `
    SELECT COUNT(*)::int AS cnt
    FROM user_notifications
    WHERE notification_id = $1
      AND COALESCE(is_read, false) = false
    `,
    [notificationId]
  );
  return Number(r.rows[0]?.cnt || 0);
}

async function getHistoryPage({ page, pageSize = 10, sender }) {
  const offset = page * pageSize;
  const params = [];
  let where = "";

  if (sender !== "all") {
    params.push(Number(sender));
    where = `WHERE n.created_by = $${params.length}`;
  }

  params.push(pageSize, offset);

  const r = await pool.query(
    `
    SELECT n.id, n.text, n.created_at, n.created_by,
           u.full_name AS sender_name, u.position AS sender_position
    FROM notifications n
    LEFT JOIN users u ON u.id = n.created_by
    ${where}
    ORDER BY n.created_at DESC, n.id DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
    `,
    params
  );

  return r.rows.map((x) => ({
    id: x.id,
    text: x.text || "",
    created_at: x.created_at,
    created_by: x.created_by,
    sender_name: x.sender_name || null,
    sender_position: x.sender_position || null,
  }));
}

async function getAdminsList(limit = 30) {
  const r = await pool.query(
    `
    SELECT id, full_name, position, role
    FROM users
    WHERE role IN ('admin','super_admin')
      AND telegram_id IS NOT NULL
    ORDER BY role, full_name
    LIMIT $1
    `,
    [limit]
  );
  return r.rows.map((u) => ({
    id: Number(u.id),
    full_name: u.full_name || "Без имени",
    position: u.position || null,
    role: u.role || "admin",
  }));
}

// --------------------
// screens (user)
// --------------------

async function showUserNotificationsScreen(ctx, user, { edit = true } = {}) {
  const tgId = ctx.from.id;
  const view = getUserViewState(tgId);
  const tab = view.tab || "user";

  const unreadCntUser = await getUnreadCountByKind(user.id, "user");
  const unreadCntSys = await getUnreadCountByKind(user.id, "system");

  const latest = await getLatestUnread(user.id, tab);

  let text = "🔔 *Уведомления*\n\n";

  if (!latest) {
    text += "Сейчас нет новых уведомлений.";
  } else {
    if (tab === "system") {
      text += `*Системное уведомление*\n`;
    } else {
      const fromName = latest.sender_name || "Неизвестно";
      const fromPos = posLabel(latest.sender_position);
      text += `*Пользовательское уведомление*\n`;
      text += `От: ${fromName}, ${fromPos}\n`;
    }
    text += latest.created_at
      ? `Дата: ${formatDtRu(latest.created_at)}\n\n`
      : "\n";
    text += safeTrim(latest.text, 3500);
  }

  const rows = [];

  rows.push([
    Markup.button.callback(
      `${tab === "user" ? "✅ " : ""}Пользовательские (${unreadCntUser})`,
      "lk_notif_tab_user"
    ),
  ]);
  rows.push([
    Markup.button.callback(
      `${tab === "system" ? "✅ " : ""}Системные (${unreadCntSys})`,
      "lk_notif_tab_system"
    ),
  ]);

  if (latest) {
    rows.push([Markup.button.callback("✅ Прочитал", "lk_notif_mark_read")]);
  }

  rows.push([Markup.button.callback("⬅️ В меню", "lk_main_menu")]);

  const keyboard = Markup.inlineKeyboard(rows);

  await deliver(
    ctx,
    { text, extra: { ...keyboard, parse_mode: "Markdown" } },
    { edit }
  );
}

// --------------------
// screens (admin)
// --------------------

async function showAdminNotificationsRoot(ctx, { edit = true } = {}) {
  const text = "📢 *Уведомления (рассылки)*\n\n" + "Выберите действие:";

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("🆕 Новое уведомление", "lk_notif_admin_new")],
    [
      Markup.button.callback(
        "📊 Статус последнего",
        "lk_notif_admin_last_status"
      ),
    ],
    [
      Markup.button.callback(
        "📜 История уведомлений",
        "lk_notif_admin_history"
      ),
    ],
    [Markup.button.callback("⬅️ Назад", "lk_admin_menu")],
  ]);

  await deliver(
    ctx,
    { text, extra: { ...keyboard, parse_mode: "Markdown" } },
    { edit }
  );
}

async function showAdminNewComposer(ctx, admin, { edit = true } = {}) {
  const tgId = ctx.from.id;
  const st = getComposer(tgId);

  const pickMode = (st.pickIds || []).length > 0;
  const exclCount = (st.excludeIds || []).length;

  let text =
    "🆕 *Новое уведомление*\n\n" +
    "Отправь *текст уведомления* следующим сообщением.\n\n";

  if (pickMode) {
    text += `Режим получателей: *конкретные пользователи* (${st.pickIds.length})\n`;
  } else {
    text += `Фильтр получателей: *${filterLabel(st.filter)}*\n`;
  }

  if (exclCount) {
    text += `Исключено: ${exclCount}\n`;
  }

  text +=
    "\nПодсказка: можно сначала настроить фильтры/выбор, потом отправить текст.";

  setComposer(tgId, { step: "await_text" });

  const keyboard = buildAdminComposerKeyboard(st);
  await deliver(
    ctx,
    { text, extra: { ...keyboard, parse_mode: "Markdown" } },
    { edit }
  );
}

async function showAdminLastStatus(ctx, { edit = true } = {}) {
  const last = await getLastNotification();
  if (!last) {
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback("⬅️ Назад", "lk_admin_notifications")],
    ]);
    await deliver(
      ctx,
      {
        text: "📊 *Статус последнего*\n\nПока нет ни одного уведомления.",
        extra: { ...keyboard, parse_mode: "Markdown" },
      },
      { edit }
    );
    return;
  }

  const unreadTotal = await countUnreadUsersForNotification(last.id);
  const unreadUsers = await getUnreadUsersForNotification(last.id, 60);

  const sender =
    last.created_by == null
      ? "Системное"
      : `Пользовательское: ${last.sender_name || "Неизвестно"}, ${posLabel(
          last.sender_position
        )}`;

  let text =
    "📊 *Статус последнего уведомления*\n\n" +
    `ID: ${last.id}\n` +
    `Тип: ${sender}\n` +
    `Дата: ${formatDtRu(last.created_at)}\n\n` +
    `${safeTrim(last.text, 1500)}\n\n` +
    `Не прочитали: *${unreadTotal}*\n`;

  if (!unreadTotal) {
    text += "\n_Все прочитали._";
  } else {
    text += "\nСписок (первые 60):\n";
    for (const u of unreadUsers) {
      text += `• [${u.id}] ${u.full_name} — ${u.staff_status}${
        u.position ? `, ${posLabel(u.position)}` : ""
      }\n`;
    }
    if (unreadTotal > unreadUsers.length) {
      text += `…и ещё ${unreadTotal - unreadUsers.length}\n`;
    }
  }

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("⬅️ Назад", "lk_admin_notifications")],
  ]);

  await deliver(
    ctx,
    { text, extra: { ...keyboard, parse_mode: "Markdown" } },
    { edit }
  );
}

async function showAdminHistory(ctx, { edit = true } = {}) {
  const tgId = ctx.from.id;
  const st = getAdminHistoryState(tgId);
  const page = Math.max(0, Number(st.page || 0));
  const sender = st.sender ?? "all";

  const items = await getHistoryPage({ page, pageSize: 10, sender });

  let header = "📜 *История уведомлений*\n\n";
  header += `Фильтр отправителя: *${
    sender === "all" ? "все" : `id=${sender}`
  }*\n`;
  header += `Страница: ${page + 1}\n\n`;

  let text = header;

  if (!items.length) {
    text += "_Сообщений нет на этой странице._";
  } else {
    for (const n of items) {
      const who =
        n.created_by == null
          ? "Системное"
          : `${n.sender_name || "Неизвестно"}, ${posLabel(n.sender_position)}`;
      text += `*#${n.id}* · ${formatDtRu(n.created_at)}\n`;
      text += `От: ${who}\n`;
      text += `${safeTrim(n.text, 350)}\n\n`;
    }
  }

  const admins = await getAdminsList(20);

  const kb = [];
  kb.push([
    Markup.button.callback("⬅️", "lk_notif_admin_hist_prev"),
    Markup.button.callback("➡️", "lk_notif_admin_hist_next"),
  ]);

  kb.push([
    Markup.button.callback(
      sender === "all" ? "✅ Все отправители" : "Все отправители",
      "lk_notif_admin_hist_sender_all"
    ),
  ]);

  // быстрый выбор отправителя (до 10-12 кнопок, чтобы не раздувать)
  const adminBtns = admins
    .slice(0, 10)
    .map((a) =>
      Markup.button.callback(
        `${sender === a.id ? "✅ " : ""}${a.full_name}`,
        `lk_notif_admin_hist_sender_${a.id}`
      )
    );
  for (let i = 0; i < adminBtns.length; i += 2) {
    kb.push(adminBtns.slice(i, i + 2));
  }

  kb.push([Markup.button.callback("⬅️ Назад", "lk_admin_notifications")]);

  const keyboard = Markup.inlineKeyboard(kb);

  await deliver(
    ctx,
    { text, extra: { ...keyboard, parse_mode: "Markdown" } },
    { edit }
  );
}

// --------------------
// register
// --------------------

function registerNotifications(bot, ensureUser, logError) {
  // USER: open screen
  bot.action("lk_notifications", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      // default tab
      setUserViewState(ctx.from.id, { tab: "user" });

      await showUserNotificationsScreen(ctx, user, { edit: true });
    } catch (err) {
      logError("lk_notifications", err);
    }
  });

  bot.action("lk_notif_tab_user", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      setUserViewState(ctx.from.id, { tab: "user" });
      await showUserNotificationsScreen(ctx, user, { edit: true });
    } catch (err) {
      logError("lk_notif_tab_user", err);
    }
  });

  bot.action("lk_notif_tab_system", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      setUserViewState(ctx.from.id, { tab: "system" });
      await showUserNotificationsScreen(ctx, user, { edit: true });
    } catch (err) {
      logError("lk_notif_tab_system", err);
    }
  });

  bot.action("lk_notif_mark_read", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const view = getUserViewState(ctx.from.id);
      const tab = view.tab || "user";

      await markAllAsRead(user.id, tab);

      await showUserNotificationsScreen(ctx, user, { edit: true });
    } catch (err) {
      logError("lk_notif_mark_read", err);
    }
  });

  // ADMIN ROOT (entry from admin->mailings)
  bot.action("lk_admin_notifications", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin"))
        return;

      await showAdminNotificationsRoot(ctx, { edit: true });
    } catch (err) {
      logError("lk_admin_notifications", err);
    }
  });

  // ADMIN: root actions
  bot.action("lk_notif_admin_new", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin"))
        return;

      // reset state for new compose
      setComposer(ctx.from.id, {
        step: "await_text",
        filter: "workers", // default = only workers
        excludeIds: [],
        pickIds: [],
      });

      await showAdminNewComposer(ctx, admin, { edit: true });
    } catch (err) {
      logError("lk_notif_admin_new", err);
    }
  });

  bot.action("lk_notif_admin_cancel", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin"))
        return;

      clearComposer(ctx.from.id);
      clearPickState(ctx.from.id);

      await showAdminNotificationsRoot(ctx, { edit: true });
    } catch (err) {
      logError("lk_notif_admin_cancel", err);
    }
  });

  bot.action("lk_notif_admin_last_status", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin"))
        return;

      await showAdminLastStatus(ctx, { edit: true });
    } catch (err) {
      logError("lk_notif_admin_last_status", err);
    }
  });

  bot.action("lk_notif_admin_history", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin"))
        return;

      setAdminHistoryState(ctx.from.id, { page: 0, sender: "all" });
      await showAdminHistory(ctx, { edit: true });
    } catch (err) {
      logError("lk_notif_admin_history", err);
    }
  });

  // ADMIN: composer filter toggles
  bot.action("lk_notif_admin_filter_workers", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin"))
        return;

      setComposer(ctx.from.id, { filter: "workers" });
      await showAdminNewComposer(ctx, admin, { edit: true });
    } catch (err) {
      logError("lk_notif_admin_filter_workers", err);
    }
  });

  bot.action("lk_notif_admin_filter_workers_interns", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin"))
        return;

      setComposer(ctx.from.id, { filter: "workers_interns" });
      await showAdminNewComposer(ctx, admin, { edit: true });
    } catch (err) {
      logError("lk_notif_admin_filter_workers_interns", err);
    }
  });

  bot.action("lk_notif_admin_filter_interns", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin"))
        return;

      setComposer(ctx.from.id, { filter: "interns" });
      await showAdminNewComposer(ctx, admin, { edit: true });
    } catch (err) {
      logError("lk_notif_admin_filter_interns", err);
    }
  });

  // ADMIN: pick users
  bot.action("lk_notif_admin_pick_users", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin"))
        return;

      setPickState(ctx.from.id, { mode: "pick", page: 0 });

      const st = getComposer(ctx.from.id);
      const users = await loadUsersPage({ page: 0, pageSize: 20 });
      const selected = st.pickIds || [];

      const text = buildUsersPageText(
        "Выбрать получателей",
        { page: 0 },
        users,
        selected
      );
      const keyboard = buildUsersPageKeyboard(
        "lk_notif_pick",
        users,
        selected,
        0
      );

      await deliver(
        ctx,
        { text, extra: { ...keyboard, parse_mode: "Markdown" } },
        { edit: true }
      );
    } catch (err) {
      logError("lk_notif_admin_pick_users", err);
    }
  });

  // ADMIN: exclude users
  bot.action("lk_notif_admin_exclude_users", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin"))
        return;

      setPickState(ctx.from.id, { mode: "exclude", page: 0 });

      const st = getComposer(ctx.from.id);
      const users = await loadUsersPage({ page: 0, pageSize: 20 });
      const selected = st.excludeIds || [];

      const text = buildUsersPageText(
        "Исключить пользователей",
        { page: 0 },
        users,
        selected
      );
      const keyboard = buildUsersPageKeyboard(
        "lk_notif_excl",
        users,
        selected,
        0
      );

      await deliver(
        ctx,
        { text, extra: { ...keyboard, parse_mode: "Markdown" } },
        { edit: true }
      );
    } catch (err) {
      logError("lk_notif_admin_exclude_users", err);
    }
  });

  // --- pick pagination + toggle
  bot.action("lk_notif_pick_prev", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin"))
        return;

      const ps = getPickState(ctx.from.id);
      const page = Math.max(0, (ps.page || 0) - 1);
      setPickState(ctx.from.id, { page });

      const st = getComposer(ctx.from.id);
      const users = await loadUsersPage({ page, pageSize: 20 });
      const selected = st.pickIds || [];

      const text = buildUsersPageText(
        "Выбрать получателей",
        { page },
        users,
        selected
      );
      const keyboard = buildUsersPageKeyboard(
        "lk_notif_pick",
        users,
        selected,
        page
      );
      await deliver(
        ctx,
        { text, extra: { ...keyboard, parse_mode: "Markdown" } },
        { edit: true }
      );
    } catch (err) {
      logError("lk_notif_pick_prev", err);
    }
  });

  bot.action("lk_notif_pick_next", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin"))
        return;

      const ps = getPickState(ctx.from.id);
      const page = Math.max(0, (ps.page || 0) + 1);
      setPickState(ctx.from.id, { page });

      const st = getComposer(ctx.from.id);
      const users = await loadUsersPage({ page, pageSize: 20 });
      const selected = st.pickIds || [];

      const text = buildUsersPageText(
        "Выбрать получателей",
        { page },
        users,
        selected
      );
      const keyboard = buildUsersPageKeyboard(
        "lk_notif_pick",
        users,
        selected,
        page
      );
      await deliver(
        ctx,
        { text, extra: { ...keyboard, parse_mode: "Markdown" } },
        { edit: true }
      );
    } catch (err) {
      logError("lk_notif_pick_next", err);
    }
  });

  bot.action(/^lk_notif_pick_toggle_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin"))
        return;

      const userId = Number(ctx.match[1]);
      const st = getComposer(ctx.from.id);
      const selected = new Set(st.pickIds || []);
      if (selected.has(userId)) selected.delete(userId);
      else selected.add(userId);

      setComposer(ctx.from.id, { pickIds: Array.from(selected) });

      const ps = getPickState(ctx.from.id);
      const page = Math.max(0, ps.page || 0);
      const users = await loadUsersPage({ page, pageSize: 20 });

      const text = buildUsersPageText(
        "Выбрать получателей",
        { page },
        users,
        Array.from(selected)
      );
      const keyboard = buildUsersPageKeyboard(
        "lk_notif_pick",
        users,
        Array.from(selected),
        page
      );

      await deliver(
        ctx,
        { text, extra: { ...keyboard, parse_mode: "Markdown" } },
        { edit: true }
      );
    } catch (err) {
      logError("lk_notif_pick_toggle", err);
    }
  });

  bot.action("lk_notif_pick_done", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin"))
        return;

      clearPickState(ctx.from.id);
      await showAdminNewComposer(ctx, admin, { edit: true });
    } catch (err) {
      logError("lk_notif_pick_done", err);
    }
  });

  // --- exclude pagination + toggle
  bot.action("lk_notif_excl_prev", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin"))
        return;

      const ps = getPickState(ctx.from.id);
      const page = Math.max(0, (ps.page || 0) - 1);
      setPickState(ctx.from.id, { page });

      const st = getComposer(ctx.from.id);
      const users = await loadUsersPage({ page, pageSize: 20 });
      const selected = st.excludeIds || [];

      const text = buildUsersPageText(
        "Исключить пользователей",
        { page },
        users,
        selected
      );
      const keyboard = buildUsersPageKeyboard(
        "lk_notif_excl",
        users,
        selected,
        page
      );
      await deliver(
        ctx,
        { text, extra: { ...keyboard, parse_mode: "Markdown" } },
        { edit: true }
      );
    } catch (err) {
      logError("lk_notif_excl_prev", err);
    }
  });

  bot.action("lk_notif_excl_next", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin"))
        return;

      const ps = getPickState(ctx.from.id);
      const page = Math.max(0, (ps.page || 0) + 1);
      setPickState(ctx.from.id, { page });

      const st = getComposer(ctx.from.id);
      const users = await loadUsersPage({ page, pageSize: 20 });
      const selected = st.excludeIds || [];

      const text = buildUsersPageText(
        "Исключить пользователей",
        { page },
        users,
        selected
      );
      const keyboard = buildUsersPageKeyboard(
        "lk_notif_excl",
        users,
        selected,
        page
      );
      await deliver(
        ctx,
        { text, extra: { ...keyboard, parse_mode: "Markdown" } },
        { edit: true }
      );
    } catch (err) {
      logError("lk_notif_excl_next", err);
    }
  });

  bot.action(/^lk_notif_excl_toggle_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin"))
        return;

      const userId = Number(ctx.match[1]);
      const st = getComposer(ctx.from.id);
      const selected = new Set(st.excludeIds || []);
      if (selected.has(userId)) selected.delete(userId);
      else selected.add(userId);

      setComposer(ctx.from.id, { excludeIds: Array.from(selected) });

      const ps = getPickState(ctx.from.id);
      const page = Math.max(0, ps.page || 0);
      const users = await loadUsersPage({ page, pageSize: 20 });

      const text = buildUsersPageText(
        "Исключить пользователей",
        { page },
        users,
        Array.from(selected)
      );
      const keyboard = buildUsersPageKeyboard(
        "lk_notif_excl",
        users,
        Array.from(selected),
        page
      );

      await deliver(
        ctx,
        { text, extra: { ...keyboard, parse_mode: "Markdown" } },
        { edit: true }
      );
    } catch (err) {
      logError("lk_notif_excl_toggle", err);
    }
  });

  bot.action("lk_notif_excl_done", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin"))
        return;

      clearPickState(ctx.from.id);
      await showAdminNewComposer(ctx, admin, { edit: true });
    } catch (err) {
      logError("lk_notif_excl_done", err);
    }
  });

  // ADMIN: history nav + sender filter
  bot.action("lk_notif_admin_hist_prev", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin"))
        return;

      const st = getAdminHistoryState(ctx.from.id);
      setAdminHistoryState(ctx.from.id, {
        page: Math.max(0, (st.page || 0) - 1),
      });
      await showAdminHistory(ctx, { edit: true });
    } catch (err) {
      logError("lk_notif_admin_hist_prev", err);
    }
  });

  bot.action("lk_notif_admin_hist_next", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin"))
        return;

      const st = getAdminHistoryState(ctx.from.id);
      setAdminHistoryState(ctx.from.id, {
        page: Math.max(0, (st.page || 0) + 1),
      });
      await showAdminHistory(ctx, { edit: true });
    } catch (err) {
      logError("lk_notif_admin_hist_next", err);
    }
  });

  bot.action("lk_notif_admin_hist_sender_all", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin"))
        return;

      setAdminHistoryState(ctx.from.id, { page: 0, sender: "all" });
      await showAdminHistory(ctx, { edit: true });
    } catch (err) {
      logError("lk_notif_admin_hist_sender_all", err);
    }
  });

  bot.action(/^lk_notif_admin_hist_sender_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin"))
        return;

      const senderId = Number(ctx.match[1]);
      setAdminHistoryState(ctx.from.id, { page: 0, sender: senderId });
      await showAdminHistory(ctx, { edit: true });
    } catch (err) {
      logError("lk_notif_admin_hist_sender_id", err);
    }
  });

  // ADMIN: text handler (send notification)
  bot.on("text", async (ctx, next) => {
    try {
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin")) {
        return next();
      }

      const tgId = ctx.from.id;
      const st = getComposer(tgId);

      if (st.step !== "await_text") return next();

      const raw = (ctx.message?.text || "").trim();
      if (!raw) return next();

      const text = safeTrim(raw, 3500);

      // resolve recipients
      let recipients = [];
      if ((st.pickIds || []).length > 0) {
        // конкретным пользователям
        const r = await pool.query(
          `
          SELECT id, telegram_id
          FROM users
          WHERE id = ANY($1::int[])
            AND telegram_id IS NOT NULL
          `,
          [st.pickIds]
        );
        recipients = r.rows.map((x) => ({
          id: Number(x.id),
          telegram_id: Number(x.telegram_id),
        }));
      } else {
        recipients = await resolveRecipientsByFilter(st.filter);
      }

      // exclude
      const excl = new Set((st.excludeIds || []).map(Number));
      recipients = recipients.filter((r) => !excl.has(r.id));

      const recipientUserIds = recipients.map((r) => r.id);

      const notificationId = await insertNotificationAndFanout({
        createdBy: admin.id, // админка => пользовательское (как ты уточнил)
        text,
        recipientUserIds,
      });

      // send tg pings (best-effort)
      const pingText =
        "🔔 *Новое уведомление*\n\n" +
        "Откройте раздел: *🔔 Уведомления* в ЛК.";
      for (const r of recipients) {
        if (!r.telegram_id) continue;
        ctx.telegram
          .sendMessage(r.telegram_id, pingText, { parse_mode: "Markdown" })
          .catch(() => {});
      }

      // reset composer
      clearComposer(tgId);
      clearPickState(tgId);

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "📊 Статус последнего",
            "lk_notif_admin_last_status"
          ),
        ],
        [
          Markup.button.callback(
            "📜 История уведомлений",
            "lk_notif_admin_history"
          ),
        ],
        [Markup.button.callback("⬅️ В рассылки", "lk_admin_notifications")],
      ]);

      await ctx.reply(
        `✅ Уведомление отправлено.\nID: ${notificationId}\nПолучателей: ${recipientUserIds.length}`,
        { ...keyboard }
      );
    } catch (err) {
      logError("lk_notif_admin_send_text", err);
      return next();
    }
  });
}

// экспорт для меню (бейдж рядом с 🔔)
async function countUnreadNotifications(userId) {
  return getUnreadCount(userId);
}

module.exports = {
  registerNotifications,
  countUnreadNotifications,
};
