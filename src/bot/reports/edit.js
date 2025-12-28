// src/bot/reports/edit.js
const { Markup } = require("telegraf");
const pool = require("../../db/pool");
const { deliver } = require("../../utils/renderHelpers");
const { toast } = require("../../utils/toast");
const { getUserState, setUserState, clearUserState } = require("../state");

const {
  loadCashCollectorsPage,
  isCashCollectorForPoint,
  hasAnyCashCollectors,
} = require("../shifts/cashCollectors");

const MODE = "reports_edit";
const PAGE = 10;

function isAdmin(user) {
  return user?.role === "admin" || user?.role === "super_admin";
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

// ---------- форматирование (без null/пустых) ----------
function fmtMoney(v) {
  if (v === null || v === undefined) return null;
  const n = Number(String(v).replace(",", "."));
  if (!Number.isFinite(n)) return null;
  // показываем без ₽, как в других карточках
  return new Intl.NumberFormat("ru-RU").format(n);
}
function fmtDateShort(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  return `${dd}.${mm}.${yy}`;
}
function fmtTime(ts) {
  if (!ts) return null;
  const d = new Date(ts);
  return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}
function cashByLabel(row) {
  const name = row.cash_collection_by_name || null;
  const uname = row.cash_collection_by_username
    ? `@${row.cash_collection_by_username}`
    : null;
  return name || uname || null;
}

function fmtMoneyRub(v) {
  if (v === null || v === undefined) return "-";
  const n = Number(String(v).replace(",", "."));
  if (!Number.isFinite(n)) return "-";
  return `${new Intl.NumberFormat("ru-RU").format(n)} ₽`;
}

function buildCard(row, { hint, limitedUser }) {
  const lines = [];

  // Заголовок
  lines.push("<b>Отчёт</b>");

  const tp = row.trade_point_title || `Точка #${row.trade_point_id}`;
  lines.push(tp);

  const date = fmtDateShort(row.opened_at);
  if (date) lines.push(`Дата: ${date}`);

  const from = fmtTime(row.opened_at);
  const to = row.closed_at ? fmtTime(row.closed_at) : null;
  if (from && to) lines.push(`Время: ${from}–${to}`);
  else if (from) lines.push(`Время: ${from}`);

  lines.push("");

  // Поля (как кассовый формат)
  if (row.sales_total != null)
    lines.push(`<b>Продажи:</b> ${fmtMoneyRub(row.sales_total)}`);
  if (row.sales_cash != null)
    lines.push(`<b>Наличные:</b> ${fmtMoneyRub(row.sales_cash)}`);
  if (row.cash_in_drawer != null)
    lines.push(`<b>В кассе:</b> ${fmtMoneyRub(row.cash_in_drawer)}`);

  // Чеки / инкассация
  lines.push("");
  if (row.checks_count != null) lines.push(`<b>Чеков:</b> ${row.checks_count}`);

  if (row.was_cash_collection === true) {
    if (row.cash_collection_amount != null) {
      lines.push(
        `<b>Инкассация:</b> ${fmtMoneyRub(row.cash_collection_amount)}`
      );
    } else {
      lines.push(`<b>Инкассация:</b> ДА`);
    }
  } else if (row.was_cash_collection === false) {
    lines.push(`<b>Инкассация:</b> НЕТ`);
  }

  lines.push("──────────────");

  if (limitedUser) {
    lines.push("");
    lines.push("ℹ️ Ты можешь изменить <b>только свою последнюю смену</b>");
    lines.push("(ограниченный список полей).");
  }

  lines.push("");
  lines.push(hint ? hint : "Выберите действие:");

  return lines.join("\n");
}

// ---------- DB helpers ----------
async function loadReportByShiftId(shiftId) {
  // структура совпадает с reports/index.js :contentReference[oaicite:5]{index=5}
  const r = await pool.query(
    `
    SELECT
      s.id AS shift_id,
      s.user_id,
      s.trade_point_id,
      s.opened_at,
      s.closed_at,
      tp.title AS trade_point_title,

      u.full_name,
      u.username,
      u.work_phone,

      sc.sales_total,
      sc.sales_cash,
      sc.cash_in_drawer,
      sc.was_cash_collection,
      sc.cash_collection_amount,
      sc.cash_collection_by_user_id,
      sc.checks_count,

      sc.edited_at,
sc.edited_by_user_id,
eu.full_name AS edited_by_name,
eu.username  AS edited_by_username,
eu.work_phone AS edited_by_work_phone,


      cu.full_name AS cash_collection_by_name,
      cu.username  AS cash_collection_by_username

    FROM shifts s
    JOIN shift_closings sc ON sc.shift_id = s.id
    JOIN users u ON u.id = s.user_id
    LEFT JOIN users cu ON cu.id = sc.cash_collection_by_user_id
    LEFT JOIN users eu ON eu.id = sc.edited_by_user_id
    LEFT JOIN trade_points tp ON tp.id = s.trade_point_id

    WHERE s.id = $1
    `,
    [Number(shiftId)]
  );
  return r.rows[0] || null;
}

async function findLastClosedShiftIdForUser(userId) {
  // берём последнюю закрытую смену (status='closed') — как в отчётах :contentReference[oaicite:6]{index=6}
  // + стараемся брать актуальный closing (deleted_at IS NULL), если поле есть
  try {
    const r = await pool.query(
      `
      SELECT s.id
      FROM shifts s
      JOIN shift_closings sc ON sc.shift_id = s.id
      WHERE s.user_id = $1
        AND s.status = 'closed'
        AND sc.deleted_at IS NULL
      ORDER BY s.closed_at DESC NULLS LAST, s.id DESC
      LIMIT 1
      `,
      [Number(userId)]
    );
    return r.rows[0]?.id ?? null;
  } catch (_) {
    // fallback если миграции deleted_at нет
    const r = await pool.query(
      `
      SELECT s.id
      FROM shifts s
      JOIN shift_closings sc ON sc.shift_id = s.id
      WHERE s.user_id = $1
        AND s.status = 'closed'
      ORDER BY s.closed_at DESC NULLS LAST, s.id DESC
      LIMIT 1
      `,
      [Number(userId)]
    );
    return r.rows[0]?.id ?? null;
  }
}

async function findShiftIdByDatePoint(dateISO, tradePointId) {
  // как в стандарте: closed + точка + opened_at::date :contentReference[oaicite:7]{index=7}
  try {
    const r = await pool.query(
      `
      SELECT s.id
      FROM shifts s
      JOIN shift_closings sc ON sc.shift_id = s.id
      WHERE s.status = 'closed'
        AND s.trade_point_id = $1
        AND s.opened_at::date = $2::date
        AND sc.deleted_at IS NULL
      ORDER BY s.id DESC
      LIMIT 1
      `,
      [Number(tradePointId), dateISO]
    );
    return r.rows[0]?.id ?? null;
  } catch (_) {
    const r = await pool.query(
      `
      SELECT s.id
      FROM shifts s
      JOIN shift_closings sc ON sc.shift_id = s.id
      WHERE s.status = 'closed'
        AND s.trade_point_id = $1
        AND s.opened_at::date = $2::date
      ORDER BY s.id DESC
      LIMIT 1
      `,
      [Number(tradePointId), dateISO]
    );
    return r.rows[0]?.id ?? null;
  }
}

async function loadTradePointsPage(page) {
  // совпадает с reports/index.js :contentReference[oaicite:8]{index=8}
  const offset = Math.max(0, page) * PAGE;
  const r = await pool.query(
    `
    SELECT id, title
    FROM trade_points
    ORDER BY title NULLS LAST, id
    LIMIT $1 OFFSET $2
    `,
    [PAGE + 1, offset]
  );
  return { rows: r.rows.slice(0, PAGE), hasMore: r.rows.length > PAGE };
}

async function loadUsersPage(page) {
  // минимально: список сотрудников для админского выбора "Сотрудник"
  const offset = Math.max(0, page) * PAGE;
  const r = await pool.query(
    `
    SELECT id, full_name, username, work_phone
    FROM users
    ORDER BY full_name NULLS LAST, id
    LIMIT $1 OFFSET $2
    `,
    [PAGE + 1, offset]
  );
  return { rows: r.rows.slice(0, PAGE), hasMore: r.rows.length > PAGE };
}

function parseDateDdMmYyyy(s) {
  const m = String(s || "")
    .trim()
    .match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
  if (!m) return null;
  const dd = Number(m[1]);
  const mm = Number(m[2]);
  const yy = Number(m[3]);
  const d = new Date(yy, mm - 1, dd);
  if (d.getFullYear() !== yy || d.getMonth() !== mm - 1 || d.getDate() !== dd)
    return null;
  return d;
}
function toISODate(d) {
  const yy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}
function isFutureDate(d) {
  const today = new Date();
  const a = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const b = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return b.getTime() > a.getTime();
}
function parseTimeHm(s) {
  const m = String(s || "")
    .trim()
    .match(/^([01]\d|2[0-3]):([0-5]\d)$/);
  if (!m) return null;
  return { hh: Number(m[1]), mm: Number(m[2]) };
}
function applyDateKeepTime(ts, newDate) {
  const cur = ts ? new Date(ts) : new Date();
  const d = new Date(
    newDate.getFullYear(),
    newDate.getMonth(),
    newDate.getDate()
  );
  d.setHours(cur.getHours(), cur.getMinutes(), 0, 0);
  return d;
}
function applyTimeKeepDate(ts, hm) {
  const cur = ts ? new Date(ts) : new Date();
  const d = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate());
  d.setHours(hm.hh, hm.mm, 0, 0);
  return d;
}

