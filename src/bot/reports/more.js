// src/bot/reports/more.js
const { Markup } = require("telegraf");
const pool = require("../../db/pool");
const { deliver } = require("../../utils/renderHelpers");
const { toast } = require("../../utils/toast");
const { getUserState, setUserState, clearUserState } = require("../state");

const MODE = "reports_more";

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

function fmtDateShort(ts) {
  if (!ts) return "-";
  const d = new Date(ts);
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const yy = String(d.getFullYear()).slice(-2);
  return `${dd}.${mm}.${yy}`;
}
function fmtTime(ts) {
  if (!ts) return "-";
  const d = new Date(ts);
  return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
}
function fmtMoneyRub(v) {
  const n = Number(v);
  if (v == null || Number.isNaN(n)) return "-";
  return `${new Intl.NumberFormat("ru-RU").format(n)} ₽`;
}

function fmtMoneyPlain(v) {
  const n = Number(v);
  if (v == null || Number.isNaN(n)) return "-";
  return new Intl.NumberFormat("ru-RU").format(n);
}

function fmtWorkerLine(u, { admin } = {}) {
  const name = u?.full_name || "—";

  // @username — только админам/суперадминам
  if (admin && u?.username) return `${name} (@${u.username})`;

  // телефон — только админам (на всякий, если появится в row)
  if (admin && u?.work_phone) return `${name} (${u.work_phone})`;

  return name;
}

function diffMarkTight(diff, thresholds) {
  const d = Number(diff);
  if (!Number.isFinite(d)) return "";
  const shortage = Number(thresholds?.shortage ?? 0);
  const surplus = Number(thresholds?.surplus ?? 0);

  // без пробелов — как ты хочешь: (+500➕) / (-1200❗️)
  if (d < 0 && shortage > 0 && Math.abs(d) > shortage) return "❗️";
  if (d > 0 && surplus > 0 && d > surplus) return "➕";
  return "";
}

function fmtParenDelta(diff, thresholds) {
  const d = Number(diff);
  if (!Number.isFinite(d) || d === 0) return "";
  const sign = d > 0 ? "+" : "-";
  const mark = diffMarkTight(d, thresholds);
  return ` (${sign}${fmtMoneyPlain(Math.abs(d))}${mark})`;
}

async function getPrevShiftEndCash(tradePointId, openedAt, excludeShiftId) {
  // касса на конец прошлой закрытой смены на этой точке
  const r = await pool.query(
    `
    SELECT sc.cash_in_drawer
    FROM shifts ps
    JOIN shift_closings sc ON sc.shift_id = ps.id AND sc.deleted_at IS NULL
    WHERE ps.trade_point_id = $1
      AND ps.status = 'closed'::shift_status
      AND ps.closed_at IS NOT NULL
      AND ps.closed_at < $2
      AND ps.id <> $3
    ORDER BY ps.closed_at DESC, ps.id DESC
    LIMIT 1
    `,
    [Number(tradePointId), openedAt, Number(excludeShiftId)]
  );

  return r.rows[0]?.cash_in_drawer ?? null;
}

function calcExpectedCash(row) {
  const opening = Number(row.opening_cash_amount ?? 0);
  const salesCash = Number(row.sales_cash ?? 0);

  const was = row.was_cash_collection === true;
  const cashCollection = was ? Number(row.cash_collection_amount ?? 0) : 0;

  return opening + salesCash - cashCollection;
}

function calcCashDiff(row) {
  const inDrawer = Number(row.cash_in_drawer ?? 0);
  const expected = calcExpectedCash(row);
  const diff = inDrawer - expected; // >0 излишек, <0 недостача
  return { expected, diff };
}

function fmtSignedRub(diff) {
  const n = Number(diff);
  if (!Number.isFinite(n)) return "-";
  const abs = Math.abs(n);
  const sign = n > 0 ? "+" : n < 0 ? "−" : "";
  return `${sign}${new Intl.NumberFormat("ru-RU").format(abs)} ₽`;
}

// пороги берём так же, как в cashDiffAlerts (из последней строки)
async function loadCashDiffThresholds() {
  try {
    const r = await pool.query(`
      SELECT
        shortage_threshold::numeric AS shortage_threshold,
        surplus_threshold::numeric  AS surplus_threshold
      FROM cash_diff_settings
      ORDER BY id DESC
      LIMIT 1
    `);

    const row = r.rows[0] || {};
    return {
      shortage: Number(row.shortage_threshold ?? 0),
      surplus: Number(row.surplus_threshold ?? 0),
    };
  } catch (e) {
    // если таблицы/колонок нет или ещё что-то — просто считаем пороги = 0
    return { shortage: 0, surplus: 0 };
  }
}

