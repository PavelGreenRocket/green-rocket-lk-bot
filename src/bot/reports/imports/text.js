function registerTextImport(bot, deps) {
  const { pool, ensureUser, isAdmin, toast, deliver, getSt, setSt, logError } =
    deps;

  // ловим текст, только когда ждём импорт
  bot.on("text", async (ctx, next) => {
    try {
      const st = getSt(ctx.from.id) || {};
      if (st.importUi?.mode !== "await_text") return next();

      const user = await ensureUser(ctx);
      if (!user) return;
      if (!isAdmin(user)) return;

      const raw = (ctx.message?.text || "").trim();
      if (!raw) return toast(ctx, "Пустое сообщение.");

      const parsed = await parseImportText(raw, { pool });

      // частичный разбор: отделяем ок/ошибки
      const ok = parsed.items.filter((x) => x.ok);
      const bad = parsed.items.filter((x) => !x.ok);

      if (!ok.length && bad.length) {
        const msg =
          `<b>Импорт отклонён</b>\n` +
          `Не удалось распознать ни одной смены.\n\n` +
          `<b>Ошибки:</b>\n` +
          bad
            .slice(0, 20)
            .map((e, i) => `${i + 1}) ${escapeHtml(e.error)}`)
            .join("\n");
        return deliver(
          ctx,
          { text: msg, extra: { parse_mode: "HTML" } },
          { edit: false }
        );
      }

      // проверяем дубли: (date + trade_point_id)
      const dupMap = await findDuplicates(pool, ok);

      const dupCount = dupMap.size;
      setSt(ctx.from.id, {
        importUi: { mode: "confirm_text" },
        importPending: {
          kind: "text",
          items: ok,
          errors: bad,
          dupKeys: [...dupMap.keys()],
          dupMap: [...dupMap.entries()], // сериализуемо
        },
      });

      const summary =
        `<b>Предпросмотр импорта</b>\n` +
        `• Распознано смен: <b>${ok.length}</b>\n` +
        `• Ошибок: <b>${bad.length}</b>\n` +
        `• Дубликатов (дата+точка): <b>${dupCount}</b>\n\n` +
        (bad.length
          ? `<b>Ошибки (первые ${Math.min(10, bad.length)}):</b>\n` +
            bad
              .slice(0, 10)
              .map((e, i) => `${i + 1}) ${escapeHtml(e.error)}`)
              .join("\n") +
            `\n\n`
          : "");

      const kb = [
        [
          {
            text: "✅ Импортировать (пропустить дубли)",
            callback_data: "lk_reports_import_text_confirm:skip",
          },
        ],
        [
          {
            text: "♻️ Импортировать (обновить дубли)",
            callback_data: "lk_reports_import_text_confirm:update",
          },
        ],
        [{ text: "❌ Отмена", callback_data: "lk_reports_import_text_cancel" }],
      ];

      return deliver(
        ctx,
        {
          text: summary,
          extra: { parse_mode: "HTML", reply_markup: { inline_keyboard: kb } },
        },
        { edit: false }
      );
    } catch (e) {
      logError("text_import_on_text", e);
      return toast(ctx, "Ошибка импорта текста.");
    }
  });

  bot.action(/^lk_reports_import_text_confirm:(skip|update)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const mode = ctx.match[1];

      const user = await ensureUser(ctx);
      if (!user) return;
      if (!isAdmin(user)) return toast(ctx, "Недоступно.");

      const st = getSt(ctx.from.id) || {};
      if (st.importUi?.mode !== "confirm_text" || !st.importPending?.items) {
        return toast(ctx, "Нет данных для импорта.");
      }

      const pending = st.importPending;
      const items = pending.items || [];
      const dupMap = new Map(pending.dupMap || []);

      const res = await applyImport(pool, items, dupMap, mode);

      // очищаем pending
      setSt(ctx.from.id, { importUi: { mode: "menu" }, importPending: null });

      const msg =
        `<b>Импорт завершён</b>\n` +
        `• Создано: <b>${res.created}</b>\n` +
        `• Обновлено: <b>${res.updated}</b>\n` +
        `• Пропущено (дубли): <b>${res.skipped}</b>\n` +
        `• Ошибок БД: <b>${res.dbErrors.length}</b>\n\n` +
        (res.dbErrors.length
          ? `<b>Ошибки (первые ${Math.min(10, res.dbErrors.length)}):</b>\n` +
            res.dbErrors
              .slice(0, 10)
              .map((e, i) => `${i + 1}) ${escapeHtml(e)}`)
              .join("\n")
          : "");

      return deliver(
        ctx,
        { text: msg, extra: { parse_mode: "HTML" } },
        { edit: true }
      );
    } catch (e) {
      logError("text_import_confirm", e);
      return toast(ctx, "Ошибка применения импорта.");
    }
  });

  bot.action("lk_reports_import_text_cancel", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    setSt(ctx.from.id, { importUi: { mode: "menu" }, importPending: null });
    return toast(ctx, "Отменено.");
  });
}

