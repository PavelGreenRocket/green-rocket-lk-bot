// src/bot/admin/responsibles.js
const { Markup } = require("telegraf");
const pool = require("../../db/pool");
const { deliver } = require("../../utils/renderHelpers");
const { getUserState, setUserState, clearUserState } = require("../state");

const MODE = "admin_responsibles";

function isAdmin(user) {
  return user && (user.role === "admin" || user.role === "super_admin");
}

function stGet(tgId) {
  const st = getUserState(tgId);
  return st && st.mode === MODE ? st : null;
}
function stSet(tgId, patch) {
  const prev = stGet(tgId) || { mode: MODE };
  setUserState(tgId, { ...prev, ...patch });
}
function stClear(tgId) {
  const st = stGet(tgId);
  if (st) clearUserState(tgId);
}

async function loadPoints() {
  const r = await pool.query(
    `SELECT id, title FROM trade_points WHERE is_active=TRUE ORDER BY id`
  );
  return r.rows;
}

async function loadPointWorkHours(tradePointId) {
  if (tradePointId == null) return null;
  const r = await pool.query(
    `SELECT work_hours_weekdays, work_hours_weekends, work_hours
     FROM trade_points WHERE id=$1 LIMIT 1`,
    [tradePointId]
  );
  return r.rows[0] || null;
}

async function getControlRow(tradePointId) {
  if (tradePointId == null) {
    const r = await pool.query(
      `SELECT * FROM shift_opening_control
       WHERE trade_point_id IS NULL
       ORDER BY id DESC
       LIMIT 1`
    );
    return r.rows[0] || null;
  }
  const r = await pool.query(
    `SELECT * FROM shift_opening_control WHERE trade_point_id=$1 LIMIT 1`,
    [tradePointId]
  );
  return r.rows[0] || null;
}

async function getEffectiveControl(tradePointId) {
  // точка -> иначе global -> иначе дефолт
  const specific =
    tradePointId == null ? null : await getControlRow(tradePointId);
  if (specific) return { row: specific, source: "specific" };

  const global = await getControlRow(null);
  if (global) return { row: global, source: "global" };

  return {
    row: { trade_point_id: null, enabled: true, threshold_minutes: 1 },
    source: "default",
  };
}

function fmtWorkHours(whRow) {
  if (!whRow) return "—";
  const w = (whRow.work_hours_weekdays || "").trim();
  const e = (whRow.work_hours_weekends || "").trim();
  if (w || e) {
    const parts = [];
    if (w) parts.push(`Будни: ${w}`);
    if (e) parts.push(`Выходные: ${e}`);
    return parts.join(" / ");
  }
  return (whRow.work_hours || "").trim() || "—";
}

function isValidMinutesText(t) {
  const n = Number(String(t || "").trim());
  return Number.isInteger(n) && n >= 0 && n <= 600;
}
async function loadPointWorkHours(tradePointId) {
  if (tradePointId == null) return null;
  const r = await pool.query(
    `SELECT work_hours_weekdays, work_hours_weekends, work_hours
     FROM trade_points WHERE id=$1 LIMIT 1`,
    [tradePointId]
  );
  return r.rows[0] || null;
}

async function getControlRow(tradePointId) {
  if (tradePointId == null) {
    const r = await pool.query(
      `SELECT * FROM shift_opening_control
       WHERE trade_point_id IS NULL
       ORDER BY id DESC
       LIMIT 1`
    );
    return r.rows[0] || null;
  }
  const r = await pool.query(
    `SELECT * FROM shift_opening_control WHERE trade_point_id=$1 LIMIT 1`,
    [tradePointId]
  );
  return r.rows[0] || null;
}