function diffMark(diff, thresholds) {
  const d = Number(diff);
  if (!Number.isFinite(d)) return "";
  const shortage = Number(thresholds?.shortage ?? 0);
  const surplus = Number(thresholds?.surplus ?? 0);

  if (d < 0 && Math.abs(d) > shortage && shortage > 0) return " ❗";
  if (d > 0 && d > surplus && surplus > 0) return " ➕";
  return "";
}

function diffDot(diff) {
  const d = Number(diff);
  if (!Number.isFinite(d)) return "⚪";
  if (d < 0) return "🔴";
  if (d > 0) return "🟢";
  return "⚪";
}

// 1 смена -> подробная карточка (как “кассовый подробный” по стилю)
function buildMoreCard(
  row,
  { admin, thresholds, openingDiff, closingDiff, workers }
) {
  const lines = [];

  lines.push(`<b>🔻 Смена:</b> <code>${row.shift_id}</code>`);
  lines.push("");

  const tp = row.trade_point_title || `Точка #${row.trade_point_id}`;
  lines.push(`<b>Точка:</b> ${tp}`);

  // дату смены (открытия) — сюда же, как ты хотел: "Смена: 68 (31.12.2025)"
  const openedDate = row.opened_at ? fmtDateShort(row.opened_at) : "-";
  lines.push(`📅 <b>Дата смены:</b> ${openedDate}`);

  const from = fmtTime(row.opened_at);
  const to = row.closed_at ? fmtTime(row.closed_at) : "-";
  lines.push(`<b>Время:</b> ${from} → ${to}`);
  lines.push("");

  const ws = Array.isArray(workers) ? workers.filter(Boolean) : null;

  if (ws && ws.length > 1) {
    lines.push(`👥 <b>Сотрудники:</b>`);
    for (const w of ws) lines.push(fmtWorkerLine(w, { admin }));
  } else {
    const name = row.full_name || "—";
    const uname = admin && row.username ? ` (@${row.username})` : "";
    lines.push(`👤 <b>Сотрудник:</b> ${name}${uname}`);
  }

  lines.push("──────────────");

  // блок "Начало"
  lines.push(`▶️ <u><b>Начало смены:</b></u>`);
  lines.push(
    `В кассе: ${fmtMoneyRub(row.opening_cash_amount)}${fmtParenDelta(
      openingDiff,
      thresholds
    )}`
  );

  lines.push("");

  // блок "Конец"
  lines.push(`⏹️ <u><b>Конец смены:</b></u>`);
  lines.push(`<b>Продажи:</b> ${fmtMoneyRub(row.sales_total)}`);
  lines.push(`<b>Наличные:</b> ${fmtMoneyRub(row.sales_cash)}`);
  lines.push(
    `<b>В кассе:</b> ${fmtMoneyRub(row.cash_in_drawer)}${fmtParenDelta(
      closingDiff,
      thresholds
    )}`
  );

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

function buildWorkersCard(a, b, { admin, thresholds, prevEndA, prevEndB }) {
  const lines = [];
  lines.push(
    `<b>👥 Подробно по сотрудникам — Смена:</b> <code>${a.shift_id}</code>`
  );
  lines.push("");

  const tp = a.trade_point_title || `Точка #${a.trade_point_id}`;
  lines.push(`<b>Точка:</b> ${tp}`);
  lines.push(
    `<b>📅 Дата смены:</b> ${a.opened_at ? fmtDateShort(a.opened_at) : "-"}`
  );
  lines.push("──────────────");
  lines.push("");

  // Часть 1
  lines.push(`🔻 <b>Часть 1 (до передачи)</b>`);
  {
    const name = a.full_name || "—";
    const uname = admin && a.username ? ` (@${a.username})` : "";
    lines.push(`<b>Сотрудник:</b> ${name}${uname}`);
    lines.push(
      `<b>Время:</b> ${fmtTime(a.opened_at)} → ${fmtTime(a.closed_at)}`
    );
    lines.push("");
    lines.push(`▶️ <u><b>Начало смены:</b></u>`);
    {
      const openingDiffA =
        prevEndA == null
          ? 0
          : Number(a.opening_cash_amount ?? 0) - Number(prevEndA);
      lines.push(
        `В кассе: ${fmtMoneyRub(a.opening_cash_amount)}${fmtParenDelta(
          openingDiffA,
          thresholds
        )}`
      );
    }

    lines.push("");
    lines.push(`⏹️ <u><b>Конец (передача):</b></u>`);
    lines.push(`<b>Продажи:</b> ${fmtMoneyRub(a.sales_total)}`);
    lines.push(`<b>Наличные:</b> ${fmtMoneyRub(a.sales_cash)}`);
    {
      const { diff: closingDiffA } = calcCashDiff(a);
      lines.push(
        `<b>В кассе:</b> ${fmtMoneyRub(a.cash_in_drawer)}${fmtParenDelta(
          closingDiffA,
          thresholds
        )}`
      );
    }

    lines.push("");
    lines.push(`<b>Чеков:</b> ${a.checks_count ?? "-"}`);
    if (a.was_cash_collection === true) {
      lines.push(`<b>Инкассация:</b> ${fmtMoneyRub(a.cash_collection_amount)}`);
    } else if (a.was_cash_collection === false) {
      lines.push(`<b>Инкассация:</b> НЕТ`);
    } else {
      lines.push(`<b>Инкассация:</b> -`);
    }
  }

  lines.push("");
  lines.push("──────────────");
  lines.push("");

  // Часть 2
  lines.push(`🔻 <b>Часть 2 (после передачи)</b>`);
  {
    const name = b.full_name || "—";
    const uname = admin && b.username ? ` (@${b.username})` : "";
    lines.push(`<b>Сотрудник:</b> ${name}${uname}`);
    lines.push(
      `<b>Время:</b> ${fmtTime(b.opened_at)} → ${fmtTime(b.closed_at)}`
    );
    lines.push("");
    lines.push(`▶️ <u><b>Начало смены:</b></u>`);
    {
      const openingDiffB =
        prevEndB == null
          ? 0
          : Number(b.opening_cash_amount ?? 0) - Number(prevEndB);
      lines.push(
        `В кассе: ${fmtMoneyRub(b.opening_cash_amount)}${fmtParenDelta(
          openingDiffB,
          thresholds
        )}`
      );
    }

    lines.push("");
    lines.push(`⏹️ <u><b>Конец смены:</b></u>`);
    lines.push(`<b>Продажи:</b> ${fmtMoneyRub(b.sales_total)}`);
    lines.push(`<b>Наличные:</b> ${fmtMoneyRub(b.sales_cash)}`);
    {
      const { diff: closingDiffB } = calcCashDiff(b);
      lines.push(
        `<b>В кассе:</b> ${fmtMoneyRub(b.cash_in_drawer)}${fmtParenDelta(
          closingDiffB,
          thresholds
        )}`
      );
    }

    lines.push("");
    lines.push(`<b>Чеков:</b> ${b.checks_count ?? "-"}`);
    if (b.was_cash_collection === true) {
      lines.push(`<b>Инкассация:</b> ${fmtMoneyRub(b.cash_collection_amount)}`);
    } else if (b.was_cash_collection === false) {
      lines.push(`<b>Инкассация:</b> НЕТ`);
    } else {
      lines.push(`<b>Инкассация:</b> -`);
    }
  }

  lines.push("");
  lines.push("──────────────");

  return lines.join("\n");
}

async function loadMoreRowByShiftId(shiftId) {
  const r = await pool.query(
    `
    SELECT
      s.id AS shift_id,
      s.user_id,
      s.trade_point_id,
      s.opened_at,
      s.closed_at,
      s.cash_amount AS opening_cash_amount,

      tp.title AS trade_point_title,

      u.full_name,
      u.username,

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
    LEFT JOIN users u ON u.id = s.user_id
    WHERE s.id = $1
    LIMIT 1
    `,
    [Number(shiftId)]
  );
  return r.rows[0] || null;
}

// “есть ли >1 сотрудника в этой смене” — пока заглушка (на будущее под твою передачу смены).
// Чтобы сейчас ничего не ломалось, просто безопасно вернём false.
async function getTransferPair(shiftId) {
  const r = await pool.query(
    `
    SELECT id, from_shift_id, to_shift_id
    FROM shift_transfer_requests
    WHERE status = 'completed'
      AND (from_shift_id = $1 OR to_shift_id = $1)
    ORDER BY id DESC
    LIMIT 1
    `,
    [Number(shiftId)]
  );
  return r.rows[0] || null;
}

async function hasMultipleWorkersSafe(shiftId) {
  const p = await getTransferPair(shiftId);
  return !!p; // если есть completed transfer — значит было минимум 2 сотрудника
}

async function showMore(ctx, user, shiftId) {
  const row = await loadMoreRowByShiftId(shiftId);
  if (!row) {
    clrSt(ctx.from.id);
    return toast(ctx, "Смена/отчёт не найдены.");
  }
  if (row.deleted_at) {
    clrSt(ctx.from.id);
    return toast(ctx, "Этот отчёт удалён.");
  }

  const admin = isAdmin(user);

  const thresholds = await loadCashDiffThresholds();

  // дельта начала = opening_cash - касса на конец прошлой смены
  const prevEnd = await getPrevShiftEndCash(
    row.trade_point_id,
    row.opened_at,
    row.shift_id
  );
  const openingDiff =
    prevEnd == null
      ? 0
      : Number(row.opening_cash_amount ?? 0) - Number(prevEnd);

  // дельта конца = cash_in_drawer - expected_end_cash
  const { diff: closingDiff } = calcCashDiff(row);

  let workers = [{ full_name: row.full_name, username: row.username }];

  const pair = await getTransferPair(shiftId);
  if (pair) {
    const a = await loadMoreRowByShiftId(Number(pair.from_shift_id));
    const b = await loadMoreRowByShiftId(Number(pair.to_shift_id));

    const list = [];
    if (a) list.push({ full_name: a.full_name, username: a.username });
    if (b) list.push({ full_name: b.full_name, username: b.username });

    // уникализируем
    const seen = new Set();
    workers = list.filter((x) => {
      const k = `${x.full_name || ""}|${x.username || ""}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    if (!workers.length)
      workers = [{ full_name: row.full_name, username: row.username }];
  }

  const text = buildMoreCard(row, {
    admin,
    thresholds,
    openingDiff,
    closingDiff,
    workers,
  });

  const buttons = [];

  // Кнопка “подробно по сотрудникам” появится, когда реально будут сегменты/передачи
  const multi = await hasMultipleWorkersSafe(shiftId);
  if (multi) {
    buttons.push([
      Markup.button.callback(
        "👥 Подробно по сотрудникам",
        "lk_reports_more_workers"
      ),
    ]);
  }

  buttons.push([
    Markup.button.callback("⬅️ Назад к отчётам", "lk_reports_format_close"),
  ]);

  const kb = Markup.inlineKeyboard(buttons);

  return deliver(
    ctx,
    { text, extra: { ...kb, parse_mode: "HTML" } },
    { edit: true }
  );
}

function registerReportMore(bot, deps) {
  const { ensureUser, logError } = deps;

  // /more_123 (админская команда из “Подробно”)
  bot.hears(/^\/more_(\d+)$/i, async (ctx) => {
    try {
      const user = await ensureUser(ctx);
      if (!user) return;

      const shiftId = Number(ctx.match[1]);
      clrSt(ctx.from.id);
      setSt(ctx.from.id, { shiftId });

      return showMore(ctx, user, shiftId);
    } catch (e) {
      logError("cmd_more_shift", e);
    }
  });

  bot.action("lk_reports_more_workers", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const st = getSt(ctx.from.id);
      const shiftId = st?.shiftId;
      if (!shiftId)
        return toast(ctx, "Контекст смены потерян. Откройте /more_... заново.");

      const pair = await getTransferPair(shiftId);
      if (!pair) return toast(ctx, "По этой смене не найдено передачи.");

      const aId = Number(pair.from_shift_id);
      const bId = Number(pair.to_shift_id);

      const a = await loadMoreRowByShiftId(aId);
      const b = await loadMoreRowByShiftId(bId);

      if (!a || !b)
        return toast(ctx, "Не удалось загрузить данные по обеим частям смены.");

      const admin = isAdmin(user);

      const thresholds = await loadCashDiffThresholds();

      const prevEndA = await getPrevShiftEndCash(
        a.trade_point_id,
        a.opened_at,
        a.shift_id
      );
      // для части 2 “прошлая касса” = касса передачи (конец части 1)
      const prevEndB = a.cash_in_drawer;

      const text = buildWorkersCard(a, b, {
        admin,
        thresholds,
        prevEndA,
        prevEndB,
      });

      const kb = Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "⬅️ Назад к подробному",
            "lk_reports_more_back"
          ),
        ],
      ]);

      return deliver(
        ctx,
        { text, extra: { ...kb, parse_mode: "HTML" } },
        { edit: true }
      );
    } catch (e) {
      logError("lk_reports_more_workers", e);
    }
  });

  bot.action("lk_reports_more_back", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const st = getSt(ctx.from.id);
      if (!st?.shiftId) return toast(ctx, "Контекст смены потерян.");
      return showMore(ctx, user, st.shiftId);
    } catch (e) {
      logError("lk_reports_more_back", e);
    }
  });
}

module.exports = { registerReportMore };
