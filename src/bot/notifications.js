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

// kind:
// - "user": n.created_by IS NOT NULL
// - "system": n.created_by IS NULL (на будущее)
function isSystemKind(kind) {
  return kind === "system";
}

// --- categories inside "user" notifications
const CAT_UNCOMPLETED = "[[uncompleted_tasks]]";
const CAT_COMPLAINTS = "[[complaints]]";

const CAT_PHOTO_PREFIX = "[[photo:";

function extractPhotoAndClean(rawText) {
  let text = String(rawText || "");

  // photo marker: [[photo:FILE_ID]]
  let photoFileId = null;
  const m = text.match(/\[\[photo:([^\]]+)\]\]/);
  if (m && m[1]) photoFileId = m[1].trim();

  // remove service markers from visible text
  text = text
    .replace(/\[\[photo:[^\]]+\]\]/g, "")
    .replace(CAT_UNCOMPLETED, "")
    .replace(CAT_COMPLAINTS, "");

  // also remove ugly "[complaints]" / "[uncompleted_tasks]" if где-то осталось
  text = text.replace(/\[[a-z_]+\]/gi, "");

  return { text: text.trim(), photoFileId };
}
async function getUnreadAnyAtOffset(userId, offset) {
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
    ORDER BY n.created_at DESC, n.id DESC
    LIMIT 1 OFFSET $2
    `,
    [userId, Math.max(0, Number(offset || 0))]
  );
  return r.rows[0] || null;
}

async function markOneAsRead(userId, notificationId) {
  await pool.query(
    `
    UPDATE user_notifications
    SET is_read = true, read_at = NOW()
    WHERE user_id = $1
      AND notification_id = $2
      AND COALESCE(is_read,false) = false
    `,
    [userId, notificationId]
  );
}

const unreadBrowseState = new Map(); // tgId -> offset (0 = newest unread)

function getUnreadOffset(tgId) {
  return Number(unreadBrowseState.get(tgId) || 0);
}
function setUnreadOffset(tgId, offset) {
  unreadBrowseState.set(tgId, Math.max(0, Number(offset || 0)));
}

function categoryWhereSql(category, params) {
  // category:
  // - "other"
  // - "uncompleted"
  // - "complaints"
  if (category === "uncompleted") {
    params.push(`%${CAT_UNCOMPLETED}%`);
    return `AND n.text LIKE $${params.length}`;
  }
  if (category === "complaints") {
    params.push(`%${CAT_COMPLAINTS}%`);
    return `AND n.text LIKE $${params.length}`;
  }

  // other: everything except our tagged categories
  params.push(`%${CAT_UNCOMPLETED}%`, `%${CAT_COMPLAINTS}%`);
  return `AND n.text NOT LIKE $${params.length - 1} AND n.text NOT LIKE $${
    params.length
  }`;
}

async function hasResponsibility(userId, kind) {
  const r = await pool.query(
    `
    SELECT 1
    FROM responsible_assignments
WHERE user_id = $1
  AND kind = $2
  AND is_active = true
    LIMIT 1
    `,
    [userId, kind]
  );
  return !!r.rows[0];
}

async function getUnreadCountUserCategory(userId, category) {
  const params = [userId, false]; // sys=false => user-kind
  const catWhere = categoryWhereSql(category, params);

  const r = await pool.query(
    `
    SELECT COUNT(*)::int AS cnt
    FROM user_notifications un
    JOIN notifications n ON n.id = un.notification_id
    WHERE un.user_id = $1
      AND COALESCE(un.is_read, false) = false
      AND (CASE WHEN n.created_by IS NULL THEN true ELSE false END) = $2
      ${catWhere}
    `,
    params
  );
  return Number(r.rows[0]?.cnt || 0);
}

// --------------------
// DB queries
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
  const sys = isSystemKind(kind);
  const r = await pool.query(
    `
    SELECT COUNT(*)::int AS cnt
    FROM user_notifications un
    JOIN notifications n ON n.id = un.notification_id
    WHERE un.user_id = $1
      AND COALESCE(un.is_read, false) = false
      AND (CASE WHEN n.created_by IS NULL THEN true ELSE false END) = $2
    `,
    [userId, sys]
  );
  return Number(r.rows[0]?.cnt || 0);
}

async function getLatestUnreadAny(userId) {
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
    ORDER BY n.created_at DESC, n.id DESC
    LIMIT 1
    `,
    [userId]
  );
  return r.rows[0] || null;
}

