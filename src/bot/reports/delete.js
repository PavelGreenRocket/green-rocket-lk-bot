// src/bot/reports/delete.js
const { Markup } = require("telegraf");
const pool = require("../../db/pool");
const { deliver } = require("../../utils/renderHelpers");
const { toast } = require("../../utils/toast");
const { getUserState, setUserState, clearUserState } = require("../state");

const MODE = "reports_delete_one";

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

// ───────── formatting (как в edit.js карточке) ─────────
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
function fmtMoneyRub(v) {
  if (v === null || v === undefined) return "-";
  const n = Number(String(v).replace(",", "."));
  if (!Number.isFinite(n)) return "-";
  return `${new Intl.NumberFormat("ru-RU").format(n)} ₽`;
}

function buildCard(row) {
  const lines = [];
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

  lines.push(`<b>Продажи:</b> ${fmtMoneyRub(row.sales_total)}`);
  lines.push(`<b>Наличные:</b> ${fmtMoneyRub(row.sales_cash)}`);
  lines.push(`<b>В кассе:</b> ${fmtMoneyRub(row.cash_in_drawer)}`);

  lines.push("");
  lines.push(`<b>Чеков:</b> ${row.checks_count ?? "-"}`);

  if (row.was_cash_collection === true) {
    lines.push(`<b>Инкассация:</b> ${fmtMoneyRub(row.cash_collection_amount)}`);
  } else if (row.was_cash_collection === false) {
    lines.push(`<b>Инкассация:</b> НЕТ`);
  } else {
    lines.push(`<b>Инкассация:</b> -`);
  }

  lines.push("──────────────");
  return lines.join("\n");
}

// ───────── DB ─────────
async function loadReportByShiftId(shiftId) {
  const r = await pool.query(
    `
    SELECT
      s.id AS shift_id,
      s.user_id,
      s.trade_point_id,
      s.opened_at,
      s.closed_at,
      tp.title AS trade_point_title,

      sc.sales_total,
      sc.sales_cash,
      sc.cash_in_drawer,
      sc.was_cash_collection,
      sc.cash_collection_amount,
      sc.checks_count,

      sc.deleted_at

    FROM shifts s
    JOIN shift_closings sc ON sc.shift_id = s.id
    LEFT JOIN trade_points tp ON tp.id = s.trade_point_id
    WHERE s.id = $1
    `,
    [Number(shiftId)]
  );
  return r.rows[0] || null;
}

async function softDeleteShiftClosing(shiftId, deletedByUserId) {
  // Мягкое удаление: помечаем shift_closings.deleted_at
  // (по репе уже используется deleted_at как “неактуально”)
  await pool.query(
    `
    UPDATE shift_closings
    SET deleted_at = NOW(),
        deleted_by_user_id = $1
    WHERE shift_id = $2
      AND deleted_at IS NULL
    `,
    [Number(deletedByUserId), Number(shiftId)]
  );
}

// ───────── screens ─────────
async function showConfirm(ctx, user, shiftId) {
  const row = await loadReportByShiftId(shiftId);
  if (!row) {
    clrSt(ctx.from.id);
    return toast(ctx, "Смена/отчёт не найдены.");
  }
  if (row.deleted_at) {
    clrSt(ctx.from.id);
    return toast(ctx, "Этот отчёт уже удалён.");
  }

  const text =
    buildCard(row) +
    "\n\n<b>Удалить этот отчёт?</b>\n" +
    "⚠️ Действие пометит отчёт как удалённый (soft delete).";

  const kb = Markup.inlineKeyboard([
    [Markup.button.callback("🗑 Удалить", "lk_reports_delete_one_yes")],
    [Markup.button.callback("❌ Отмена", "lk_reports_delete_one_no")],
  ]);

  return deliver(
    ctx,
    { text, extra: { ...kb, parse_mode: "HTML" } },
    { edit: true }
  );
}

// ───────── register ─────────
function registerReportDelete(bot, deps) {
  const { ensureUser, logError, showReportsList } = deps;

  // /delete_123 (админская команда из "Подробно")
  bot.hears(/^\/delete_(\d+)$/i, async (ctx) => {
    try {
      const user = await ensureUser(ctx);
      if (!user) return;

      if (!isAdmin(user)) return toast(ctx, "Команда доступна только админам.");

      const shiftId = Number(ctx.match[1]);
      clrSt(ctx.from.id);
      setSt(ctx.from.id, { shiftId });

      return showConfirm(ctx, user, shiftId);
    } catch (e) {
      logError("cmd_delete_shift", e);
    }
  });

  bot.action("lk_reports_delete_one_no", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const user = await ensureUser(ctx);
    if (!user) return;

    clrSt(ctx.from.id);
    await toast(ctx, "Отменено.");
    if (typeof showReportsList === "function")
      return showReportsList(ctx, user, { edit: true });
  });

  bot.action("lk_reports_delete_one_yes", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      if (!isAdmin(user)) return toast(ctx, "Недоступно.");

      const st = getSt(ctx.from.id);
      const shiftId = st?.shiftId;
      if (!shiftId) return toast(ctx, "Не выбрана смена.");

      await softDeleteShiftClosing(shiftId, user.id);
      clrSt(ctx.from.id);

      await toast(ctx, "✅ Удалено успешно.");
      if (typeof showReportsList === "function")
        return showReportsList(ctx, user, { edit: true });
    } catch (e) {
      logError("lk_reports_delete_one_yes", e);
    }
  });
}

module.exports = { registerReportDelete };
