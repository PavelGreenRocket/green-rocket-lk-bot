// src/bot/reports/imports/standard.js
const { Markup } = require("telegraf");

function registerStandardImport(bot, deps) {
  const { pool, ensureUser, isAdmin, toast, deliver, getSt, setSt, logError } =
    deps;

  const PAGE = 10;

  // ---------- utils ----------
  const moneyFmt = (v) => new Intl.NumberFormat("ru-RU").format(Number(v));
  const isFutureDate = (d) => {
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const x = new Date(d);
    x.setHours(0, 0, 0, 0);
    return x.getTime() > today.getTime();
  };

  function parseDateDDMMYYYY(s) {
    const t = String(s || "").trim();
    const m = t.match(/^(\d{2})\.(\d{2})\.(\d{4})$/);
    if (!m) return null;
    const dd = Number(m[1]);
    const mm = Number(m[2]);
    const yy = Number(m[3]);
    const d = new Date(yy, mm - 1, dd);
    if (d.getFullYear() !== yy || d.getMonth() !== mm - 1 || d.getDate() !== dd)
      return null;
    d.setHours(0, 0, 0, 0);
    return d;
  }

  function parseTimeHHMM(s) {
    const t = String(s || "").trim();
    const m = t.match(/^(\d{1,2}):(\d{2})$/);
    if (!m) return null;
    const hh = Number(m[1]);
    const mm = Number(m[2]);
    if (hh < 0 || hh > 23 || mm < 0 || mm > 59) return null;
    return { hh, mm };
  }

  function parseIntStrict(s) {
    const t = String(s || "")
      .trim()
      .replace(/\s+/g, "");
    if (!/^\d+$/.test(t)) return null;
    return Number(t);
  }

  // sales_total can be with 1 decimal
  function parseSalesTotal(s) {
    const t = String(s || "")
      .trim()
      .replace(/\s+/g, "")
      .replace(",", ".");
    if (!/^\d+(\.\d)?$/.test(t)) return null;
    return Number(t);
  }

  function toISODate(d) {
    const yy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${yy}-${mm}-${dd}`;
  }

  function buildCard({ stepNo, stepTotal, tpTitle, dateStr, data, prompt }) {
    const lines = [];
    lines.push(`🛑 ${stepNo}/${stepTotal}`);
    if (tpTitle) lines.push(tpTitle);
    if (dateStr) lines.push(dateStr);

    // show ONLY filled fields (no null / "-" placeholders)
    if (data?.timeFrom && data?.timeTo) {
      lines.push(`Время: ${data.timeFrom}–${data.timeTo}`);
    } else if (data?.timeFrom) {
      lines.push(`Время: ${data.timeFrom}`);
    }

    if (data?.salesTotal != null)
      lines.push(`Сумма продаж: ${moneyFmt(data.salesTotal)}`);
    if (data?.salesCash != null)
      lines.push(`Наличными: ${moneyFmt(data.salesCash)}`);
    if (data?.cashInDrawer != null)
      lines.push(`Наличные в кассе: ${moneyFmt(data.cashInDrawer)}`);

    if (data?.wasCashCollection === false) lines.push(`Инкассация: Нет`);
    if (
      data?.wasCashCollection === true &&
      data?.cashCollectionAmount != null
    ) {
      lines.push(`Инкассация: ${moneyFmt(data.cashCollectionAmount)}`);
      if (data?.cashCollectionByLabel)
        lines.push(`Кто: ${data.cashCollectionByLabel}`);
    }

    if (data?.checksCount != null) lines.push(`Чеков: ${data.checksCount}`);

    if (data?.workerLabel) lines.push(`Сотрудник: ${data.workerLabel}`);

    lines.push("");
    lines.push(prompt);

    return lines.join("\n");
  }

  function baseKb(extraRows = []) {
    return Markup.inlineKeyboard([
      ...extraRows,
      [Markup.button.callback("📝 Изменить", "lk_reports_std_edit_menu")],
      [Markup.button.callback("❌ Отмена", "lk_reports_std_cancel")],
      [Markup.button.callback("⬅️ К отчёту", "lk_reports_import_menu")],
    ]);
  }

  function stGet(ctx) {
    return getSt(ctx.from.id) || {};
  }
  function stPatch(ctx, patch) {
    setSt(ctx.from.id, patch);
  }

  function ensureStdMode(ctx) {
    const st = stGet(ctx);
    return st.importUi?.mode === "standard";
  }

  function getStd(ctx) {
    const st = stGet(ctx);
    return st.importUi?.standard || null;
  }

  function setStd(ctx, standardPatch) {
    const st = stGet(ctx);
    const cur = st.importUi?.standard || {};
    stPatch(ctx, {
      importUi: {
        ...(st.importUi || {}),
        mode: "standard",
        standard: { ...cur, ...standardPatch },
      },
    });
  }

  // ---------- DB helpers ----------
  async function loadTradePointsPage(page) {
    const offset = Math.max(0, page) * PAGE;
    const r = await pool.query(
      `SELECT id, title FROM trade_points ORDER BY title NULLS LAST, id LIMIT $1 OFFSET $2`,
      [PAGE + 1, offset]
    );
    return { rows: r.rows.slice(0, PAGE), hasMore: r.rows.length > PAGE };
  }

  async function findDupShiftId(dateISO, tradePointId) {
    const r = await pool.query(
      `SELECT s.id
       FROM shifts s
       JOIN shift_closings sc ON sc.shift_id = s.id
       WHERE s.status = 'closed'
         AND s.trade_point_id = $1
         AND s.opened_at::date = $2::date
         AND (sc.deleted_at IS NULL OR sc.deleted_at IS NULL) -- best-effort
       ORDER BY s.id DESC
       LIMIT 1`,
      [tradePointId, dateISO]
    );
    return r.rows[0]?.id ?? null;
  }

  async function softDeleteClosing(shiftId) {
    // best-effort: if column doesn't exist, ignore
    try {
      await pool.query(
        `UPDATE shift_closings
         SET deleted_at = NOW()
         WHERE shift_id = $1 AND deleted_at IS NULL`,
        [shiftId]
      );
    } catch (_) {}
  }

  async function insertShiftClosed(d) {
    const opened = d.openedAt;
    const closed = d.closedAt || null;

    const r = await pool.query(
      `INSERT INTO shifts (user_id, trade_point_id, opened_at, closed_at, status)
       VALUES ($1, $2, $3, $4, 'closed')
       RETURNING id`,
      [d.userId, d.tradePointId, opened, closed]
    );
    return r.rows[0].id;
  }

  async function upsertClosing(shiftId, d) {
    // follow pattern from text import (it uses deleted_at IS NULL) :contentReference[oaicite:4]{index=4}
    const upd = await pool.query(
      `UPDATE shift_closings
   SET sales_total = $2,
       sales_cash = $3,
       cash_in_drawer = $4,
       checks_count = $5,
       was_cash_collection = $6,
       cash_collection_amount = $7,
       cash_collection_by_user_id = $8
   WHERE shift_id = $1 AND deleted_at IS NULL`,
      [
        shiftId,
        d.salesTotal,
        d.salesCash,
        d.cashInDrawer,
        d.checksCount,
        d.wasCashCollection,
        d.cashCollectionAmount,
        d.cashCollectionByUserId,
      ]
    );
    if (upd.rowCount > 0) return;

    await pool.query(
      `INSERT INTO shift_closings
        (shift_id, sales_total, sales_cash, cash_in_drawer, checks_count, was_cash_collection, cash_collection_amount, cash_collection_by_user_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        shiftId,
        d.salesTotal,
        d.salesCash,
        d.cashInDrawer,
        d.checksCount,
        d.wasCashCollection,
        d.cashCollectionAmount,
        d.cashCollectionByUserId,
      ]
    );
  }

  async function loadUsersSearch({ page, q }) {
    const offset = Math.max(0, page) * PAGE;
    const s = String(q || "").trim();
    const isId = /^\d+$/.test(s);
    const uname = s.startsWith("@") ? s.slice(1) : s;

    let sql = `SELECT id, full_name, username FROM users`;
    const vals = [];
    const where = [];

    if (s) {
      if (isId) {
        vals.push(Number(s));
        where.push(`id = $${vals.length}`);
      } else if (s.startsWith("@")) {
        vals.push(`%${uname.toLowerCase()}%`);
        where.push(`LOWER(username) LIKE $${vals.length}`);
      } else {
        vals.push(`%${s.toLowerCase()}%`);
        where.push(`LOWER(full_name) LIKE $${vals.length}`);
      }
    }

    if (where.length) sql += ` WHERE ${where.join(" AND ")}`;

    sql += ` ORDER BY full_name NULLS LAST, id LIMIT $${
      vals.length + 1
    } OFFSET $${vals.length + 2}`;
    vals.push(PAGE + 1, offset);

    const r = await pool.query(sql, vals);
    return { rows: r.rows.slice(0, PAGE), hasMore: r.rows.length > PAGE };
  }

  async function loadCashCollectorsPage(tradePointId, page) {
    const offset = Math.max(0, page) * PAGE;

    // Берём назначенных через trade_point_responsibles (event_type=cash_collection_access)
    const r = await pool.query(
      `
      SELECT u.id, u.full_name, u.username
      FROM trade_point_responsibles tpr
      JOIN users u ON u.id = tpr.user_id
      WHERE tpr.trade_point_id = $1
        AND tpr.event_type = 'cash_collection_access'
        AND tpr.is_active = TRUE
      ORDER BY u.full_name NULLS LAST, u.username NULLS LAST, u.id
      LIMIT $2 OFFSET $3
      `,
      [tradePointId, PAGE + 1, offset]
    );

    return { rows: r.rows.slice(0, PAGE), hasMore: r.rows.length > PAGE };
  }

  async function isCashCollectorAllowed(tradePointId, userId) {
    const r = await pool.query(
      `
      SELECT 1
      FROM trade_point_responsibles
      WHERE trade_point_id=$1
        AND event_type='cash_collection_access'
        AND user_id=$2
        AND is_active=TRUE
      LIMIT 1
      `,
      [tradePointId, userId]
    );
    return r.rows.length > 0;
  }

  // ---------- screens ----------
  async function showStep(ctx) {
    const st = getStd(ctx);
    if (!st) return;

    const totalSteps = 6; // UI counter as you used (2/6 etc.). We'll map internal.
    const data = st.data || {};
    const tpTitle = st.tpTitle || null;
    const dateStr = st.dateStr || null;

    const step = st.step;

    // map to your UI 2/6 feel:
    const uiStepNo =
      step === "date"
        ? 1
        : step === "tp"
        ? 1
        : step === "time_from"
        ? 2
        : step === "time_to"
        ? 2
        : step === "sales_total"
        ? 2
        : step === "sales_cash"
        ? 2
        : step === "cash_in_drawer"
        ? 3
        : step === "cash_collection_q"
        ? 4
        : step === "cash_collection_amount"
        ? 4
        : step === "cash_collection_by"
        ? 4
        : step === "checks_count"
        ? 5
        : step === "worker_pick"
        ? 6
        : step === "worker_search_await"
        ? 6
        : step === "dup_confirm"
        ? 1
        : 1;

    if (step === "date") {
      const text = buildCard({
        stepNo: 1,
        stepTotal: totalSteps,
        tpTitle: null,
        dateStr: null,
        data,
        prompt: "Введите дату (DD.MM.YYYY):",
      });
      return deliver(ctx, { text, extra: baseKb([]) }, { edit: true });
    }

    if (step === "tp") {
      const page = st.tpPage || 0;
      const { rows, hasMore } = await loadTradePointsPage(page);

      const buttons = rows.map((r) => [
        Markup.button.callback(
          r.title || `Точка #${r.id}`,
          `lk_reports_std_tp_pick:${r.id}`
        ),
      ]);

      const nav = [];
      if (page > 0)
        nav.push(Markup.button.callback("⬅️", "lk_reports_std_tp_prev"));
      if (hasMore)
        nav.push(Markup.button.callback("➡️", "lk_reports_std_tp_next"));
      if (nav.length) buttons.push(nav);

      const text = buildCard({
        stepNo: 1,
        stepTotal: totalSteps,
        tpTitle: null,
        dateStr,
        data,
        prompt: "Выберите торговую точку:",
      });

      return deliver(
        ctx,
        {
          text,
          extra: Markup.inlineKeyboard([
            ...buttons,
            [Markup.button.callback("📝 Изменить", "lk_reports_std_edit_menu")],
            [Markup.button.callback("❌ Отмена", "lk_reports_std_cancel")],
            [Markup.button.callback("⬅️ К отчёту", "lk_reports_import_menu")],
          ]),
        },
        { edit: true }
      );
    }

    if (step === "dup_confirm") {
      const text = buildCard({
        stepNo: 1,
        stepTotal: totalSteps,
        tpTitle,
        dateStr,
        data,
        prompt: "Отчёт за эту дату и точку уже есть.\nЗаменить?",
      });

      const kb = Markup.inlineKeyboard([
        [Markup.button.callback("♻️ Заменить", "lk_reports_std_dup_replace")],
        [Markup.button.callback("❌ Отмена", "lk_reports_std_cancel")],
        [Markup.button.callback("⬅️ К отчёту", "lk_reports_import_menu")],
      ]);

      return deliver(ctx, { text, extra: kb }, { edit: true });
    }

    if (step === "time_from") {
      const text = buildCard({
        stepNo: 2,
        stepTotal: totalSteps,
        tpTitle,
        dateStr,
        data,
        prompt: "Введите время начала работы (HH:mm) или пропустите:",
      });

      const kb = baseKb([
        [
          Markup.button.callback(
            "⏭ Пропустить",
            "lk_reports_std_time_from_skip"
          ),
        ],
      ]);
      return deliver(ctx, { text, extra: kb }, { edit: true });
    }

    if (step === "time_to") {
      const text = buildCard({
        stepNo: 2,
        stepTotal: totalSteps,
        tpTitle,
        dateStr,
        data,
        prompt: "Введите время окончания работы (HH:mm):",
      });
      return deliver(ctx, { text, extra: baseKb([]) }, { edit: true });
    }

    if (step === "sales_total") {
      const text = buildCard({
        stepNo: 2,
        stepTotal: totalSteps,
        tpTitle,
        dateStr,
        data,
        prompt: "Введите сумму продаж\n\nВведите числом:",
      });
      return deliver(ctx, { text, extra: baseKb([]) }, { edit: true });
    }

    if (step === "sales_cash") {
      const text = buildCard({
        stepNo: 2,
        stepTotal: totalSteps,
        tpTitle,
        dateStr,
        data,
        prompt: "Введите сумму наличных продаж\n\nВведите числом:",
      });
      return deliver(ctx, { text, extra: baseKb([]) }, { edit: true });
    }

    if (step === "cash_in_drawer") {
      const text = buildCard({
        stepNo: 3,
        stepTotal: totalSteps,
        tpTitle,
        dateStr,
        data,
        prompt: "Введите сумму наличных в кассе\n\nВведите числом:",
      });
      return deliver(ctx, { text, extra: baseKb([]) }, { edit: true });
    }

    if (step === "cash_collection_q") {
      const text = buildCard({
        stepNo: 4,
        stepTotal: totalSteps,
        tpTitle,
        dateStr,
        data,
        prompt: "Была ли инкассация?",
      });

      const kb = baseKb([
        [
          Markup.button.callback("✅ Да", "lk_reports_std_cc_yes"),
          Markup.button.callback("❌ Нет", "lk_reports_std_cc_no"),
        ],
      ]);
      return deliver(ctx, { text, extra: kb }, { edit: true });
    }

    if (step === "cash_collection_amount") {
      const text = buildCard({
        stepNo: 4,
        stepTotal: totalSteps,
        tpTitle,
        dateStr,
        data,
        prompt: "Введите сумму инкассации\n\nВведите числом:",
      });
      return deliver(ctx, { text, extra: baseKb([]) }, { edit: true });
    }

    if (step === "cash_collection_by") {
      const page = st.ccByPage || 0;
      const tpId = data.tradePointId;

      // safety: если точка не выбрана — не показываем список
      if (!tpId) {
        const text = buildCard({
          stepNo: 4,
          stepTotal: totalSteps,
          tpTitle,
          dateStr,
          data,
          prompt: "Сначала выберите торговую точку.",
        });
        return deliver(ctx, { text, extra: baseKb([]) }, { edit: true });
      }

      const { rows, hasMore } = await loadCashCollectorsPage(tpId, page);

      const buttons = [
        [Markup.button.callback("🙋 Я", "lk_reports_std_cc_by_me")],
        ...rows.map((u) => [
          Markup.button.callback(
            `${u.full_name || "—"}${u.username ? ` (@${u.username})` : ""}`,
            `lk_reports_std_cc_by_pick:${u.id}`
          ),
        ]),
      ];

      const nav = [];
      if (page > 0)
        nav.push(Markup.button.callback("⬅️", "lk_reports_std_cc_by_prev"));
      if (hasMore)
        nav.push(Markup.button.callback("➡️", "lk_reports_std_cc_by_next"));
      if (nav.length) buttons.push(nav);

      const text = buildCard({
        stepNo: 4,
        stepTotal: totalSteps,
        tpTitle,
        dateStr,
        data,
        prompt: "Кто инкассировал?",
      });

      return deliver(
        ctx,
        {
          text,
          extra: Markup.inlineKeyboard([
            ...buttons,
            [Markup.button.callback("📝 Изменить", "lk_reports_std_edit_menu")],
            [Markup.button.callback("❌ Отмена", "lk_reports_std_cancel")],
            [Markup.button.callback("⬅️ К отчёту", "lk_reports_import_menu")],
          ]),
        },
        { edit: true }
      );
    }

    if (step === "checks_count") {
      const text = buildCard({
        stepNo: 5,
        stepTotal: totalSteps,
        tpTitle,
        dateStr,
        data,
        prompt: "Введите количество чеков\n\nВведите числом:",
      });
      return deliver(ctx, { text, extra: baseKb([]) }, { edit: true });
    }

    if (step === "worker_pick") {
      const q = st.workerSearch || "";
      const page = st.workerPage || 0;
      const { rows, hasMore } = await loadUsersSearch({ page, q });

      const buttons = rows.map((u) => [
        Markup.button.callback(
          `${u.full_name || "—"}${u.username ? ` (@${u.username})` : ""}`,
          `lk_reports_std_worker_pick:${u.id}`
        ),
      ]);

      const nav = [];
      if (page > 0)
        nav.push(Markup.button.callback("⬅️", "lk_reports_std_worker_prev"));
      if (hasMore)
        nav.push(Markup.button.callback("➡️", "lk_reports_std_worker_next"));
      if (nav.length) buttons.push(nav);

      const text = buildCard({
        stepNo: 6,
        stepTotal: totalSteps,
        tpTitle,
        dateStr,
        data,
        prompt:
          "Выберите сотрудника\n\n" +
          "Можно быстро найти: нажмите «🔎 Поиск» и пришлите id/@username/имя",
      });

      return deliver(
        ctx,
        {
          text,
          extra: Markup.inlineKeyboard([
            [
              Markup.button.callback(
                "🔎 Поиск",
                "lk_reports_std_worker_search"
              ),
            ],
            ...buttons,
            ...(nav.length ? [nav] : []),
            [Markup.button.callback("📝 Изменить", "lk_reports_std_edit_menu")],
            [Markup.button.callback("❌ Отмена", "lk_reports_std_cancel")],
            [Markup.button.callback("⬅️ К отчёту", "lk_reports_import_menu")],
          ]),
        },
        { edit: true }
      );
    }

    if (step === "worker_search_await") {
      const text = buildCard({
        stepNo: 6,
        stepTotal: totalSteps,
        tpTitle,
        dateStr,
        data,
        prompt: "Пришлите id / @username / часть имени для поиска:",
      });
      return deliver(ctx, { text, extra: baseKb([]) }, { edit: true });
    }
  }

  // ---------- start ----------
  bot.action("lk_reports_import_standard_start", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      if (!isAdmin(user)) return toast(ctx, "Недоступно.");

      setSt(ctx.from.id, {
        importUi: {
          mode: "standard",
          standard: {
            step: "date",
            resumeStep: "date",
            data: {},
          },
        },
      });
      return showStep(ctx);
    } catch (e) {
      logError("lk_reports_std_start", e);
    }
  });

  // ---------- cancel ----------
  bot.action("lk_reports_std_cancel", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    setSt(ctx.from.id, { importUi: { mode: "menu" } });
    return toast(ctx, "Отменено.");
  });

  // ---------- tp paging ----------
  bot.action("lk_reports_std_tp_prev", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const st = getStd(ctx);
    if (!st) return;
    setStd(ctx, { tpPage: Math.max(0, (st.tpPage || 0) - 1) });
    return showStep(ctx);
  });
  bot.action("lk_reports_std_tp_next", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const st = getStd(ctx);
    if (!st) return;
    setStd(ctx, { tpPage: (st.tpPage || 0) + 1 });
    return showStep(ctx);
  });

  // pick trade point
  bot.action(/^lk_reports_std_tp_pick:(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const st = getStd(ctx);
      if (!st) return;

      const tpId = Number(ctx.match[1]);
      const tp = await pool.query(
        `SELECT id, title FROM trade_points WHERE id=$1`,
        [tpId]
      );
      const tpTitle = tp.rows[0]?.title || `Точка #${tpId}`;

      const data = st.data || {};
      data.tradePointId = tpId;

      setStd(ctx, {
        tpTitle,
        data,
      });

      // after date+tp => check duplicate
      if (data.date && data.tradePointId) {
        const dateISO = toISODate(data.date);
        const dupShiftId = await findDupShiftId(dateISO, data.tradePointId);
        if (dupShiftId) {
          setStd(ctx, {
            dupShiftId,
            step: "dup_confirm",
            resumeStep: st.resumeStep || "tp",
          });
          return showStep(ctx);
        }
      }

      setStd(ctx, { step: "time_from", resumeStep: "time_from" });
      return showStep(ctx);
    } catch (e) {
      logError("lk_reports_std_tp_pick", e);
      return toast(ctx, "Ошибка выбора точки.");
    }
  });

  // duplicate confirm
  bot.action("lk_reports_std_dup_replace", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const st = getStd(ctx);
    if (!st) return;

    // mark that we will replace later at save
    setStd(ctx, {
      allowReplace: true,
      step: "time_from",
      resumeStep: "time_from",
    });
    return showStep(ctx);
  });

  // skip time from
  bot.action("lk_reports_std_time_from_skip", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const st = getStd(ctx);
    if (!st) return;
    const data = st.data || {};
    delete data.timeFrom;
    delete data.timeTo;
    delete data.openedAt;
    delete data.closedAt;
    setStd(ctx, { data, step: "sales_total", resumeStep: "sales_total" });
    return showStep(ctx);
  });

  // cash collection yes/no
  bot.action("lk_reports_std_cc_yes", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const st = getStd(ctx);
    if (!st) return;
    const data = st.data || {};
    data.wasCashCollection = true;
    setStd(ctx, {
      data,
      step: "cash_collection_amount",
      resumeStep: "cash_collection_amount",
    });
    return showStep(ctx);
  });

  bot.action("lk_reports_std_cc_no", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const st = getStd(ctx);
    if (!st) return;
    const data = st.data || {};
    data.wasCashCollection = false;
    data.cashCollectionAmount = null;
    data.cashCollectionByUserId = null;
    data.cashCollectionByLabel = null;
    setStd(ctx, { data, step: "checks_count", resumeStep: "checks_count" });
    return showStep(ctx);
  });

  // cash collection by paging
  bot.action("lk_reports_std_cc_by_prev", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const st = getStd(ctx);
    if (!st) return;
    setStd(ctx, { ccByPage: Math.max(0, (st.ccByPage || 0) - 1) });
    return showStep(ctx);
  });
  bot.action("lk_reports_std_cc_by_next", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const st = getStd(ctx);
    if (!st) return;
    setStd(ctx, { ccByPage: (st.ccByPage || 0) + 1 });
    return showStep(ctx);
  });

  bot.action("lk_reports_std_cc_by_me", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const u = await ensureUser(ctx);
    if (!u) return;
    const st = getStd(ctx);
    if (!st) return;
    const data = st.data || {};
    data.cashCollectionByUserId = u.id;
    data.cashCollectionByLabel = "Я";
    setStd(ctx, { data, step: "checks_count", resumeStep: "checks_count" });
    return showStep(ctx);
  });

  bot.action(/^lk_reports_std_cc_by_pick:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const pickedId = Number(ctx.match[1]);

    const st = getStd(ctx);
    if (!st) return;

    const data = st.data || {};
    const tpId = data.tradePointId;
    if (!tpId) return toast(ctx, "Сначала выберите точку.");

    // защита от ручной подмены callback_data
    const ok = await isCashCollectorAllowed(tpId, pickedId);
    if (!ok) return toast(ctx, "Нет доступа к инкассации для этой точки.");

    const r = await pool.query(
      `SELECT id, full_name, username FROM users WHERE id=$1`,
      [pickedId]
    );
    const row = r.rows[0];
    if (!row) return toast(ctx, "Не найдено.");

    data.cashCollectionByUserId = row.id;
    data.cashCollectionByLabel = row.username
      ? `@${row.username}`
      : row.full_name || `#${row.id}`;

    setStd(ctx, { data, step: "checks_count", resumeStep: "checks_count" });
    return showStep(ctx);
  });

  // worker paging/search
  bot.action("lk_reports_std_worker_prev", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const st = getStd(ctx);
    if (!st) return;
    setStd(ctx, { workerPage: Math.max(0, (st.workerPage || 0) - 1) });
    return showStep(ctx);
  });
  bot.action("lk_reports_std_worker_next", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const st = getStd(ctx);
    if (!st) return;
    setStd(ctx, { workerPage: (st.workerPage || 0) + 1 });
    return showStep(ctx);
  });

  bot.action("lk_reports_std_worker_search", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const st = getStd(ctx);
    if (!st) return;
    setStd(ctx, {
      step: "worker_search_await",
      resumeStep: st.resumeStep || "worker_pick",
    });
    return showStep(ctx);
  });

  bot.action(/^lk_reports_std_worker_pick:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const id = Number(ctx.match[1]);
    const st = getStd(ctx);
    if (!st) return;

    const r = await pool.query(
      `SELECT id, full_name, username FROM users WHERE id=$1`,
      [id]
    );
    const row = r.rows[0];
    if (!row) return toast(ctx, "Не найдено.");

    const data = st.data || {};
    data.userId = row.id;
    data.workerLabel = row.username
      ? `@${row.username}`
      : row.full_name || `#${row.id}`;

    setStd(ctx, { data });

    // FINAL SAVE (full replace if dup exists + allowed)
    try {
      const date = data.date;
      const tpId = data.tradePointId;
      if (!date || !tpId || !data.userId) return toast(ctx, "Не заполнено.");

      // compute opened_at/closed_at
      const openedAt = (() => {
        const base = new Date(date);
        base.setHours(0, 0, 0, 0);
        if (data.timeFrom) {
          const pt = parseTimeHHMM(data.timeFrom);
          base.setHours(pt.hh, pt.mm, 0, 0);
        }
        return base;
      })();
      const closedAt = (() => {
        if (!data.timeFrom || !data.timeTo) return null;
        const base = new Date(date);
        const pt = parseTimeHHMM(data.timeTo);
        base.setHours(pt.hh, pt.mm, 0, 0);
        return base;
      })();

      const payload = {
        userId: data.userId,
        tradePointId: tpId,
        openedAt,
        closedAt,
        salesTotal: data.salesTotal,
        salesCash: data.salesCash,
        cashInDrawer: data.cashInDrawer,
        wasCashCollection: data.wasCashCollection,
        cashCollectionAmount: data.wasCashCollection
          ? data.cashCollectionAmount
          : null,
        cashCollectionByUserId: data.wasCashCollection
          ? data.cashCollectionByUserId
          : null,
        checksCount: data.checksCount,
      };

      if (st.dupShiftId && st.allowReplace) {
        await softDeleteClosing(st.dupShiftId);
      }

      const shiftId = await insertShiftClosed(payload);
      await upsertClosing(shiftId, payload);

      setSt(ctx.from.id, { importUi: { mode: "menu" } });

      return deliver(
        ctx,
        { text: "✅ Отчёт добавлен.", extra: { parse_mode: "HTML" } },
        { edit: false }
      );
    } catch (e) {
      logError("lk_reports_std_save", e);
      return toast(ctx, `Ошибка БД: ${e.message || e}`);
    }
  });

  // ---------- edit menu ----------
  bot.action("lk_reports_std_edit_menu", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const st = getStd(ctx);
    if (!st) return;
    const data = st.data || {};

    const btn = (label, step, enabled = true) =>
      Markup.button.callback(
        (enabled ? "" : "🚫 ") + label,
        enabled ? `lk_reports_std_edit:${step}` : "lk_reports_std_edit_disabled"
      );

    const hasFrom = Boolean(data.timeFrom);

    const kb = Markup.inlineKeyboard([
      [btn("Дата", "date")],
      [btn("Точка", "tp")],
      [btn("Время начала", "time_from")],
      [btn("Время конца", "time_to", hasFrom)],
      [btn("Сумма продаж", "sales_total")],
      [btn("Наличные продажи", "sales_cash")],
      [btn("Наличные в кассе", "cash_in_drawer")],
      [btn("Инкассация (Да/Нет)", "cash_collection_q")],
      [
        btn(
          "Сумма инкассации",
          "cash_collection_amount",
          data.wasCashCollection === true
        ),
      ],
      [
        btn(
          "Кто инкассировал",
          "cash_collection_by",
          data.wasCashCollection === true
        ),
      ],
      [btn("Чеки", "checks_count")],
      [btn("Сотрудник", "worker_pick")],
      [Markup.button.callback("⬅️ Назад", "lk_reports_std_edit_back")],
    ]);

    const text =
      "<b>Что изменить?</b>\n" +
      "После изменения вы вернётесь к текущему шагу заполнения.";

    return deliver(
      ctx,
      { text, extra: { parse_mode: "HTML", ...kb } },
      { edit: true }
    );
  });

  bot.action("lk_reports_std_edit_disabled", async (ctx) => {
    await ctx
      .answerCbQuery("Недоступно на этом этапе.", { show_alert: false })
      .catch(() => {});
  });

  bot.action("lk_reports_std_edit_back", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const st = getStd(ctx);
    if (!st) return;
    setStd(ctx, { step: st.resumeStep || "sales_total" });
    return showStep(ctx);
  });

  bot.action(/^lk_reports_std_edit:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const step = ctx.match[1];
    const st = getStd(ctx);
    if (!st) return;

    // remember where to come back
    setStd(ctx, { editReturn: st.resumeStep || st.step, step });
    return showStep(ctx);
  });

  // ---------- text handler (CRITICAL: must use next!) ----------
  bot.on("text", async (ctx, next) => {
    try {
      const st0 = stGet(ctx);
      if (st0.importUi?.mode !== "standard") return next(); // <- do not swallow other flows

      const user = await ensureUser(ctx);
      if (!user) return;
      if (!isAdmin(user)) return next();

      const st = getStd(ctx);
      if (!st) return next();

      const txt = (ctx.message?.text || "").trim();
      if (!txt) return;

      const data = st.data || {};

      if (st.step === "date") {
        const d = parseDateDDMMYYYY(txt);
        if (!d) return toast(ctx, "Формат даты: DD.MM.YYYY");
        if (isFutureDate(d)) return toast(ctx, "Дата не может быть в будущем.");

        data.date = d;
        setStd(ctx, {
          data,
          dateStr: txt,
          step: "tp",
          resumeStep: "tp",
          tpPage: 0,
        });
        return showStep(ctx);
      }

      if (st.step === "time_from") {
        const t = parseTimeHHMM(txt);
        if (!t) return toast(ctx, "Формат времени: HH:mm");
        data.timeFrom = `${String(t.hh).padStart(2, "0")}:${String(
          t.mm
        ).padStart(2, "0")}`;
        setStd(ctx, { data, step: "time_to", resumeStep: "time_to" });
        return showStep(ctx);
      }

      if (st.step === "time_to") {
        const t = parseTimeHHMM(txt);
        if (!t) return toast(ctx, "Формат времени: HH:mm");
        data.timeTo = `${String(t.hh).padStart(2, "0")}:${String(t.mm).padStart(
          2,
          "0"
        )}`;
        setStd(ctx, { data, step: "sales_total", resumeStep: "sales_total" });
        return showStep(ctx);
      }

      if (st.step === "sales_total") {
        const v = parseSalesTotal(txt);
        if (v == null)
          return toast(
            ctx,
            "Введите число (допускается 1 знак после запятой)."
          );
        data.salesTotal = v;
        setStd(ctx, { data, step: "sales_cash", resumeStep: "sales_cash" });
        return showStep(ctx);
      }

      if (st.step === "sales_cash") {
        const v = parseIntStrict(txt);
        if (v == null) return toast(ctx, "Введите целое число.");
        data.salesCash = v;
        setStd(ctx, {
          data,
          step: "cash_in_drawer",
          resumeStep: "cash_in_drawer",
        });
        return showStep(ctx);
      }

      if (st.step === "cash_in_drawer") {
        const v = parseIntStrict(txt);
        if (v == null) return toast(ctx, "Введите целое число.");
        data.cashInDrawer = v;
        setStd(ctx, {
          data,
          step: "cash_collection_q",
          resumeStep: "cash_collection_q",
        });
        return showStep(ctx);
      }

      if (st.step === "cash_collection_amount") {
        const v = parseIntStrict(txt);
        if (v == null) return toast(ctx, "Введите целое число.");
        data.cashCollectionAmount = v;
        setStd(ctx, {
          data,
          step: "cash_collection_by",
          resumeStep: "cash_collection_by",
          ccByPage: 0,
        });
        return showStep(ctx);
      }

      if (st.step === "checks_count") {
        const v = parseIntStrict(txt);
        if (v == null) return toast(ctx, "Введите целое число.");
        data.checksCount = v;
        setStd(ctx, {
          data,
          step: "worker_pick",
          resumeStep: "worker_pick",
          workerPage: 0,
          workerSearch: "",
        });
        return showStep(ctx);
      }

      if (st.step === "worker_search_await") {
        setStd(ctx, { workerSearch: txt, workerPage: 0, step: "worker_pick" });
        return showStep(ctx);
      }

      return next();
    } catch (e) {
      logError("lk_reports_std_on_text", e);
      return toast(ctx, "Ошибка ввода.");
    }
  });
}

module.exports = { registerStandardImport };