async function getEffectiveControl(tradePointId) {
  // точка -> иначе global -> иначе дефолт
  const specific =
    tradePointId == null ? null : await getControlRow(tradePointId);
  if (specific) return { row: specific, source: "specific" };

  const global = await getControlRow(null);
  if (global) return { row: global, source: "global" };

  return {
    row: { trade_point_id: null, enabled: true, threshold_minutes: 1 },
    source: "default",
  };
}
async function upsertControl(tradePointId, patch) {
  // patch: { enabled?, threshold_minutes?, repeat_minutes? }
  const enabled = patch.enabled === undefined ? null : Boolean(patch.enabled);
  const thr =
    patch.threshold_minutes === undefined
      ? null
      : Number(patch.threshold_minutes);

  const rep =
    patch.repeat_minutes === undefined ? null : Number(patch.repeat_minutes);

  if (tradePointId == null) {
    // global row: update existing else insert
    const cur = await getControlRow(null);
    if (cur?.id) {
      await pool.query(
        `UPDATE shift_opening_control
         SET enabled = COALESCE($1, enabled),
             threshold_minutes = COALESCE($2, threshold_minutes),
             repeat_minutes = COALESCE($3, repeat_minutes)
          WHERE id = $4`,
        [
          enabled,
          Number.isFinite(thr) ? thr : null,
          Number.isFinite(rep) ? rep : null,
          cur.id,
        ]
      );
    } else {
      await pool.query(
        `INSERT INTO shift_opening_control (trade_point_id, enabled, threshold_minutes, repeat_minutes)
   VALUES (NULL, COALESCE($1,true), COALESCE($2,1), COALESCE($3,10))`,
        [
          enabled,
          Number.isFinite(thr) ? thr : null,
          Number.isFinite(rep) ? rep : null,
        ]
      );
    }
    return;
  }

  await pool.query(
    `INSERT INTO shift_opening_control (trade_point_id, enabled, threshold_minutes, repeat_minutes)
   VALUES ($1, COALESCE($2,true), COALESCE($3,1), COALESCE($4,10))
   ON CONFLICT (trade_point_id)
   DO UPDATE SET enabled = COALESCE($2, shift_opening_control.enabled),
                 threshold_minutes = COALESCE($3, shift_opening_control.threshold_minutes),
                 repeat_minutes = COALESCE($4, shift_opening_control.repeat_minutes)`,
    [
      tradePointId,
      enabled,
      Number.isFinite(thr) ? thr : null,
      Number.isFinite(rep) ? rep : null,
    ]
  );
}

function fmtWorkHours(whRow) {
  if (!whRow) return "—";
  const w = (whRow.work_hours_weekdays || "").trim();
  const e = (whRow.work_hours_weekends || "").trim();
  if (w || e) {
    const parts = [];
    if (w) parts.push(`Будни: ${w}`);
    if (e) parts.push(`Выходные: ${e}`);
    return parts.join(" / ");
  }
  return (whRow.work_hours || "").trim() || "—";
}

function isValidMinutesText(t) {
  const n = Number(String(t || "").trim());
  return Number.isInteger(n) && n >= 0 && n <= 600;
}

async function loadResp(tradePointId, kind) {
  const r = await pool.query(
    `
    SELECT ra.id, ra.user_id, COALESCE(u.full_name,'Без имени') AS full_name
    FROM responsible_assignments ra
    JOIN users u ON u.id = ra.user_id
    WHERE ra.trade_point_id IS NOT DISTINCT FROM $1
  AND ra.kind=$2
  AND ra.is_active=TRUE

    ORDER BY u.full_name NULLS LAST, ra.id
    `,
    [tradePointId, kind]
  );
  return r.rows;
}

async function loadUsersForPick(q) {
  // ВАЖНО: без фильтров staff_status/role, чтобы "виделись все"
  const r = await pool.query(
    `
    SELECT id, COALESCE(full_name,'Без имени') AS full_name
    FROM users
    ORDER BY full_name NULLS LAST, id
    LIMIT 60
    `
  );
  return r.rows;
}

function kindLabel(kind) {
  if (kind === "uncompleted_tasks")
    return "📝 Ответственные — невыполненные задачи";
  if (kind === "complaints")
    return "💬 Ответственные — жалобы на прошлую смену";
  if (kind === "cash_diff")
    return "💸 Ответственные — контроль недостач/излишек";
  if (kind === "shift_opening_control") return "🚀 Контроль открытия смены";
  return kind;
}