async function markAllAsReadAny(userId) {
  await pool.query(
    `
    UPDATE user_notifications
    SET is_read = true,
        read_at = NOW()
    WHERE user_id = $1
      AND COALESCE(is_read, false) = false
    `,
    [userId]
  );
}

async function getUserHistoryPage({
  userId,
  kind,
  category,
  page,
  pageSize = 10,
  sender,
}) {
  const sys = isSystemKind(kind);
  const offset = page * pageSize;

  const params = [userId, sys];
  let senderWhere = "";

  // sender filter имеет смысл в "user" истории (админы), но мы позволим и в system (на будущее)
  if (sender !== "all") {
    params.push(Number(sender));
    senderWhere = `AND n.created_by = $${params.length}`;
  }

  let categoryWhere = "";
  if (!sys && kind === "user") {
    // apply only for user-kind
    categoryWhere = categoryWhereSql(category || "other", params);
  }

  params.push(pageSize, offset);

  const r = await pool.query(
    `
    SELECT
      n.id,
      n.text,
      n.created_at,
      n.created_by,
      COALESCE(un.is_read, false) AS is_read,
      u.full_name AS sender_name,
      u.position  AS sender_position
    FROM user_notifications un
    JOIN notifications n ON n.id = un.notification_id
    LEFT JOIN users u ON u.id = n.created_by
    WHERE un.user_id = $1
      AND (CASE WHEN n.created_by IS NULL THEN true ELSE false END) = $2
${senderWhere}
${categoryWhere}
ORDER BY n.created_at DESC, n.id DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
    `,
    params
  );

  return r.rows.map((x) => ({
    id: Number(x.id),
    text: x.text || "",
    created_at: x.created_at,
    created_by: x.created_by,
    is_read: !!x.is_read,
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
// USER history state (filter toggle / sender / page / kind)
// --------------------

const userHistoryState = new Map(); // tgId -> { kind, category, page, sender, filterExpanded }

function getHistState(tgId) {
  return (
    userHistoryState.get(tgId) || {
      kind: "user",
      category: "other", // other|uncompleted|complaints (for kind="user")
      page: 0,
      sender: "all",
      filterExpanded: false,
    }
  );
}
function setHistState(tgId, patch) {
  userHistoryState.set(tgId, { ...getHistState(tgId), ...patch });
}

// --------------------
// USER screens
// --------------------
async function showUserHub(ctx, user, { edit = true } = {}) {
  const tgId = ctx.from.id;

  const unreadTotal = await getUnreadCount(user.id);
  if (unreadTotal <= 0) {
    const text = "🔔 *Уведомления*\n\nСейчас нет новых уведомлений.";
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback("📚 История", "lk_notif_history_menu")],
      [Markup.button.callback("⬅️ В меню", "lk_main_menu")],
    ]);

    await deliver(
      ctx,
      { text, extra: { ...keyboard, parse_mode: "Markdown" } },
      { edit }
    );
    return;
  }

  // clamp offset
  let offset = getUnreadOffset(tgId);
  if (offset > unreadTotal - 1) offset = unreadTotal - 1;
  setUnreadOffset(tgId, offset);

  const n = await getUnreadAnyAtOffset(user.id, offset);
  if (!n) {
    setUnreadOffset(tgId, 0);
    return showUserHub(ctx, user, { edit });
  }

  const { text: cleanBody, photoFileId } = extractPhotoAndClean(n.text);

  let text = "🔔 *Уведомления*\n\n";

  if (n.created_by == null) {
    text += `*Системное уведомление*\n`;
  } else {
    const fromName = n.sender_name || "Неизвестно";
    const fromPos = posLabel(n.sender_position);
    text += `*Пользовательское уведомление*\n`;
    text += `От: ${fromName}, ${fromPos}\n`;
  }

  text += `Дата: ${formatDtRu(n.created_at)}\n`;
  text += `Сообщение: ${offset + 1} / ${unreadTotal}\n\n`;
  text += safeTrim(cleanBody, 3500);

  const leftDisabled = offset <= 0;
  const rightDisabled = offset >= unreadTotal - 1;

  const navRow = [
    Markup.button.callback(
      leftDisabled ? " " : "⬅️",
      leftDisabled ? "noop" : "lk_notif_unread_prev"
    ),
    Markup.button.callback(
      rightDisabled ? " " : "➡️",
      rightDisabled ? "noop" : "lk_notif_unread_next"
    ),
  ];

  const rows = [navRow];

  if (photoFileId) {
    rows.push([
      Markup.button.callback("📷 Посмотреть фото", "lk_notif_unread_photo"),
    ]);
  }

  rows.push([Markup.button.callback("✅ Прочитано", "lk_notif_unread_read")]);
  rows.push([Markup.button.callback("📚 История", "lk_notif_history_menu")]);
  rows.push([Markup.button.callback("⬅️ В меню", "lk_main_menu")]);

  const keyboard = Markup.inlineKeyboard(rows);

  await deliver(
    ctx,
    { text, extra: { ...keyboard, parse_mode: "Markdown" } },
    { edit }
  );
}

async function showHistoryRoot(ctx, user, { edit = true } = {}) {
  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("📜 Пользовательские", "lk_notif_user_menu")],
    [Markup.button.callback("📜 Системные", "lk_notif_hist_system_1")],
    [Markup.button.callback("⬅️ Назад", "lk_notifications")],
  ]);

  await deliver(
    ctx,
    {
      text: "📚 *История уведомлений*\n\nВыбери раздел:",
      extra: { ...keyboard, parse_mode: "Markdown" },
    },
    { edit }
  );
}