// ---------- screens ----------
async function showMain(ctx, user) {
  const st = getSt(ctx.from.id);
  if (!st?.shiftId) return;

  const row = await loadReportByShiftId(st.shiftId);
  if (!row) {
    clrSt(ctx.from.id);
    return toast(ctx, "Отчёт не найден.");
  }

  const limitedUser = !isAdmin(user);

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback("📝 Изменить", "lk_reports_edit_menu")],
    [Markup.button.callback("Готово ✅", "lk_reports_edit_done")],
    [Markup.button.callback("❌ Отмена", "lk_reports_edit_cancel")],
    [Markup.button.callback("⬅️ К отчётам", "lk_reports")],
  ]);

  const text = buildCard(row, { limitedUser });
  return deliver(
    ctx,
    { text, extra: { ...kb, parse_mode: "HTML" } },
    { edit: true }
  );
}

async function showEditMenu(ctx, user) {
  const st = getSt(ctx.from.id);
  if (!st?.shiftId) return;

  const limited = !isAdmin(user);

  const rows = [];

  // общие (и для user, и для admin)
  rows.push([
    Markup.button.callback(
      "Сумма продаж",
      "lk2_reports_edit_field_sales_total"
    ),
  ]);
  rows.push([
    Markup.button.callback(
      "Наличные продажи",
      "lk2_reports_edit_field_sales_cash"
    ),
  ]);
  rows.push([
    Markup.button.callback(
      "Наличные в кассе",
      "lk2_reports_edit_field_cash_in_drawer"
    ),
  ]);
  rows.push([
    Markup.button.callback("Чеков", "lk2_reports_edit_field_checks_count"),
  ]);

  rows.push([
    Markup.button.callback(
      "Инкассация: Да/Нет",
      "lk2_reports_edit_field_cc_flag"
    ),
  ]);
  rows.push([
    Markup.button.callback(
      "Инкассация: сумма",
      "lk2_reports_edit_field_cc_amount"
    ),
  ]);
  rows.push([
    Markup.button.callback("Инкассация: кто", "lk2_reports_edit_field_cc_by"),
  ]);

  if (!limited) {
    // admin-only
    rows.push([Markup.button.callback("Дата", "lk2_reports_edit_field_date")]);
    rows.push([
      Markup.button.callback("Точка", "lk2_reports_edit_field_point"),
    ]);
    rows.push([
      Markup.button.callback(
        "Время начала",
        "lk2_reports_edit_field_time_from"
      ),
    ]);
    rows.push([
      Markup.button.callback(
        "Время окончания",
        "lk2_reports_edit_field_time_to"
      ),
    ]);
    rows.push([
      Markup.button.callback("Сотрудник", "lk2_reports_edit_field_worker"),
    ]);
  }

  rows.push([Markup.button.callback("⬅️ Назад", "lk_reports_edit_back")]);

  const text =
    `<b>Что изменить?</b>\n\n` +
    (limited
      ? "ℹ️ Доступно только для последней смены и только часть полей."
      : "ℹ️ Админ: можно менять любые поля.");

  return deliver(
    ctx,
    { text, extra: { ...Markup.inlineKeyboard(rows), parse_mode: "HTML" } },
    { edit: true }
  );
}