async function showRoot(ctx) {
  const text =
    "👤 <b>Назначение ответственных</b>\n\n" +
    "Здесь назначаются сотрудники, которые будут получать уведомления:\n" +
    "• если смена закрыта с невыполненными задачами\n" +
    "• если бариста оставил замечание по прошлой смене\n" +
    "• если выявлена недостача/излишек по кассе\n\n" +
    "Выберите тип:";
  const kb = Markup.inlineKeyboard([
    [
      {
        text: "📝 по невыполненным задачам за смену",
        callback_data: "admin_resp_kind_uncompleted_tasks",
      },
    ],
    [
      {
        text: "💬 по жалобам на прошлую смену",
        callback_data: "admin_resp_kind_complaints",
      },
    ],
    [
      {
        text: "💸 контроль недостач/излишек",
        callback_data: "admin_resp_kind_cash_diff",
      },
    ],
    [
      {
        text: "🚀 контроль открытия смены",
        callback_data: "admin_resp_kind_shift_opening_control",
      },
    ],
    [
      {
        text: "💰 доступ к инкассации",
        callback_data: "admin_cash_access_root",
      },
    ],

    [{ text: "⬅️ Назад", callback_data: "admin_shift_settings" }],
  ]);
  await deliver(ctx, { text, extra: kb }, { edit: true });
}

async function showPickPoint(ctx, kind) {
  const points = await loadPoints();
  const text = `${kindLabel(kind)}\n\n📍 Выберите точку:`;

  const rows = points.map((p) => [
    Markup.button.callback(p.title, `admin_resp_point_${kind}_${p.id}`),
  ]);

  // "Все точки" (trade_point_id = NULL)
  rows.push([
    Markup.button.callback("🏬 Все точки", `admin_resp_point_${kind}_all`),
  ]);

  rows.push([Markup.button.callback("⬅️ Назад", "admin_resp_root")]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(rows) },
    { edit: true }
  );
}

async function showPointCard(ctx, kind, tradePointId) {
  let title = "Все точки";

  if (tradePointId !== null) {
    const tp = await pool.query(
      `SELECT title FROM trade_points WHERE id=$1 LIMIT 1`,
      [tradePointId]
    );
    title = tp.rows[0]?.title || `#${tradePointId}`;
  }

  const resp = await loadResp(tradePointId, kind);

  let text = `${kindLabel(kind)}\n\n` + `📍 Точка: <b>${title}</b>\n\n`;

  if (kind === "shift_opening_control") {
    const wh = await loadPointWorkHours(tradePointId);
    const eff = await getEffectiveControl(tradePointId);

    text += `🕒 Время работы: ${fmtWorkHours(wh)}\n`;
    text += `⏱ Порог опоздания: <b>${eff.row.threshold_minutes}</b> мин.\n`;
    text += `🔁 Периодичность: <b>${eff.row.repeat_minutes ?? 10}</b> мин.\n`;
    text += `🔔 Уведомления: <b>${
      eff.row.enabled ? "включены" : "выключены"
    }</b>\n`;

    if (tradePointId !== null && eff.source === "global") {
      text += `\n<i>(используется настройка “Все точки”)</i>\n`;
    }
    text += `\n`;
  }

  if (!resp.length) {
    text += "Пока нет назначенных ответственных.\n";
  } else {
    text += "Ответственные:\n";
    resp.forEach((r, i) => {
      text += `${i + 1}. ${r.full_name}\n`;
    });
  }

  const kb = [];

  if (resp.length) {
    // кнопки удаления 1..N
    const tpKey = tradePointId === null ? "all" : String(tradePointId);

    const btns = resp.map((r, idx) =>
      Markup.button.callback(
        `${idx + 1}`,
        `admin_resp_del_${r.id}_${kind}_${tpKey}`
      )
    );
    for (let i = 0; i < btns.length; i += 5) kb.push(btns.slice(i, i + 5));
    kb.push([{ text: "🗑 удалить (нажмите номер)", callback_data: "noop" }]);
  }

  const tpKey = tradePointId === null ? "all" : String(tradePointId);

  if (kind === "shift_opening_control") {
    const eff = await getEffectiveControl(tradePointId);
    const tpKey2 = tradePointId === null ? "all" : String(tradePointId);

    kb.push([
      {
        text: eff.row.enabled
          ? "🔕 выключить уведомления"
          : "🔔 включить уведомления",
        callback_data: `admin_soc_toggle_${tpKey2}`,
      },
    ]);
    kb.push([
      {
        text: "✏️ изменить порог",
        callback_data: `admin_soc_threshold_${tpKey2}`,
      },
    ]);

    kb.push([
      {
        text: "⏱ периодичность уведомления",
        callback_data: `admin_soc_repeat_${tpKey2}`,
      },
    ]);
  }

  kb.push([
    {
      text: "➕ Назначить ответственного",
      callback_data: `admin_resp_add_${kind}_${tpKey}`,
    },
  ]);

  kb.push([{ text: "⬅️ Назад", callback_data: `admin_resp_kind_${kind}` }]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(kb) },
    { edit: true }
  );
}