async function parseImportText(text, { pool }) {
  const blocks = text
    .split(/^\s*---\s*$/m)
    .map((b) => b.trim())
    .filter(Boolean);

  const items = [];

  for (let idx = 0; idx < blocks.length; idx++) {
    const b = blocks[idx];
    const lines = b.split("\n").map((x) => x.trim());

    // вытаскиваем поля
    const getVal = (prefix) => {
      const line = lines.find((l) =>
        l.toLowerCase().startsWith(prefix.toLowerCase() + ":")
      );
      if (!line) return null;
      return line.slice(prefix.length + 1).trim();
    };

    const employeeRaw = getVal("Сотрудник");
    const dateRaw = getVal("Дата");
    const timeRaw = getVal("Время");

    // точка в формате "КП79: (-)" — берём первую строку вида "<что-то>:"
    let pointCode = null;
    for (const l of lines) {
      const m = l.match(/^([A-Za-zА-Яа-я0-9_№-]{2,20})\s*:\s*(.*)$/);
      if (!m) continue;
      const key = m[1];
      if (
        [
          "Сотрудник",
          "Дата",
          "Время",
          "Продажи",
          "Наличные",
          "В кассе",
          "Чеков",
          "Инкассация",
          "Сумма инкассации",
        ].includes(key)
      ) {
        continue;
      }
      pointCode = key;
      break;
    }

    const numOrNull = (s) => {
      if (!s) return null;
      if (s === "(-)") return null;
      const m = s.replace(/\s+/g, " ").match(/-?\d+([.,]\d+)?/);
      if (!m) return null;
      return Number(String(m[0]).replace(",", "."));
    };

    const salesTotal = numOrNull(getVal("Продажи"));
    const salesCash = numOrNull(getVal("Наличные"));
    const cashInDrawer = numOrNull(getVal("В кассе"));
    const checksCount = numOrNull(getVal("Чеков"));

    const ink = (getVal("Инкассация") || "").toUpperCase();
    const wasCashCollection =
      ink === "ДА" ? true : ink === "НЕТ" ? false : null;
    const cashCollectionAmount = numOrNull(getVal("Сумма инкассации"));

    // ДАТА обязательна
    const d = parseDateDDMMYY(dateRaw);
    if (!d) {
      items.push({
        ok: false,
        error: `Блок #${idx + 1}: не найдена/неверная Дата (ожидаю DD.MM.YY)`,
      });
      continue;
    }

    const { openedAt, closedAt, timeError } = parseTimeRange(d, timeRaw);
    if (timeError) {
      items.push({
        ok: false,
        error: `Блок #${idx + 1}: неверное Время (ожидаю HH:MM-HH:MM или (-))`,
      });
      continue;
    }

    const tradePointId = await resolveTradePoint(pool, pointCode);

    const userId = await resolveUser(pool, employeeRaw);

    items.push({
      ok: true,
      data: {
        userId, // может быть null
        tradePointId, // может быть null
        pointCode: pointCode || null,
        date: d, // Date (local)
        openedAt, // Date
        closedAt, // Date|null
        salesTotal,
        salesCash,
        cashInDrawer,
        checksCount: checksCount == null ? null : Math.trunc(checksCount),
        wasCashCollection,
        cashCollectionAmount,
      },
    });
  }

  return { items };
}

function parseDateDDMMYY(s) {
  if (!s || s === "(-)") return null;
  const m = String(s)
    .trim()
    .match(/^(\d{2})\.(\d{2})\.(\d{2})$/);
  if (!m) return null;
  const dd = Number(m[1]);
  const mm = Number(m[2]);
  const yy = Number(m[3]) + 2000;
  const d = new Date(yy, mm - 1, dd);
  if (d.getFullYear() !== yy || d.getMonth() !== mm - 1 || d.getDate() !== dd)
    return null;
  return d;
}

function parseTimeRange(dateObj, raw) {
  if (!raw || raw === "(-)") {
    // времени нет -> оставляем только дату (Postgres сам приведёт)
    return { openedAt: dateObj, closedAt: null, timeError: false };
  }
  const m = String(raw)
    .trim()
    .match(/^(\d{2}):(\d{2})\s*-\s*(\d{2}):(\d{2})$/);
  if (!m) return { openedAt: dateObj, closedAt: null, timeError: true };

  const sh = Number(m[1]),
    sm = Number(m[2]),
    eh = Number(m[3]),
    em = Number(m[4]);
  const openedAt = new Date(
    dateObj.getFullYear(),
    dateObj.getMonth(),
    dateObj.getDate(),
    sh,
    sm,
    0
  );
  let closedAt = new Date(
    dateObj.getFullYear(),
    dateObj.getMonth(),
    dateObj.getDate(),
    eh,
    em,
    0
  );
  // если закрытие "раньше" открытия -> считаем, что на следующий день
  if (closedAt < openedAt) {
    closedAt = new Date(closedAt.getTime() + 24 * 60 * 60 * 1000);
  }
  return { openedAt, closedAt, timeError: false };
}

async function resolveTradePoint(pool, code) {
  if (!code || code === "(-)") return null;
  const r = await pool.query(
    `SELECT id FROM trade_points WHERE title = $1 LIMIT 1`,
    [code]
  );
  return r.rows[0]?.id ?? null;
}