function kindTitle(kind) {
  return kind === "system" ? "Системные" : "Пользовательские";
}

function senderLabel(kind, sender, adminsMap) {
  if (sender === "all") return "Все отправители";
  const a = adminsMap.get(Number(sender));
  if (!a) return `id=${sender}`;
  return `${a.full_name}${a.position ? `, ${posLabel(a.position)}` : ""}`;
}

async function showUserCategoryMenu(ctx, user, { edit = true } = {}) {
  const otherCnt = await getUnreadCountUserCategory(user.id, "other");
  const canUncompleted = await hasResponsibility(user.id, "uncompleted_tasks");
  const canComplaints = await hasResponsibility(user.id, "complaints");

  const rows = [
    [
      Markup.button.callback(
        `🗂 Другие (${otherCnt})`,
        "lk_notif_user_cat_other"
      ),
    ],
  ];

  if (canUncompleted) {
    const c = await getUnreadCountUserCategory(user.id, "uncompleted");
    rows.push([
      Markup.button.callback(
        `✅ Невыполненные задачи (${c})`,
        "lk_notif_user_cat_uncompleted"
      ),
    ]);
  }

  if (canComplaints) {
    const c = await getUnreadCountUserCategory(user.id, "complaints");
    rows.push([
      Markup.button.callback(
        `📝 Замечания по смене (${c})`,
        "lk_notif_user_cat_complaints"
      ),
    ]);
  }

  rows.push([Markup.button.callback("⬅️ Назад", "lk_notifications")]);

  await deliver(
    ctx,
    {
      text: "📜 *Пользовательские уведомления*\n\n" + "Выбери категорию:",
      extra: { ...Markup.inlineKeyboard(rows), parse_mode: "Markdown" },
    },
    { edit }
  );
}