async function showAskText(ctx, user, field, prompt) {
  setSt(ctx.from.id, { step: "await_text", field });
  const st = getSt(ctx.from.id);
  const row = await loadReportByShiftId(st.shiftId);

  const text = buildCard(row, {
    limitedUser: !isAdmin(user),
    hint: `<b>${prompt}</b>`,
  });

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback("⬅️ Назад", "lk_reports_edit_menu")],
    [Markup.button.callback("❌ Отмена", "lk_reports_edit_cancel")],
  ]);

  return deliver(
    ctx,
    { text, extra: { ...kb, parse_mode: "HTML" } },
    { edit: true }
  );
}

async function showPickPoint(ctx) {
  const st = getSt(ctx.from.id);
  const page = Number.isInteger(st.pointPage) ? st.pointPage : 0;
  const { rows, hasMore } = await loadTradePointsPage(page);

  const buttons = rows.map((tp) => [
    Markup.button.callback(
      (tp.title || `Точка #${tp.id}`).slice(0, 64),
      `lk_reports_edit_point_pick_${tp.id}`
    ),
  ]);

  const nav = [];
  if (page > 0)
    nav.push(Markup.button.callback("⬅️", "lk_reports_edit_point_prev"));
  if (hasMore)
    nav.push(Markup.button.callback("➡️", "lk_reports_edit_point_next"));
  if (nav.length) buttons.push(nav);

  buttons.push([Markup.button.callback("⬅️ Назад", "lk_reports_edit_menu")]);

  return deliver(
    ctx,
    {
      text: "<b>Выберите торговую точку</b>",
      extra: { ...Markup.inlineKeyboard(buttons), parse_mode: "HTML" },
    },
    { edit: true }
  );
}