async function showPickUser(ctx, kind, tradePointId) {
  stSet(ctx.from.id, { step: "pick_user", kind, tradePointId });

  const users = await loadUsersForPick();
  const text =
    "➕ <b>Назначить ответственного</b>\n\n" +
    "Выберите пользователя (можно назначать любого сотрудника, не важно админ он или нет):";

  const rows = users.map((u) => [
    Markup.button.callback(u.full_name, `admin_resp_pick_${u.id}`),
  ]);

  const backTp = tradePointId === null ? "all" : String(tradePointId);
  rows.push([
    Markup.button.callback("⬅️ Назад", `admin_resp_point_${kind}_${backTp}`),
  ]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(rows) },
    { edit: true }
  );
}

function registerAdminResponsibles(bot, ensureUser, logError) {
  bot.action(/^admin_soc_toggle_(\d+|all)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const raw = ctx.match[1];
      const tpId = raw === "all" ? null : Number(raw);

      const eff = await getEffectiveControl(tpId);
      await upsertControl(tpId, { enabled: !eff.row.enabled });

      await ctx.answerCbQuery("✅ Сохранено").catch(() => {});
      await showPointCard(ctx, "shift_opening_control", tpId);
    } catch (e) {
      logError("admin_soc_toggle", e);
    }
  });

  bot.action(/^admin_soc_threshold_(\d+|all)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const raw = ctx.match[1];
      const tpId = raw === "all" ? null : Number(raw);

      stSet(ctx.from.id, {
        step: "soc_threshold",
        kind: "shift_opening_control",
        tradePointId: tpId,
      });

      const eff = await getEffectiveControl(tpId);
      const text =
        "✏️ <b>Изменить порог опоздания</b>\n\n" +
        `Текущий порог: <b>${eff.row.threshold_minutes}</b> мин.\n\n` +
        "Отправьте числом количество минут (0–600).";

      const backKey = tpId === null ? "all" : String(tpId);
      const kb = Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "⬅️ Назад",
            `admin_resp_point_shift_opening_control_${backKey}`
          ),
        ],
      ]);

      await deliver(ctx, { text, extra: kb }, { edit: true });
    } catch (e) {
      logError("admin_soc_threshold", e);
    }
  });

  bot.action(/^admin_soc_repeat_(\d+|all)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const raw = ctx.match[1];
      const tpId = raw === "all" ? null : Number(raw);

      stSet(ctx.from.id, {
        step: "soc_repeat",
        kind: "shift_opening_control",
        tradePointId: tpId,
      });

      const eff = await getEffectiveControl(tpId);
      const cur = eff.row.repeat_minutes ?? 10;

      const text =
        "⏱ <b>Периодичность уведомления</b>\n\n" +
        `Текущее значение: <b>${cur}</b> мин.\n\n` +
        "Отправьте числом количество минут (1–600).";

      const backKey = tpId === null ? "all" : String(tpId);
      const kb = Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "⬅️ Назад",
            `admin_resp_point_shift_opening_control_${backKey}`
          ),
        ],
      ]);

      await deliver(ctx, { text, extra: kb }, { edit: true });
    } catch (e) {
      logError("admin_soc_repeat", e);
    }
  });

  // ловим текст только когда ждём порог
  bot.on("text", async (ctx, next) => {
    try {
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return next();

      const st = stGet(ctx.from.id);
      if (!st || (st.step !== "soc_threshold" && st.step !== "soc_repeat"))
        return next();

      const raw = (ctx.message?.text || "").trim();
      const n = Number(raw);
      const ok =
        Number.isInteger(n) &&
        (st.step === "soc_threshold" ? n >= 0 && n <= 600 : n >= 1 && n <= 600);
      if (!ok) {
        await ctx
          .reply(
            st.step === "soc_threshold"
              ? "❌ Введите целое число минут (0–600)."
              : "❌ Введите целое число минут (1–600)."
          )
          .catch(() => {});
        return;
      }

      const tpId = st.tradePointId ?? null;
      if (st.step === "soc_threshold") {
        await upsertControl(tpId, { threshold_minutes: n });
      } else {
        await upsertControl(tpId, { repeat_minutes: n });
      }

      stClear(ctx.from.id);
      await ctx
        .reply(
          st.step === "soc_threshold"
            ? "✅ Порог сохранён."
            : "✅ Периодичность сохранена."
        )
        .catch(() => {});
      await showPointCard(ctx, "shift_opening_control", tpId);
    } catch (e) {
      logError("admin_soc_threshold_text", e);
      return next();
    }
  });

  bot.action("admin_resp_root", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      stClear(ctx.from.id);
      await showRoot(ctx);
    } catch (e) {
      logError("admin_resp_root", e);
    }
  });

  bot.action(
    /^admin_resp_kind_(uncompleted_tasks|complaints|cash_diff|shift_opening_control)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery().catch(() => {});
        const user = await ensureUser(ctx);
        if (!isAdmin(user)) return;
        const kind = ctx.match[1];
        stClear(ctx.from.id);
        await showPickPoint(ctx, kind);
      } catch (e) {
        logError("admin_resp_kind", e);
      }
    }
  );

  bot.action(
    /^admin_resp_point_(uncompleted_tasks|complaints|cash_diff|shift_opening_control)_(\d+|all)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery().catch(() => {});
        const user = await ensureUser(ctx);
        if (!isAdmin(user)) return;
        const kind = ctx.match[1];
        const raw = ctx.match[2];
        const tpId = raw === "all" ? null : Number(raw);
        stClear(ctx.from.id);
        await showPointCard(ctx, kind, tpId);
      } catch (e) {
        logError("admin_resp_point", e);
      }
    }
  );

  bot.action(
    /^admin_resp_add_(uncompleted_tasks|complaints|cash_diff|shift_opening_control)_(\d+|all)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery().catch(() => {});
        const user = await ensureUser(ctx);
        if (!isAdmin(user)) return;
        const kind = ctx.match[1];
        const raw = ctx.match[2];
        const tpId = raw === "all" ? null : Number(raw);
        await showPickUser(ctx, kind, tpId);
      } catch (e) {
        logError("admin_resp_add", e);
      }
    }
  );

  bot.action(/^admin_resp_pick_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const st = stGet(ctx.from.id);
      if (!st || st.step !== "pick_user") return;

      const pickedUserId = Number(ctx.match[1]);

      await pool.query(
        `
  WITH up AS (
    UPDATE responsible_assignments
    SET is_active = TRUE
    WHERE trade_point_id IS NOT DISTINCT FROM $1
      AND kind = $2
      AND user_id = $3
    RETURNING id
  )
  INSERT INTO responsible_assignments (trade_point_id, kind, user_id, is_active)
  SELECT $1, $2, $3, TRUE
  WHERE NOT EXISTS (SELECT 1 FROM up)
  `,
        [st.tradePointId, st.kind, pickedUserId]
      );

      stClear(ctx.from.id);
      await ctx.answerCbQuery("✅ Назначено").catch(() => {});
      await showPointCard(ctx, st.kind, st.tradePointId ?? null);
    } catch (e) {
      logError("admin_resp_pick", e);
    }
  });

  bot.action(
    /^admin_resp_del_(\d+)_(uncompleted_tasks|complaints|cash_diff|shift_opening_control)_(\d+|all)$/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery().catch(() => {});
        const user = await ensureUser(ctx);
        if (!isAdmin(user)) return;

        const id = Number(ctx.match[1]);
        const kind = ctx.match[2];
        const raw = ctx.match[3];
        const tpId = raw === "all" ? null : Number(raw);

        await pool.query(
          `UPDATE responsible_assignments SET is_active=FALSE WHERE id=$1`,
          [id]
        );

        await ctx.answerCbQuery("🗑 Удалено").catch(() => {});
        await showPointCard(ctx, kind, tpId);
      } catch (e) {
        logError("admin_resp_del", e);
      }
    }
  );

  bot.action("noop", async (ctx) => ctx.answerCbQuery().catch(() => {}));
}

module.exports = { registerAdminResponsibles };