async function showUserHistory(ctx, user, { edit = true } = {}) {
  const tgId = ctx.from.id;
  const st = getHistState(tgId);

  const kind = st.kind;
  const page = Math.max(0, Number(st.page || 0));
  const sender = st.sender ?? "all";
  const expanded = !!st.filterExpanded;

  const admins = await getAdminsList(20);
  const adminsMap = new Map(admins.map((a) => [a.id, a]));

  const items = await getUserHistoryPage({
    userId: user.id,
    kind,
    category: st.category || "other",
    page,
    pageSize: 10,
    sender,
  });

  let text =
    `📜 *История — ${kindTitle(kind)}*\n\n` +
    `Фильтр: *${senderLabel(kind, sender, adminsMap)}*\n` +
    `Страница: ${page + 1}\n\n`;

  if (!items.length) {
    text += "_Нет сообщений на этой странице._";
  } else {
    for (const n of items) {
      const newMark = n.is_read ? "" : "🟢 ";
      if (kind === "system") {
        text += `${newMark}*#${n.id}* · ${formatDtRu(n.created_at)}\n`;
        text += `Тип: Системное\n`;
      } else {
        const who = `${n.sender_name || "Неизвестно"}, ${posLabel(
          n.sender_position
        )}`;
        text += `${newMark}*#${n.id}* · ${formatDtRu(n.created_at)}\n`;
        text += `От: ${who}\n`;
      }
      text += `${safeTrim(n.text, 350)}\n\n`;
    }
  }

  // --- keyboard (beautiful/structured)
  const kb = [];

  // nav row
  kb.push([
    Markup.button.callback("⬅️", `lk_notif_hist_${kind}_prev`),
    Markup.button.callback("➡️", `lk_notif_hist_${kind}_next`),
  ]);

  // filter toggle row
  kb.push([
    Markup.button.callback(
      expanded ? "🔎 Фильтр (скрыть)" : "🔎 Фильтр",
      `lk_notif_hist_${kind}_filter_toggle`
    ),
  ]);

  // filter panel (expanded)
  if (expanded) {
    kb.push([
      Markup.button.callback(
        sender === "all" ? "✅ Все отправители" : "Все отправители",
        `lk_notif_hist_${kind}_sender_all`
      ),
    ]);

    // показываем админов кнопками 2 в ряд (до 10, чтобы красиво)
    const btns = admins
      .slice(0, 10)
      .map((a) =>
        Markup.button.callback(
          `${sender === a.id ? "✅ " : ""}${a.full_name}`,
          `lk_notif_hist_${kind}_sender_${a.id}`
        )
      );
    for (let i = 0; i < btns.length; i += 2) kb.push(btns.slice(i, i + 2));
  }

  // back row
  kb.push([Markup.button.callback("⬅️ Назад", "lk_notifications")]);

  const keyboard = Markup.inlineKeyboard(kb);

  await deliver(
    ctx,
    { text, extra: { ...keyboard, parse_mode: "Markdown" } },
    { edit }
  );
}

// --------------------
// ADMIN COMPOSER (из прошлой версии) — оставляем как было
// --------------------

