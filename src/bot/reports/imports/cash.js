const { Markup } = require("telegraf");
const poolDefault = require("../../../db/pool");
const { deliver: deliverDefault } = require("../../../utils/renderHelpers");
const {
  enqueuePosImportJob,
  clampRangeToLast31,
} = require("../../integrations/modulpos/importJobs");

function isAdminLocal(user) {
  return user?.role === "admin" || user?.role === "super_admin";
}

function todayLocalDate() {
  const now = new Date();
  // сервер может быть не в RU TZ, но для наших отчётов достаточно "local"
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

function isoDate(d) {
  const dt = d instanceof Date ? d : new Date(d);
  if (!Number.isFinite(dt.getTime())) return null;
  const yyyy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, "0");
  const dd = String(dt.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function fmtDateShort(iso) {
  try {
    const d = new Date(iso);
    if (!Number.isFinite(d.getTime())) return String(iso || "");
    const dd = String(d.getDate()).padStart(2, "0");
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const yy = String(d.getFullYear()).slice(-2);
    return `${dd}.${mm}.${yy}`;
  } catch (_) {
    return String(iso || "");
  }
}

const MONTHS_RU_SHORT = [
  "янв.",
  "фев.",
  "мар.",
  "апр.",
  "май",
  "июн.",
  "июл.",
  "авг.",
  "сен.",
  "окт.",
  "ноя.",
  "дек.",
];

function monthTitle(d) {
  const m = MONTHS_RU_SHORT[d.getMonth()] || "";
  const yy = String(d.getFullYear()).slice(-2);
  return `${m} ${yy}`;
}

function startOfWeek(d) {
  // понедельник
  const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const js = x.getDay(); // 0..6 (Sun..Sat)
  const iso = js === 0 ? 7 : js; // 1..7
  x.setDate(x.getDate() - (iso - 1));
  return x;
}

function endOfWeek(d) {
  const s = startOfWeek(d);
  const e = new Date(s.getFullYear(), s.getMonth(), s.getDate());
  e.setDate(e.getDate() + 6);
  return e;
}

function startOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function endOfMonth(d) {
  return new Date(d.getFullYear(), d.getMonth() + 1, 0);
}

function startOfYear(d) {
  return new Date(d.getFullYear(), 0, 1);
}

function endOfYear(d) {
  return new Date(d.getFullYear(), 11, 31);
}

async function loadTradePoints(pool) {
  const r = await pool.query(
    `SELECT id, title, pos_retail_point_uuid FROM trade_points ORDER BY title NULLS LAST, id`
  );
  return r.rows || [];
}

function registerCashImport(bot, deps) {
  const { ensureUser, toast, logError, getSt, setSt } = deps;
  const isAdmin = typeof deps?.isAdmin === "function" ? deps.isAdmin : isAdminLocal;
  const deliver = typeof deps?.deliver === "function" ? deps.deliver : deliverDefault;
  const pool = deps?.pool || poolDefault;

  function getUi(tgId) {
    const st = (typeof getSt === "function" ? getSt(tgId) : null) || {};
    return st.importCashUi || null;
  }

  function patchUi(tgId, patch) {
    if (typeof setSt === "function") {
      const prev = getUi(tgId) || {};
      setSt(tgId, { importCashUi: { ...prev, ...patch } });
    }
  }

  async function renderMain(ctx) {
    const ui = getUi(ctx.from.id) || {};

    const fromIso = ui.periodFrom || isoDate(todayLocalDate());
    const toIso = ui.periodTo || isoDate(todayLocalDate());

    const fromD = new Date(fromIso);
    const monthCursor = ui.monthCursor ? new Date(ui.monthCursor) : fromD;

    const preset = ui.preset || "today";

    const selectedPoints = Array.isArray(ui.pointIds) ? ui.pointIds : [];

    const text =
      `<b>Импорт из кассы (ModulPOS)</b>\n\n` +
      `Выберите период и точки, затем нажмите «Загрузить выбранный период».\n` +
      `Импорт идемпотентный: повторный запуск не создаст дублей.`;

    const btn = (t, d) => Markup.button.callback(t, d);

    const mm = monthTitle(monthCursor);
    const yy = String(monthCursor.getFullYear()).slice(-2);
    void yy;

    const rowMonth = [btn("←", "imp_cash:month_prev"), btn(mm, "imp_cash:noop"), btn("→", "imp_cash:month_next")];

    const fromParts = fromIso.split("-");
    const toParts = toIso.split("-");
    const rowDates = [
      btn(`${fromParts[2]}.`, "imp_cash:pick_day_open:from"),
      btn(`${fromParts[1]}.`, "imp_cash:pick_month_open:from"),
      btn(String(fromParts[0]).slice(-2), "imp_cash:pick_year_open:from"),
      btn("—", "imp_cash:swap"),
      btn(`${toParts[2]}.`, "imp_cash:pick_day_open:to"),
      btn(`${toParts[1]}.`, "imp_cash:pick_month_open:to"),
      btn(String(toParts[0]).slice(-2), "imp_cash:pick_year_open:to"),
    ];

    const rowPresets = [
      btn(preset === "week" ? "✅ эта неделя" : "эта неделя", "imp_cash:preset_week"),
      btn(preset === "month" ? "✅ месяц" : "месяц", "imp_cash:preset_month"),
      btn(preset === "year" ? "✅ год" : "год", "imp_cash:preset_year"),
    ];
    const rowYesterdayToday = [
      btn(preset === "yesterday" ? "✅ вчера" : "вчера", "imp_cash:preset_yesterday"),
      btn(preset === "today" ? "✅ сегодня" : "сегодня", "imp_cash:preset_today"),
    ];

    const pointsLabel = selectedPoints.length ? `📍 точки (${selectedPoints.length})` : "📍 точки";

    const rowBottom = [
      btn("🔙", "lk_reports_import_menu"),
      btn(pointsLabel, "imp_cash:points_open"),
      btn("⬇️ Загрузить выбранный период", "imp_cash:run"),
    ];

    const kb = Markup.inlineKeyboard([
      rowMonth,
      rowDates,
      rowPresets,
      rowYesterdayToday,
      rowBottom,
    ]);

    return deliver(ctx, { text, extra: { parse_mode: "HTML", ...kb } }, { edit: true });
  }

  function setDatePartSafe(oldIso, { year, month, day }) {
    const old = new Date(oldIso);
    const y = Number.isInteger(year) ? year : old.getFullYear();
    const m = Number.isInteger(month) ? month : old.getMonth();
    const maxDay = new Date(y, m + 1, 0).getDate();
    const d = Number.isInteger(day) ? Math.min(Math.max(1, day), maxDay) : Math.min(old.getDate(), maxDay);
    return isoDate(new Date(y, m, d));
  }

  async function renderDayPicker(ctx, target) {
    const ui = getUi(ctx.from.id) || {};
    const curIso = target === "to" ? ui.periodTo : ui.periodFrom;
    const cur = new Date(curIso || isoDate(todayLocalDate()));
    const cursor = ui.monthCursor ? new Date(ui.monthCursor) : new Date(cur.getFullYear(), cur.getMonth(), 1);

    const first = new Date(cursor.getFullYear(), cursor.getMonth(), 1);
    const daysInMonth = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 0).getDate();
    const jsDow = first.getDay();
    const isoDow = jsDow === 0 ? 7 : jsDow; // 1..7 (пн..вс)
    const pad = isoDow - 1;

    const btn = (t, d) => Markup.button.callback(t, d);
    const header = `<b>Выбор даты (${target === "to" ? "до" : "с"})</b>\n${monthTitle(cursor)}`;

    const rows = [];
    rows.push([btn("←", "imp_cash:month_prev"), btn(monthTitle(cursor), "imp_cash:noop"), btn("→", "imp_cash:month_next")]);

    // сетка 7x6
    const cells = [];
    for (let i = 0; i < pad; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(d);
    while (cells.length % 7 !== 0) cells.push(null);
    while (cells.length < 42) cells.push(null);

    for (let i = 0; i < 42; i += 7) {
      const week = cells.slice(i, i + 7).map((v) => {
        if (!v) return btn(" ", "imp_cash:noop");
        const isSel = v === cur.getDate() && cursor.getMonth() === cur.getMonth() && cursor.getFullYear() === cur.getFullYear();
        const label = isSel ? `✅${String(v).padStart(2, "0")}` : String(v).padStart(2, "0");
        return btn(label, `imp_cash:pick_day:${target}:${v}`);
      });
      rows.push(week);
    }

    rows.push([btn("⬅️ Назад", "imp_cash:picker_back")]);

    return deliver(ctx, { text: header, extra: { ...(Markup.inlineKeyboard(rows) || {}), parse_mode: "HTML" } }, { edit: true });
  }

  async function renderMonthPicker(ctx, target) {
    const ui = getUi(ctx.from.id) || {};
    const curIso = target === "to" ? ui.periodTo : ui.periodFrom;
    const cur = new Date(curIso || isoDate(todayLocalDate()));
    const y = cur.getFullYear();
    const selM = cur.getMonth();

    const btn = (t, d) => Markup.button.callback(t, d);
    const rows = [];
    rows.push([btn(`Год: ${y}`, "imp_cash:noop")]);
    for (let m = 0; m < 12; m += 3) {
      rows.push(
        [0, 1, 2].map((k) => {
          const mi = m + k;
          const label = mi === selM ? `✅ ${MONTHS_RU_SHORT[mi]}` : MONTHS_RU_SHORT[mi];
          return btn(label, `imp_cash:pick_month:${target}:${y}:${String(mi + 1).padStart(2, "0")}`);
        })
      );
    }
    rows.push([btn("⬅️ Назад", "imp_cash:picker_back")]);
    const header = `<b>Выбор месяца (${target === "to" ? "до" : "с"})</b>`;
    return deliver(ctx, { text: header, extra: { ...(Markup.inlineKeyboard(rows) || {}), parse_mode: "HTML" } }, { edit: true });
  }

  async function renderYearPicker(ctx, target) {
    const ui = getUi(ctx.from.id) || {};
    const curIso = target === "to" ? ui.periodTo : ui.periodFrom;
    const cur = new Date(curIso || isoDate(todayLocalDate()));
    const y = cur.getFullYear();
    const years = [y - 1, y, y + 1];

    const btn = (t, d) => Markup.button.callback(t, d);
    const rows = years.map((yr) => [btn(yr === y ? `✅ ${yr}` : String(yr), `imp_cash:pick_year:${target}:${yr}`)]);
    rows.push([btn("⬅️ Назад", "imp_cash:picker_back")]);
    const header = `<b>Выбор года (${target === "to" ? "до" : "с"})</b>`;
    return deliver(ctx, { text: header, extra: { ...(Markup.inlineKeyboard(rows) || {}), parse_mode: "HTML" } }, { edit: true });
  }

  async function renderPoints(ctx) {
    const ui = getUi(ctx.from.id) || {};
    const selected = new Set(Array.isArray(ui.pointIds) ? ui.pointIds : []);

    const points = await loadTradePoints(pool);
    const onlyBound = points.filter((p) => Boolean(p.pos_retail_point_uuid));

    const lines = [];
    lines.push(`<b>Импорт: выбор точек</b>`);
    lines.push("Выберите точки, которые нужно загрузить.");
    lines.push("Если ничего не выбрано — загрузим все точки с привязанной кассой.");

    const buttons = [];
    buttons.push([
      Markup.button.callback("✅ Все с кассой", "imp_cash:points_all"),
      Markup.button.callback("🧹 Сброс", "imp_cash:points_clear"),
    ]);

    for (const p of onlyBound) {
      const mark = selected.has(p.id) ? "✅" : "☑️";
      buttons.push([
        Markup.button.callback(
          `${mark} ${p.title || `Точка #${p.id}`}`,
          `imp_cash:point_toggle:${p.id}`
        ),
      ]);
    }
    buttons.push([Markup.button.callback("⬅️ Назад", "imp_cash:points_back")]);

    return deliver(
      ctx,
      {
        text: lines.join("\n"),
        extra: { ...(Markup.inlineKeyboard(buttons) || {}), parse_mode: "HTML" },
      },
      { edit: true }
    );
  }

  bot.action("lk_reports_import_cash_menu", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      if (!isAdmin(user)) return toast(ctx, "Недоступно.");

      const t = todayLocalDate();
      patchUi(ctx.from.id, {
        mode: "main",
        preset: "today",
        periodFrom: isoDate(t),
        periodTo: isoDate(t),
        monthCursor: isoDate(new Date(t.getFullYear(), t.getMonth(), 1)),
      });

      return renderMain(ctx);
    } catch (e) {
      logError("lk_reports_import_cash_menu", e);
    }
  });

  bot.action("imp_cash:noop", async (ctx) => ctx.answerCbQuery().catch(() => {}));

  bot.action("imp_cash:month_prev", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const ui = getUi(ctx.from.id) || {};
      const cur = ui.monthCursor ? new Date(ui.monthCursor) : todayLocalDate();
      const d = new Date(cur.getFullYear(), cur.getMonth() - 1, 1);
      patchUi(ctx.from.id, { monthCursor: isoDate(d) });
      const ui2 = getUi(ctx.from.id) || {};
      if (ui2.mode === "pick_day" && ui2.pickerTarget) return renderDayPicker(ctx, ui2.pickerTarget);
      return renderMain(ctx);
    } catch (e) {
      logError("imp_cash:month_prev", e);
    }
  });

  bot.action("imp_cash:month_next", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const ui = getUi(ctx.from.id) || {};
      const cur = ui.monthCursor ? new Date(ui.monthCursor) : todayLocalDate();
      const d = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
      patchUi(ctx.from.id, { monthCursor: isoDate(d) });
      const ui2 = getUi(ctx.from.id) || {};
      if (ui2.mode === "pick_day" && ui2.pickerTarget) return renderDayPicker(ctx, ui2.pickerTarget);
      return renderMain(ctx);
    } catch (e) {
      logError("imp_cash:month_next", e);
    }
  });

  // пресеты
  async function setPreset(ctx, presetKey) {
    const base = todayLocalDate();
    let from = base;
    let to = base;
    if (presetKey === "today") {
      from = base;
      to = base;
    } else if (presetKey === "yesterday") {
      const y = new Date(base.getFullYear(), base.getMonth(), base.getDate() - 1);
      from = y;
      to = y;
    } else if (presetKey === "week") {
      from = startOfWeek(base);
      to = endOfWeek(base);
    } else if (presetKey === "month") {
      from = startOfMonth(base);
      to = endOfMonth(base);
    } else if (presetKey === "year") {
      from = startOfYear(base);
      to = endOfYear(base);
    }
    patchUi(ctx.from.id, {
      preset: presetKey,
      periodFrom: isoDate(from),
      periodTo: isoDate(to),
      monthCursor: isoDate(new Date(from.getFullYear(), from.getMonth(), 1)),
    });
    return renderMain(ctx);
  }

  bot.action("imp_cash:preset_today", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    return setPreset(ctx, "today");
  });
  bot.action("imp_cash:preset_yesterday", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    return setPreset(ctx, "yesterday");
  });
  bot.action("imp_cash:preset_week", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    return setPreset(ctx, "week");
  });
  bot.action("imp_cash:preset_month", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    return setPreset(ctx, "month");
  });
  bot.action("imp_cash:preset_year", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    return setPreset(ctx, "year");
  });

  // минимально: swap (в дальнейшем можно сделать выбор дня через таблицу)
  bot.action("imp_cash:swap", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const ui = getUi(ctx.from.id) || {};
      patchUi(ctx.from.id, { periodFrom: ui.periodTo, periodTo: ui.periodFrom, preset: "custom" });
      return renderMain(ctx);
    } catch (e) {
      logError("imp_cash:swap", e);
    }
  });

  bot.action(/^imp_cash:pick_day_open:(from|to)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const target = ctx.match[1];
      patchUi(ctx.from.id, { mode: "pick_day", pickerTarget: target });
      return renderDayPicker(ctx, target);
    } catch (e) {
      logError("imp_cash:pick_day_open", e);
    }
  });

  bot.action(/^imp_cash:pick_month_open:(from|to)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const target = ctx.match[1];
      patchUi(ctx.from.id, { mode: "pick_month", pickerTarget: target });
      return renderMonthPicker(ctx, target);
    } catch (e) {
      logError("imp_cash:pick_month_open", e);
    }
  });

  bot.action(/^imp_cash:pick_year_open:(from|to)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const target = ctx.match[1];
      patchUi(ctx.from.id, { mode: "pick_year", pickerTarget: target });
      return renderYearPicker(ctx, target);
    } catch (e) {
      logError("imp_cash:pick_year_open", e);
    }
  });

  bot.action("imp_cash:picker_back", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    patchUi(ctx.from.id, { mode: "main", pickerTarget: null });
    return renderMain(ctx);
  });

  bot.action(/^imp_cash:pick_day:(from|to):(\d{2})$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const target = ctx.match[1];
      const dd = Number(ctx.match[2]);
      const ui = getUi(ctx.from.id) || {};
      const cursor = ui.monthCursor ? new Date(ui.monthCursor) : todayLocalDate();
      const d = new Date(cursor.getFullYear(), cursor.getMonth(), dd);
      const newIso = isoDate(d);
      patchUi(ctx.from.id, {
        preset: "custom",
        ...(target === "to" ? { periodTo: newIso } : { periodFrom: newIso }),
      });
      return renderDayPicker(ctx, target);
    } catch (e) {
      logError("imp_cash:pick_day", e);
    }
  });

  bot.action(/^imp_cash:pick_month:(from|to):(\d{4}):(\d{2})$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const target = ctx.match[1];
      const year = Number(ctx.match[2]);
      const month = Number(ctx.match[3]); // 1..12
      const ui = getUi(ctx.from.id) || {};
      const baseIso = (target === "to" ? ui.periodTo : ui.periodFrom) || isoDate(todayLocalDate());
      const base = new Date(baseIso);
      const d = new Date(year, month - 1, Math.min(base.getDate(), new Date(year, month, 0).getDate()));
      patchUi(ctx.from.id, {
        preset: "custom",
        monthCursor: isoDate(new Date(year, month - 1, 1)),
        ...(target === "to" ? { periodTo: isoDate(d) } : { periodFrom: isoDate(d) }),
      });
      return renderMonthPicker(ctx, target);
    } catch (e) {
      logError("imp_cash:pick_month", e);
    }
  });

  bot.action(/^imp_cash:pick_year:(from|to):(\d{4})$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const target = ctx.match[1];
      const year = Number(ctx.match[2]);
      const ui = getUi(ctx.from.id) || {};
      const baseIso = (target === "to" ? ui.periodTo : ui.periodFrom) || isoDate(todayLocalDate());
      const base = new Date(baseIso);
      const d = new Date(year, base.getMonth(), Math.min(base.getDate(), new Date(year, base.getMonth() + 1, 0).getDate()));
      patchUi(ctx.from.id, {
        preset: "custom",
        monthCursor: isoDate(new Date(year, base.getMonth(), 1)),
        ...(target === "to" ? { periodTo: isoDate(d) } : { periodFrom: isoDate(d) }),
      });
      return renderYearPicker(ctx, target);
    } catch (e) {
      logError("imp_cash:pick_year", e);
    }
  });

  // точки
  bot.action("imp_cash:points_open", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      patchUi(ctx.from.id, { mode: "points" });
      return renderPoints(ctx);
    } catch (e) {
      logError("imp_cash:points_open", e);
    }
  });

  bot.action("imp_cash:points_back", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      patchUi(ctx.from.id, { mode: "main" });
      return renderMain(ctx);
    } catch (e) {
      logError("imp_cash:points_back", e);
    }
  });

  bot.action("imp_cash:points_all", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const points = await loadTradePoints(pool);
      const ids = points.filter((p) => Boolean(p.pos_retail_point_uuid)).map((p) => p.id);
      patchUi(ctx.from.id, { pointIds: ids });
      return renderPoints(ctx);
    } catch (e) {
      logError("imp_cash:points_all", e);
    }
  });

  bot.action("imp_cash:points_clear", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    patchUi(ctx.from.id, { pointIds: [] });
    return renderPoints(ctx);
  });

  bot.action(/^imp_cash:point_toggle:(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const id = Number(ctx.match[1]);
      const ui = getUi(ctx.from.id) || {};
      const set = new Set(Array.isArray(ui.pointIds) ? ui.pointIds : []);
      if (set.has(id)) set.delete(id);
      else set.add(id);
      patchUi(ctx.from.id, { pointIds: [...set] });
      return renderPoints(ctx);
    } catch (e) {
      logError("imp_cash:point_toggle", e);
    }
  });

  // запуск импорта (enqueue)
  bot.action("imp_cash:run", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      if (!isAdmin(user)) return toast(ctx, "Недоступно.");

      const ui = getUi(ctx.from.id) || {};
      const fromIso = ui.periodFrom || isoDate(todayLocalDate());
      const toIso = ui.periodTo || isoDate(todayLocalDate());

      const points = Array.isArray(ui.pointIds) && ui.pointIds.length ? ui.pointIds : null;

      const { fromIso: effFrom, toIso: effTo, truncated } = clampRangeToLast31(fromIso, toIso);

      const human = `${fmtDateShort(effFrom)}—${fmtDateShort(effTo)}`;

      await toast(
        ctx,
        truncated
          ? `Началась загрузка данных за ${human}. (только последние 31 день выбранного периода)`
          : `Началась загрузка данных за ${human}`
      );

      await enqueuePosImportJob({
        requestedByTgId: ctx.from.id,
        periodFrom: fromIso,
        periodTo: toIso,
        tradePointIds: points,
      });

      // UI не блокируем — можно продолжать работать
      await toast(ctx, "Догружаю… можно продолжать работать");
      return renderMain(ctx);
    } catch (e) {
      logError("imp_cash:run", e);
      return toast(ctx, `Ошибка загрузки: ${String(e?.message || e)}`.slice(0, 180));
    }
  });
}

module.exports = { registerCashImport };