async function showPickWorker(ctx) {
  const st = getSt(ctx.from.id);
  const page = Number.isInteger(st.workerPage) ? st.workerPage : 0;
  const { rows, hasMore } = await loadUsersPage(page);

  const buttons = rows.map((u) => [
    Markup.button.callback(
      `${u.full_name || "—"}${u.username ? ` (@${u.username})` : ""}`.slice(
        0,
        64
      ),
      `lk_reports_edit_worker_pick_${u.id}`
    ),
  ]);

  const nav = [];
  if (page > 0)
    nav.push(Markup.button.callback("⬅️", "lk_reports_edit_worker_prev"));
  if (hasMore)
    nav.push(Markup.button.callback("➡️", "lk_reports_edit_worker_next"));
  if (nav.length) buttons.push(nav);

  buttons.push([Markup.button.callback("⬅️ Назад", "lk_reports_edit_menu")]);

  return deliver(
    ctx,
    {
      text: "<b>Выберите сотрудника</b>",
      extra: { ...Markup.inlineKeyboard(buttons), parse_mode: "HTML" },
    },
    { edit: true }
  );
}

async function showPickCashCollector(ctx, user) {
  const st = getSt(ctx.from.id);
  const row = await loadReportByShiftId(st.shiftId);
  if (!row?.trade_point_id)
    return toast(ctx, "Сначала выберите торговую точку.");

  const page = Number.isInteger(st.ccByPage) ? st.ccByPage : 0;

  let collectors = [];
  let hasMore = false;
  try {
    const r = await loadCashCollectorsPage(
      pool,
      row.trade_point_id,
      page,
      PAGE
    );
    collectors = r.rows;
    hasMore = r.hasMore;
  } catch (_) {
    collectors = [];
    hasMore = false;
  }

  const kbRows = [];

  // "Я" показываем только если:
  // - никто не назначен вообще (fallback), или
  // - текущий пользователь назначен к этой точке
  let showMe = false;
  if (!collectors.length) {
    const any = await hasAnyCashCollectors(pool, row.trade_point_id);
    showMe = !any;
    if (any)
      showMe = await isCashCollectorForPoint(pool, row.trade_point_id, user.id);
  } else {
    showMe = await isCashCollectorForPoint(pool, row.trade_point_id, user.id);
  }
  if (showMe) {
    kbRows.push([Markup.button.callback("🙋 Я", "lk_reports_edit_cc_by_me")]);
  }

  for (const u of collectors) {
    const label = u.full_name || (u.username ? "@" + u.username : `ID ${u.id}`);
    kbRows.push([
      Markup.button.callback(
        label.slice(0, 64),
        `lk_reports_edit_cc_by_pick_${u.id}`
      ),
    ]);
  }

  if (page > 0 || hasMore) {
    kbRows.push([
      ...(page > 0
        ? [Markup.button.callback("⬅️", "lk_reports_edit_cc_by_prev")]
        : []),
      ...(hasMore
        ? [Markup.button.callback("➡️", "lk_reports_edit_cc_by_next")]
        : []),
    ]);
  }

  kbRows.push([Markup.button.callback("⬅️ Назад", "lk_reports_edit_menu")]);

  return deliver(
    ctx,
    {
      text: "<b>Кто инкассировал?</b>",
      extra: { ...Markup.inlineKeyboard(kbRows), parse_mode: "HTML" },
    },
    { edit: true }
  );
}