const adminComposer = new Map();
/**
 * tgId -> {
 *   step: "idle" | "await_text",
 *   filter: "workers" | "workers_interns" | "interns",
 *   excludeIds: number[],
 *   pickIds: number[],
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
  // как ты подтвердил: worker / intern / candidate — верно
  let where = "u.staff_status = 'worker'";
  if (filter === "workers_interns")
    where = "u.staff_status IN ('worker','intern')";
  else if (filter === "interns") where = "u.staff_status = 'intern'";

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

// ADMIN pick/exclude list state
const adminPickState = new Map(); // tgId -> { mode, page }
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
  if (!users.length) return text + "_Пользователей не найдено._\n";
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

// ADMIN: last status + history (как было)
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

const adminHistoryState = new Map(); // tgId -> { page, sender, filterExpanded }
function getAdminHistoryState(tgId) {
  return (
    adminHistoryState.get(tgId) || {
      page: 0,
      sender: "all",
      filterExpanded: false,
    }
  );
}

function setAdminHistoryState(tgId, patch) {
  adminHistoryState.set(tgId, { ...getAdminHistoryState(tgId), ...patch });
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
    id: Number(x.id),
    text: x.text || "",
    created_at: x.created_at,
    created_by: x.created_by,
    sender_name: x.sender_name || null,
    sender_position: x.sender_position || null,
  }));
}

async function getAdminHistoryTotalCount(sender) {
  const params = [];
  let where = "";
  if (sender !== "all") {
    params.push(Number(sender));
    where = `WHERE n.created_by = $1`;
  }

  const r = await pool.query(
    `
    SELECT COUNT(*)::int AS cnt
    FROM notifications n
    ${where}
    `,
    params
  );

  return Number(r.rows[0]?.cnt || 0);
}

async function getAdminHistorySummaryPage({ page, pageSize = 10, sender }) {
  const offset = page * pageSize;
  const params = [];
  let where = "";

  if (sender !== "all") {
    params.push(Number(sender));
    where = `WHERE n.created_by = $${params.length}`;
  }

  // pageSize/offset
  params.push(pageSize, offset);

  const r = await pool.query(
    `
    SELECT
      n.id,
      n.created_at,
      n.created_by,
      u.full_name AS sender_name,
      u.position  AS sender_position,
      COUNT(un.user_id)::int AS total_recipients,
      SUM(CASE WHEN COALESCE(un.is_read,false)=false THEN 1 ELSE 0 END)::int AS unread_count
    FROM notifications n
    LEFT JOIN users u ON u.id = n.created_by
    LEFT JOIN user_notifications un ON un.notification_id = n.id
    ${where}
    GROUP BY n.id, n.created_at, n.created_by, u.full_name, u.position
    ORDER BY n.created_at DESC, n.id DESC
    LIMIT $${params.length - 1} OFFSET $${params.length}
    `,
    params
  );

  return r.rows.map((x) => ({
    id: Number(x.id),
    created_at: x.created_at,
    created_by: x.created_by,
    sender_name: x.sender_name || null,
    sender_position: x.sender_position || null,
    total_recipients: Number(x.total_recipients || 0),
    unread_count: Number(x.unread_count || 0),
  }));
}

async function getAdminNotificationDetail(notificationId) {
  const r = await pool.query(
    `
    SELECT
      n.id, n.text, n.created_at, n.created_by,
      u.full_name AS sender_name,
      u.position  AS sender_position
    FROM notifications n
    LEFT JOIN users u ON u.id = n.created_by
    WHERE n.id = $1
    `,
    [notificationId]
  );
  return r.rows[0] || null;
}

async function getAdminUnreadUsers(notificationId, limit = 120) {
  const r = await pool.query(
    `
    SELECT
      u.id,
      u.full_name,
      u.staff_status,
      u.position,
      u.work_phone,
      u.username
    FROM user_notifications un
    JOIN users u ON u.id = un.user_id
    WHERE un.notification_id = $1
      AND COALESCE(un.is_read,false) = false
    ORDER BY u.full_name
    LIMIT $2
    `,
    [notificationId, limit]
  );

  return r.rows.map((u) => ({
    id: Number(u.id),
    full_name: u.full_name || "Без имени",
    staff_status: u.staff_status || "",
    position: u.position || null,
    work_phone: u.work_phone || null,
    username: u.username || null,
  }));
}

async function getAdminRecipientsCounts(notificationId) {
  const r = await pool.query(
    `
    SELECT
      COUNT(*)::int AS total,
      SUM(CASE WHEN COALESCE(is_read,false)=false THEN 1 ELSE 0 END)::int AS unread
    FROM user_notifications
    WHERE notification_id = $1
    `,
    [notificationId]
  );
  return {
    total: Number(r.rows[0]?.total || 0),
    unread: Number(r.rows[0]?.unread || 0),
  };
}

async function showAdminNotificationsRoot(ctx, { edit = true } = {}) {
  const text = "📢 *Уведомления (рассылки)*\n\nВыберите действие:";
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

  if (pickMode)
    text += `Режим получателей: *конкретные пользователи* (${st.pickIds.length})\n`;
  else text += `Фильтр получателей: *${filterLabel(st.filter)}*\n`;

  if (exclCount) text += `Исключено: ${exclCount}\n`;
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
    if (unreadTotal > unreadUsers.length)
      text += `…и ещё ${unreadTotal - unreadUsers.length}\n`;
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

  const items = await getAdminHistorySummaryPage({
    page,
    pageSize: 10,
    sender,
  });
  const admins = await getAdminsList(20);

  const total = await getAdminHistoryTotalCount(sender);
  const pageSize = 10;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  // ТЕКСТ
  let text =
    "📜 *История уведомлений*\n\n" +
    `Фильтр отправителя: *${sender === "all" ? "все" : `id=${sender}`}*\n` +
    `Страница: ${page + 1} / ${totalPages}\n\n` +
    "Выберите уведомление:";

  const kb = [];

  // 1) список уведомлений КНОПКАМИ (10 на страницу)
  if (!items.length) {
    kb.push([Markup.button.callback("— нет уведомлений —", "noop")]);
  } else {
    for (const n of items) {
      const who =
        n.created_by == null ? "Системное" : n.sender_name || "Неизвестно";

      const label =
        `${formatDtRu(n.created_at)} · ${who} ` +
        `(непроч: ${n.unread_count} / всего: ${n.total_recipients})`;

      // Важно: callback открывает детальный экран (он у тебя уже зарегистрирован) :contentReference[oaicite:4]{index=4}
      kb.push([
        Markup.button.callback(
          label.slice(0, 64),
          `lk_notif_admin_hist_open_${n.id}`
        ),
      ]);
    }
  }

  // 2) стрелки (показываем только если есть куда идти)
  const navRow = [];
  if (page > 0)
    navRow.push(Markup.button.callback("⬅️", "lk_notif_admin_hist_prev"));
  if (page < totalPages - 1)
    navRow.push(Markup.button.callback("➡️", "lk_notif_admin_hist_next"));
  if (navRow.length) kb.push(navRow);

  // 3) кнопка фильтра строго под стрелками (как на скрине 1)
  kb.push([
    Markup.button.callback(
      st.filterExpanded ? "🔎 Фильтр (скрыть)" : "🔎 Фильтр",
      "lk_notif_admin_hist_filter_toggle"
    ),
  ]);

  // 4) панель фильтра — ТОЛЬКО если раскрыт
  if (st.filterExpanded) {
    kb.push([
      Markup.button.callback(
        sender === "all" ? "✅ Все отправители" : "Все отправители",
        "lk_notif_admin_hist_sender_all"
      ),
    ]);

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
  }

  // 5) назад
  kb.push([Markup.button.callback("⬅️ Назад", "lk_admin_notifications")]);

  const keyboard = Markup.inlineKeyboard(kb);
  await deliver(
    ctx,
    { text, extra: { ...keyboard, parse_mode: "Markdown" } },
    { edit }
  );
}

async function showAdminHistoryOpen(ctx, notificationId, { edit = true } = {}) {
  const notif = await getAdminNotificationDetail(notificationId);
  if (!notif) {
    await ctx.answerCbQuery("Не найдено").catch(() => {});
    return;
  }

  const counts = await getAdminRecipientsCounts(notificationId);
  const unreadUsers = await getAdminUnreadUsers(notificationId, 120);

  const sender =
    notif.created_by == null
      ? "Системное"
      : `${notif.sender_name || "Неизвестно"}, ${posLabel(
          notif.sender_position
        )}`;

  let text =
    `📄 *Уведомление #${notif.id}*\n\n` +
    `От: *${sender}*\n` +
    `Дата: *${formatDtRu(notif.created_at)}*\n` +
    `Получателей: *${counts.total}*\n` +
    `Не прочитали: *${counts.unread}*\n\n` +
    `📝 Текст:\n${safeTrim(notif.text, 2500)}\n`;

  if (counts.unread > 0) {
    text += "\n👀 *Не прочитали (первые 120):*\n";
    for (const u of unreadUsers) {
      const phone = u.work_phone ? `📞 ${u.work_phone}` : "📞 —";
      const uname = u.username ? `@${u.username}` : "—";
      const pos = u.position ? posLabel(u.position) : "";
      text += `• ${u.full_name}${
        pos ? `, ${pos}` : ""
      } — ${phone} — ${uname}\n`;
    }
    if (counts.unread > unreadUsers.length) {
      text += `…и ещё ${counts.unread - unreadUsers.length}\n`;
    }
  }

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("⬅️ Назад к истории", "lk_notif_admin_history")],
    [Markup.button.callback("⬅️ В рассылки", "lk_admin_notifications")],
  ]);

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
  bot.action("lk_notif_admin_hist_filter_toggle", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin"))
        return;

      const st = getAdminHistoryState(ctx.from.id);
      setAdminHistoryState(ctx.from.id, { filterExpanded: !st.filterExpanded });

      await showAdminHistory(ctx, { edit: true });
    } catch (err) {
      logError("lk_notif_admin_hist_filter_toggle", err);
    }
  });

  bot.action("lk_notif_history_menu", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      await showHistoryRoot(ctx, user, { edit: true });
    } catch (e) {
      logError?.("lk_notif_history_menu", e);
    }
  });

  bot.action("lk_notif_unread_prev", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      const tgId = ctx.from.id;
      setUnreadOffset(tgId, getUnreadOffset(tgId) - 1);
      await showUserHub(ctx, user, { edit: true });
    } catch (e) {
      logError?.("lk_notif_unread_prev", e);
    }
  });

  bot.action("lk_notif_unread_next", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      const tgId = ctx.from.id;
      setUnreadOffset(tgId, getUnreadOffset(tgId) + 1);
      await showUserHub(ctx, user, { edit: true });
    } catch (e) {
      logError?.("lk_notif_unread_next", e);
    }
  });

  bot.action("lk_notif_unread_read", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const tgId = ctx.from.id;
      const offset = getUnreadOffset(tgId);
      const n = await getUnreadAnyAtOffset(user.id, offset);
      if (n) await markOneAsRead(user.id, Number(n.id));

      // после прочтения — показываем следующее непрочитанное (на том же offset),
      // если его нет — откатимся левее
      const cnt = await getUnreadCount(user.id);
      if (cnt <= 0) setUnreadOffset(tgId, 0);
      else if (offset > cnt - 1) setUnreadOffset(tgId, cnt - 1);

      await showUserHub(ctx, user, { edit: true });
    } catch (e) {
      logError?.("lk_notif_unread_read", e);
    }
  });

  bot.action("lk_notif_unread_photo", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const tgId = ctx.from.id;
      const offset = getUnreadOffset(tgId);
      const n = await getUnreadAnyAtOffset(user.id, offset);
      if (!n) return;

      const { photoFileId } = extractPhotoAndClean(n.text);
      if (!photoFileId) {
        await ctx.reply("Фото не найдено в этом уведомлении.");
        return;
      }

      await ctx
        .replyWithPhoto(photoFileId)
        .catch(() => ctx.reply("Не удалось показать фото."));
    } catch (e) {
      logError?.("lk_notif_unread_photo", e);
    }
  });

  bot.action("lk_notif_user_menu", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      await showUserCategoryMenu(ctx, user, { edit: true });
    } catch (e) {
      logError?.("lk_notif_user_menu", e);
    }
  });

  bot.action(
    "lk_notif_user_cat_other",
    ensureUser(async (ctx, user) => {
      setHistState(ctx.from.id, {
        kind: "user",
        category: "other",
        page: 0,
        sender: "all",
        filterExpanded: false,
      });
      await showUserHistory(ctx, user, { edit: true });
    })
  );

  bot.action(
    "lk_notif_user_cat_uncompleted",
    ensureUser(async (ctx, user) => {
      setHistState(ctx.from.id, {
        kind: "user",
        category: "uncompleted",
        page: 0,
        sender: "all",
        filterExpanded: false,
      });
      await showUserHistory(ctx, user, { edit: true });
    })
  );

  bot.action(
    "lk_notif_user_cat_complaints",
    ensureUser(async (ctx, user) => {
      setHistState(ctx.from.id, {
        kind: "user",
        category: "complaints",
        page: 0,
        sender: "all",
        filterExpanded: false,
      });
      await showUserHistory(ctx, user, { edit: true });
    })
  );

  bot.action(/^lk_notif_admin_hist_open_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin"))
        return;

      const id = Number(ctx.match[1]);
      await showAdminHistoryOpen(ctx, id, { edit: true });
    } catch (err) {
      logError("lk_notif_admin_hist_open", err);
    }
  });

  // USER hub
  bot.action("lk_notifications", async (ctx) => {
    try {
      setUnreadOffset(ctx.from.id, 0);
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      await showUserHub(ctx, user, { edit: true });
    } catch (err) {
      logError("lk_notifications", err);
    }
  });

  // hub -> history
  bot.action("lk_notif_hist_user_1", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      setHistState(ctx.from.id, {
        kind: "user",
        page: 0,
        sender: "all",
        filterExpanded: false,
      });
      await showUserHistory(ctx, user, { edit: true });
    } catch (err) {
      logError("lk_notif_hist_user_1", err);
    }
  });

  bot.action("lk_notif_hist_system_1", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      setHistState(ctx.from.id, {
        kind: "system",
        page: 0,
        sender: "all",
        filterExpanded: false,
      });
      await showUserHistory(ctx, user, { edit: true });
    } catch (err) {
      logError("lk_notif_hist_system_1", err);
    }
  });

  // mark read all (без вкладок — читаем всё)
  bot.action("lk_notif_read_all", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      await markAllAsReadAny(user.id);
      await showUserHub(ctx, user, { edit: true });
    } catch (err) {
      logError("lk_notif_read_all", err);
    }
  });

  // history nav
  bot.action(/^lk_notif_hist_(user|system)_prev$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const kind = ctx.match[1];
      const st = getHistState(ctx.from.id);
      const page = Math.max(0, (st.page || 0) - 1);

      setHistState(ctx.from.id, { kind, page });
      await showUserHistory(ctx, user, { edit: true });
    } catch (err) {
      logError("lk_notif_hist_prev", err);
    }
  });

  bot.action(/^lk_notif_hist_(user|system)_next$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const kind = ctx.match[1];
      const st = getHistState(ctx.from.id);
      const page = Math.max(0, (st.page || 0) + 1);

      setHistState(ctx.from.id, { kind, page });
      await showUserHistory(ctx, user, { edit: true });
    } catch (err) {
      logError("lk_notif_hist_next", err);
    }
  });

  // filter toggle
  bot.action(/^lk_notif_hist_(user|system)_filter_toggle$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const kind = ctx.match[1];
      const st = getHistState(ctx.from.id);

      setHistState(ctx.from.id, { kind, filterExpanded: !st.filterExpanded });
      await showUserHistory(ctx, user, { edit: true });
    } catch (err) {
      logError("lk_notif_hist_filter_toggle", err);
    }
  });

  // sender all
  bot.action(/^lk_notif_hist_(user|system)_sender_all$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const kind = ctx.match[1];
      setHistState(ctx.from.id, { kind, sender: "all", page: 0 });
      await showUserHistory(ctx, user, { edit: true });
    } catch (err) {
      logError("lk_notif_hist_sender_all", err);
    }
  });

  // sender конкретный
  bot.action(/^lk_notif_hist_(user|system)_sender_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const kind = ctx.match[1];
      const senderId = Number(ctx.match[2]);

      setHistState(ctx.from.id, { kind, sender: senderId, page: 0 });
      await showUserHistory(ctx, user, { edit: true });
    } catch (err) {
      logError("lk_notif_hist_sender_id", err);
    }
  });

  // ADMIN ROOT (entry)
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

  // ADMIN: new / cancel / last / history
  bot.action("lk_notif_admin_new", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin"))
        return;

      setComposer(ctx.from.id, {
        step: "await_text",
        filter: "workers",
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

  bot.action("noop", (ctx) => ctx.answerCbQuery().catch(() => {}));

  // ADMIN: pick users / exclude users
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

  // pick pagination + toggle
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

  // exclude pagination + toggle
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

  // ADMIN: history nav + sender filter (как было)
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
      if (!admin || (admin.role !== "admin" && admin.role !== "super_admin"))
        return next();

      const tgId = ctx.from.id;
      const st = getComposer(tgId);
      if (st.step !== "await_text") return next();

      const raw = (ctx.message?.text || "").trim();
      if (!raw) return next();

      const text = safeTrim(raw, 3500);

      let recipients = [];
      if ((st.pickIds || []).length > 0) {
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

      const excl = new Set((st.excludeIds || []).map(Number));
      recipients = recipients.filter((r) => !excl.has(r.id));

      const recipientUserIds = recipients.map((r) => r.id);

      // из админки = пользовательское (created_by = admin.id)
      const notificationId = await insertNotificationAndFanout({
        createdBy: admin.id,
        text,
        recipientUserIds,
      });

      const pingText =
        "🔔 *Новое уведомление*\n\n" +
        "Откройте раздел: *🔔 Уведомления* в ЛК.";
      for (const r of recipients) {
        if (!r.telegram_id) continue;
        ctx.telegram
          .sendMessage(r.telegram_id, pingText, { parse_mode: "Markdown" })
          .catch(() => {});
      }

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
        keyboard
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
  insertNotificationAndFanout,
};