async function resolveUser(pool, raw) {
  if (!raw || raw === "(-)") return null;

  const v = String(raw).trim();
  if (!v || v === "(-)") return null;

  // @username
  if (v.startsWith("@")) {
    const username = v.slice(1);
    const r = await pool.query(
      `SELECT id FROM users WHERE username = $1 LIMIT 1`,
      [username]
    );
    return r.rows[0]?.id ?? null;
  }

  // telegram_id числом
  if (/^\d+$/.test(v)) {
    const tg = v;
    const r = await pool.query(
      `SELECT id FROM users WHERE telegram_id = $1 LIMIT 1`,
      [tg]
    );
    return r.rows[0]?.id ?? null;
  }

  return null;
}

async function findDuplicates(pool, okItems) {
  // ключ: yyyy-mm-dd|tpId
  const keys = [];
  const keyToItem = new Map();

  for (const it of okItems) {
    const d = it.data;
    if (!d.tradePointId) continue;
    const key = `${toISODate(d.date)}|${d.tradePointId}`;
    keys.push(key);
    keyToItem.set(key, d);
  }

  if (!keys.length) return new Map();

  // ищем смены по opened_at::date и trade_point_id
  const unique = [...new Set(keys)];
  const parts = unique.map((k) => k.split("|"));
  const dates = parts.map((p) => p[0]);
  const tpIds = parts.map((p) => Number(p[1]));

  // берём все совпадения по списку дат и точек
  const r = await pool.query(
    `SELECT id, trade_point_id, opened_at::date as d
     FROM shifts
     WHERE opened_at::date = ANY($1::date[])
       AND trade_point_id = ANY($2::int[])
       AND status = 'closed'`,
    [dates, tpIds]
  );

  const dupMap = new Map();
  for (const row of r.rows) {
    const key = `${row.d}|${row.trade_point_id}`;
    if (!dupMap.has(key)) dupMap.set(key, row.id);
  }
  return dupMap;
}

async function applyImport(pool, okItems, dupMap, mode) {
  const res = { created: 0, updated: 0, skipped: 0, dbErrors: [] };

  // упрощённо: построчно
  for (const it of okItems) {
    const d = it.data;

    const key = d.tradePointId
      ? `${toISODate(d.date)}|${d.tradePointId}`
      : null;
    const dupShiftId = key && dupMap.has(key) ? dupMap.get(key) : null;

    if (dupShiftId && mode === "skip") {
      res.skipped++;
      continue;
    }

    try {
      if (dupShiftId && mode === "update") {
        await updateShiftAndClosing(pool, dupShiftId, d);
        res.updated++;
      } else {
        const shiftId = await insertShift(pool, d);
        await upsertClosing(pool, shiftId, d);
        res.created++;
      }
    } catch (e) {
      res.dbErrors.push(
        `Дата ${toISODate(d.date)} ${d.pointCode || ""}: ${e.message || e}`
      );
    }
  }

  return res;
}

async function insertShift(pool, d) {
  const opened = d.openedAt || d.date;
  const closed = d.closedAt || null;

  const r = await pool.query(
    `INSERT INTO shifts (user_id, trade_point_id, opened_at, closed_at, status)
     VALUES ($1, $2, $3, $4, 'closed')
     RETURNING id`,
    [d.userId, d.tradePointId, opened, closed]
  );
  return r.rows[0].id;
}

async function updateShiftAndClosing(pool, shiftId, d) {
  const opened = d.openedAt || d.date;
  const closed = d.closedAt || null;

  await pool.query(
    `UPDATE shifts
     SET user_id = COALESCE($2, user_id),
         trade_point_id = COALESCE($3, trade_point_id),
         opened_at = COALESCE($4, opened_at),
         closed_at = COALESCE($5, closed_at),
         status = 'closed'
     WHERE id = $1`,
    [shiftId, d.userId, d.tradePointId, opened, closed]
  );

  await upsertClosing(pool, shiftId, d);
}

async function upsertClosing(pool, shiftId, d) {
  const r = await pool.query(
    `UPDATE shift_closings
     SET sales_total = $2,
         sales_cash = $3,
         cash_in_drawer = $4,
         checks_count = $5,
         was_cash_collection = $6,
         cash_collection_amount = $7
     WHERE shift_id = $1 AND deleted_at IS NULL
     RETURNING id`,
    [
      shiftId,
      d.salesTotal,
      d.salesCash,
      d.cashInDrawer,
      d.checksCount,
      d.wasCashCollection,
      d.cashCollectionAmount,
    ]
  );

  if (r.rowCount > 0) return;

  await pool.query(
    `INSERT INTO shift_closings
      (shift_id, sales_total, sales_cash, cash_in_drawer, checks_count, was_cash_collection, cash_collection_amount)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`,
    [
      shiftId,
      d.salesTotal,
      d.salesCash,
      d.cashInDrawer,
      d.checksCount,
      d.wasCashCollection,
      d.cashCollectionAmount,
    ]
  );
}

function toISODate(d) {
  const yy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

module.exports = { registerTextImport };