// ---------- save ----------
async function saveShiftClosing(shiftId, patch, editedByUserId) {
  const fields = [];
  const vals = [];
  let i = 1;

  for (const [k, v] of Object.entries(patch || {})) {
    fields.push(`${k} = $${i}`);
    vals.push(v);
    i += 1;
  }

  // метки редактирования
  fields.push(`edited_at = NOW()`);
  fields.push(`edited_by_user_id = $${i}`);
  vals.push(Number(editedByUserId));
  i += 1;

  vals.push(Number(shiftId));
  await pool.query(
    `UPDATE shift_closings SET ${fields.join(", ")} WHERE shift_id = $${i}`,
    vals
  );
}

async function saveShift(shiftId, patch) {
  const fields = [];
  const vals = [];
  let i = 1;

  for (const [k, v] of Object.entries(patch || {})) {
    fields.push(`${k} = $${i}`);
    vals.push(v);
    i += 1;
  }
  if (!fields.length) return;

  vals.push(Number(shiftId));
  await pool.query(
    `UPDATE shifts SET ${fields.join(", ")} WHERE id = $${i}`,
    vals
  );
}

// ---------- register ----------
function registerReportEdit(bot, deps) {
  const { ensureUser, logError, showReportsList } = deps;

  // Админский быстрый переход из "Подробно": /edit_123
  bot.hears(/^\/edit_(\d+)$/i, async (ctx) => {
    try {
      const user = await ensureUser(ctx);
      if (!user) return;

      if (!isAdmin(user)) {
        return toast(ctx, "Команда доступна только админам.");
      }

      const shiftId = Number(ctx.match[1]);
      const row = await loadReportByShiftId(shiftId);
      if (!row) return toast(ctx, "Смена/отчёт не найдены.");

      clrSt(ctx.from.id);
      setSt(ctx.from.id, { shiftId, step: "main" });
      return showMain(ctx, user);
    } catch (e) {
      logError("cmd_edit_shift", e);
    }
  });

  // entry
  bot.action("lk_reports_edit_last", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      clrSt(ctx.from.id);

      if (!isAdmin(user)) {
        const shiftId = await findLastClosedShiftIdForUser(user.id);
        if (!shiftId)
          return toast(ctx, "Нет закрытых смен для редактирования.");
        setSt(ctx.from.id, { shiftId, step: "main" });
        return showMain(ctx, user);
      }

      // admin flow: start with shift_id input
      setSt(ctx.from.id, { step: "admin_shiftid_await" });
      return deliver(
        ctx,
        {
          text:
            "<b>Редактирование отчёта (админ)</b>\n\n" +
            "Введите <b>ID смены</b> (число).\n" +
            "ℹ️ ID можно посмотреть в <b>Отчёты → 🎛 Формат → ✅Подробно</b>\n\n" +
            "Пример: <code>/edit_12</code>",
          extra: {
            parse_mode: "HTML",
            ...Markup.inlineKeyboard([
              [Markup.button.callback("❌ Отмена", "lk_reports_edit_cancel")],
              [Markup.button.callback("⬅️ К отчётам", "lk_reports")],
            ]),
          },
        },
        { edit: true }
      );
    } catch (e) {
      logError("lk_reports_edit_last", e);
    }
  });

  bot.action("lk_reports_edit_cancel", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    clrSt(ctx.from.id);
    return toast(ctx, "Отменено.");
  });

  bot.action("lk_reports_edit_back", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const user = await ensureUser(ctx);
    if (!user) return;
    return showMain(ctx, user);
  });

  bot.action("lk_reports_edit_menu", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      return showEditMenu(ctx, user);
    } catch (e) {
      logError("lk_reports_edit_menu", e);
    }
  });

  // field buttons
  bot.action("lk2_reports_edit_field_sales_total", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const user = await ensureUser(ctx);
    if (!user) return;
    return showAskText(
      ctx,
      user,
      "sales_total",
      "Введите сумму продаж (можно 1 знак после запятой):"
    );
  });
  bot.action("lk2_reports_edit_field_sales_cash", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const user = await ensureUser(ctx);
    if (!user) return;
    return showAskText(
      ctx,
      user,
      "sales_cash",
      "Введите сумму наличных продаж (целое число):"
    );
  });
  bot.action("lk2_reports_edit_field_cash_in_drawer", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const user = await ensureUser(ctx);
    if (!user) return;
    return showAskText(
      ctx,
      user,
      "cash_in_drawer",
      "Введите наличные в кассе (целое число):"
    );
  });
  bot.action("lk2_reports_edit_field_checks_count", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const user = await ensureUser(ctx);
    if (!user) return;
    return showAskText(
      ctx,
      user,
      "checks_count",
      "Введите количество чеков (целое число):"
    );
  });

  // cash collection yes/no
  bot.action("lk2_reports_edit_field_cc_flag", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const kb = Markup.inlineKeyboard([
      [Markup.button.callback("✅ Да", "lk_reports_edit_cc_yes")],
      [Markup.button.callback("❌ Нет", "lk_reports_edit_cc_no")],
      [Markup.button.callback("⬅️ Назад", "lk_reports_edit_menu")],
    ]);
    return deliver(
      ctx,
      {
        text: "<b>Была ли инкассация?</b>",
        extra: { ...kb, parse_mode: "HTML" },
      },
      { edit: true }
    );
  });

  bot.action("lk_reports_edit_cc_yes", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const user = await ensureUser(ctx);
    if (!user) return;

    await saveShiftClosing(
      st.shiftId,
      {
        was_cash_collection: false,
        cash_collection_amount: null,
        cash_collection_by_user_id: null,
      },
      user.id
    );

    return toast(ctx, "Ок. Теперь укажи сумму и кто.");
  });

  bot.action("lk_reports_edit_cc_no", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const user = await ensureUser(ctx);
    if (!user) return;

    const st = getSt(ctx.from.id);
    if (!st?.shiftId) return;

    await saveShiftClosing(
      st.shiftId,
      {
        was_cash_collection: false,
        cash_collection_amount: null,
        cash_collection_by_user_id: null,
      },
      user.id
    );
    return toast(ctx, "Ок. Инкассация сброшена.");
  });

  bot.action("lk2_reports_edit_field_cc_amount", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const user = await ensureUser(ctx);
    if (!user) return;
    return showAskText(
      ctx,
      user,
      "cash_collection_amount",
      "Введите сумму инкассации (целое число):"
    );
  });

  bot.action("lk2_reports_edit_field_cc_by", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const user = await ensureUser(ctx);
    if (!user) return;
    setSt(ctx.from.id, { step: "pick_cc_by" });
    return showPickCashCollector(ctx, user);
  });

  // cash collector paging/pick
  bot.action("lk2_reports_edit_cc_by_prev", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const st = getSt(ctx.from.id);
    if (!st) return;
    setSt(ctx.from.id, { ccByPage: Math.max(0, (st.ccByPage || 0) - 1) });
    const user = await ensureUser(ctx);
    if (!user) return;
    return showPickCashCollector(ctx, user);
  });
  bot.action("lk2_reports_edit_cc_by_next", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const st = getSt(ctx.from.id);
    if (!st) return;
    setSt(ctx.from.id, { ccByPage: (st.ccByPage || 0) + 1 });
    const user = await ensureUser(ctx);
    if (!user) return;
    return showPickCashCollector(ctx, user);
  });

  bot.action("lk2_reports_edit_cc_by_me", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const user = await ensureUser(ctx);
    if (!user) return;

    const st = getSt(ctx.from.id);
    if (!st?.shiftId) return;

    const row = await loadReportByShiftId(st.shiftId);
    const tpId = row?.trade_point_id;
    if (!tpId) return toast(ctx, "Сначала выберите точку.");

    // fallback разрешаем только если нет назначенных вообще
    const any = await hasAnyCashCollectors(pool, tpId);
    if (any) {
      const ok = await isCashCollectorForPoint(pool, tpId, user.id);
      if (!ok) return toast(ctx, "Нет доступа к инкассации на этой точке.");
    }

    await saveShiftClosing(
      st.shiftId,
      { cash_collection_by_user_id: user.id },
      user.id
    );

    return toast(ctx, "Ок. Установлено: Я");
  });

  bot.action(/^lk_reports_edit_cc_by_pick_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const pickId = Number(ctx.match[1]);
    const user = await ensureUser(ctx);
    if (!user) return;

    const st = getSt(ctx.from.id);
    if (!st?.shiftId) return;

    const row = await loadReportByShiftId(st.shiftId);
    const tpId = row?.trade_point_id;
    if (!tpId) return toast(ctx, "Сначала выберите точку.");

    const ok = await isCashCollectorForPoint(pool, tpId, pickId);
    if (!ok)
      return toast(
        ctx,
        "Этот сотрудник не назначен на инкассацию для этой точки."
      );

    await saveShiftClosing(
      st.shiftId,
      { cash_collection_by_user_id: pickId },
      user.id
    );
    return toast(ctx, "Ок. Инкассатор выбран.");
  });

  // admin-only fields: date/point/time/worker
  bot.action("lk2_reports_edit_field_date", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const user = await ensureUser(ctx);
    if (!user || !isAdmin(user)) return;
    return showAskText(
      ctx,
      user,
      "admin_date_set",
      "Введите новую дату (DD.MM.YYYY):"
    );
  });

  bot.action("lk2_reports_edit_field_point", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const user = await ensureUser(ctx);
    if (!user || !isAdmin(user)) return;
    const st = getSt(ctx.from.id);
    setSt(ctx.from.id, { step: "pick_point", pointPage: st?.pointPage || 0 });
    return showPickPoint(ctx);
  });

  bot.action("lk2_reports_edit_point_prev", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const st = getSt(ctx.from.id);
    if (!st) return;
    setSt(ctx.from.id, { pointPage: Math.max(0, (st.pointPage || 0) - 1) });
    return showPickPoint(ctx);
  });
  bot.action("lk2_reports_edit_point_next", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const st = getSt(ctx.from.id);
    if (!st) return;
    setSt(ctx.from.id, { pointPage: (st.pointPage || 0) + 1 });
    return showPickPoint(ctx);
  });
  bot.action(/^lk_reports_edit_point_pick_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const user = await ensureUser(ctx);
    if (!user || !isAdmin(user)) return;

    const st = getSt(ctx.from.id);
    if (!st?.shiftId) return;

    const tpId = Number(ctx.match[1]);
    await saveShift(st.shiftId, { trade_point_id: tpId });
    return toast(ctx, "Ок. Точка изменена.");
  });

  bot.action("lk2_reports_edit_field_time_from", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const user = await ensureUser(ctx);
    if (!user || !isAdmin(user)) return;
    return showAskText(
      ctx,
      user,
      "admin_time_from",
      "Введите время начала (HH:mm):"
    );
  });
  bot.action("lk2_reports_edit_field_time_to", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const user = await ensureUser(ctx);
    if (!user || !isAdmin(user)) return;
    return showAskText(
      ctx,
      user,
      "admin_time_to",
      "Введите время окончания (HH:mm):"
    );
  });

  bot.action("lk2_reports_edit_field_worker", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const user = await ensureUser(ctx);
    if (!user || !isAdmin(user)) return;
    const st = getSt(ctx.from.id);
    setSt(ctx.from.id, {
      step: "pick_worker",
      workerPage: st?.workerPage || 0,
    });
    return showPickWorker(ctx);
  });

  bot.action("lk2_reports_edit_worker_prev", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const st = getSt(ctx.from.id);
    if (!st) return;
    setSt(ctx.from.id, { workerPage: Math.max(0, (st.workerPage || 0) - 1) });
    return showPickWorker(ctx);
  });
  bot.action("lk2_reports_edit_worker_next", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const st = getSt(ctx.from.id);
    if (!st) return;
    setSt(ctx.from.id, { workerPage: (st.workerPage || 0) + 1 });
    return showPickWorker(ctx);
  });
  bot.action(/^lk_reports_edit_worker_pick_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const user = await ensureUser(ctx);
    if (!user || !isAdmin(user)) return;

    const st = getSt(ctx.from.id);
    if (!st?.shiftId) return;

    const uid = Number(ctx.match[1]);
    await saveShift(st.shiftId, { user_id: uid });
    return toast(ctx, "Ок. Сотрудник изменён.");
  });

  // Done: save & go back to reports list
  bot.action("lk_reports_edit_done", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const st = getSt(ctx.from.id);
      if (!st?.shiftId) return;

      clrSt(ctx.from.id);

      await toast(ctx, "✅ Изменения сохранены.");

      if (typeof showReportsList === "function") {
        return showReportsList(ctx, user, { edit: true });
      }
    } catch (e) {
      logError("lk_reports_edit_done", e);
    }
  });
  // ---------- TEXT middleware (важно: next()) ----------
  bot.on("text", async (ctx, next) => {
    const st = getSt(ctx.from.id);
    if (!st) return next();

    try {
      const user = await ensureUser(ctx);
      if (!user) return;

      // admin first step: date input
      // admin first step: shift_id input
      if (st.step === "admin_shiftid_await") {
        const raw = String(ctx.message.text || "").trim();
        if (!/^\d+$/.test(raw)) return toast(ctx, "Введите числовой ID смены.");

        const shiftId = Number(raw);
        const row = await loadReportByShiftId(shiftId);
        if (!row) return toast(ctx, "Смена/отчёт не найдены.");

        // (опционально) можно добавить проверку, что смена закрыта
        // если хочешь жёстко:
        // if (!row.closed_at) return toast(ctx, "Смена ещё не закрыта.");

        setSt(ctx.from.id, { shiftId, step: "main" });
        return showMain(ctx, user);
      }

      // generic field input
      if (st.step === "await_text") {
        const field = st.field;
        const shiftId = st.shiftId;
        if (!shiftId) {
          clrSt(ctx.from.id);
          return next();
        }

        // reload row for time/date edits
        const row = await loadReportByShiftId(shiftId);

        // permissions
        const limited = !isAdmin(user);
        const denyAdminOnly = [
          "admin_date_set",
          "admin_time_from",
          "admin_time_to",
        ];
        if (limited && denyAdminOnly.includes(field)) {
          return toast(ctx, "Недоступно.");
        }

        const text = String(ctx.message.text || "").trim();

        // sales_total: допускаем 1 знак после запятой
        if (field === "sales_total") {
          const n = Number(text.replace(/\s+/g, "").replace(",", "."));
          if (!Number.isFinite(n)) return toast(ctx, "Введите число.");
          const fixed = Math.round(n * 10) / 10;
          await saveShiftClosing(shiftId, { sales_total: fixed }, user.id);

          return showMain(ctx, user);
        }

        // ints
        if (
          [
            "sales_cash",
            "cash_in_drawer",
            "checks_count",
            "cash_collection_amount",
          ].includes(field)
        ) {
          const n = Number(String(text).replace(/\s+/g, ""));
          if (!Number.isInteger(n) || n < 0)
            return toast(ctx, "Введите целое число.");
          if (field === "cash_collection_amount") {
            // если сумма задана — логично считать, что инкассация была
            await saveShiftClosing(
              shiftId,
              { cash_collection_amount: n, was_cash_collection: true },
              user.id
            );
          } else {
            await saveShiftClosing(shiftId, { [field]: n }, user.id);
          }
          return showMain(ctx, user);
        }

        if (field === "admin_date_set") {
          const d = parseDateDdMmYyyy(text);
          if (!d) return toast(ctx, "Неверный формат. Нужно DD.MM.YYYY");
          if (isFutureDate(d)) return toast(ctx, "Будущие даты запрещены.");
          const openedAt = applyDateKeepTime(row.opened_at, d);
          const closedAt = row.closed_at
            ? applyDateKeepTime(row.closed_at, d)
            : null;
          await saveShift(shiftId, {
            opened_at: openedAt,
            closed_at: closedAt,
          });
          return showMain(ctx, user);
        }

        if (field === "admin_time_from") {
          const hm = parseTimeHm(text);
          if (!hm) return toast(ctx, "Неверный формат. Нужно HH:mm");
          const openedAt = applyTimeKeepDate(row.opened_at, hm);
          await saveShift(shiftId, { opened_at: openedAt });
          return showMain(ctx, user);
        }

        if (field === "admin_time_to") {
          const hm = parseTimeHm(text);
          if (!hm) return toast(ctx, "Неверный формат. Нужно HH:mm");
          const closedAt = applyTimeKeepDate(
            row.closed_at || row.opened_at,
            hm
          );
          await saveShift(shiftId, { closed_at: closedAt });
          return showMain(ctx, user);
        }

        return toast(ctx, "Неизвестное поле.");
      }

      return next();
    } catch (e) {
      logError("reports_edit_text", e);
      return next();
    }
  });

  // admin pick point after date: when point chosen, we should load shift by date+point and jump to main
  bot.action(/^lk_reports_edit_point_pick_(\d+)$/, async (ctx) => {
    // этот handler уже есть выше для "изменить точку"
    // но для admin-старта нам нужно отличать, на каком шаге мы находимся.
    // Поэтому делаем "best-effort": если st.step === admin_point_pick — трактуем как выбор точки для поиска.
    try {
      const st = getSt(ctx.from.id);
      if (st?.step !== "admin_point_pick") return; // пусть обработает другой handler
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || !isAdmin(user)) return;

      const tpId = Number(ctx.match[1]);
      const dateISO = st.adminDate;
      if (!dateISO) return toast(ctx, "Сначала введите дату.");

      const shiftId = await findShiftIdByDatePoint(dateISO, tpId);
      if (!shiftId) return toast(ctx, "Отчёт не найден по этой дате и точке.");

      setSt(ctx.from.id, { shiftId, step: "main" });
      return showMain(ctx, user);
    } catch (e) {
      logError("lk_reports_edit_admin_pick_point", e);
    }
  });
}

module.exports = { registerReportEdit };
