// src/bot/admin/shiftSettings.js
const { Markup } = require("telegraf");
const pool = require("../../db/pool");
const { deliver } = require("../../utils/renderHelpers");

function isAdmin(user) {
  return user && (user.role === "admin" || user.role === "super_admin");
}

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function scheduleLabel(r) {
  if (r.schedule_type === "single") return `Разовая: ${r.single_date || "—"}`;
  if (r.schedule_type === "weekly")
    return `Еженед.: mask=${Number(r.weekdays_mask || 0)}`;
  if (r.schedule_type === "every_x_days")
    return `Каждые ${Number(r.every_x_days || 0)} дн. (старт: ${
      r.start_date || "—"
    })`;
  return "—";
}

function timeLabel(r) {
  if (r.time_mode === "deadline_time") return `До ${r.deadline_time || "—"}`;
  return "В течение дня";
}

/**
 * filter:
 *  - { mode: "all" }
 *  - { mode: "common" } -> point_scope = all_points
 *  - { mode: "point", tradePointId: number } -> point_scope = one_point AND trade_point_id=...
 */
async function loadDayAssignments(filter = { mode: "all" }) {
  const params = [];
  let where = "";

  if (filter?.mode === "common") {
    where = `WHERE a.point_scope = 'all_points'`;
  } else if (filter?.mode === "point") {
    params.push(Number(filter.tradePointId));
    where = `WHERE a.point_scope = 'one_point' AND a.trade_point_id = $1`;
  }

  const res = await pool.query(
    `
      SELECT
        a.id AS assignment_id,
        a.is_active,
        a.task_type,
        a.point_scope,
        a.trade_point_id,
        t.title,
        t.answer_type,
        s.schedule_type,
        s.start_date,
        s.single_date,
        s.weekdays_mask,
        s.every_x_days,
        s.time_mode,
        s.deadline_time
      FROM task_assignments a
      JOIN task_schedules s ON s.assignment_id = a.id
      JOIN task_templates t ON t.id = a.template_id
      ${where}
      ORDER BY a.id DESC
      LIMIT 30
    `,
    params
  );

  return res.rows;
}

async function showDayRoot(ctx) {
  const text = "📋 <b>Задачи в течение дня</b>\n\n" + "Выберите раздел:";

  const kb = Markup.inlineKeyboard([
    [
      {
        text: "🗓️ Задачи по расписанию (авто)",
        callback_data: "admin_shift_day_auto_root",
      },
    ],
    [
      {
        text: "👤 Дать задачу индивидуально сотруднику",
        callback_data: "admin_shift_day_individual_info",
      },
    ],
    [{ text: "⬅️ Назад", callback_data: "admin_shift_settings" }],
  ]);

  await deliver(ctx, { text, extra: kb }, { edit: true });
}

async function showAutoRoot(ctx) {
  const text = "🗓️ <b>Задачи по расписанию (авто)</b>\n\n" + "Выберите тип:";

  const kb = Markup.inlineKeyboard([
    [{ text: "🌐 Общие задачи", callback_data: "admin_shift_day_list_common" }],
    [
      {
        text: "📍 Задачи конкретной точки",
        callback_data: "admin_shift_day_points",
      },
    ],
    [{ text: "⬅️ Назад", callback_data: "admin_shift_day_root" }],
  ]);

  await deliver(ctx, { text, extra: kb }, { edit: true });
}

async function showPickPointForDayTasks(ctx) {
  const res = await pool.query(
    `
      SELECT id, title
      FROM trade_points
      WHERE is_active = TRUE
      ORDER BY id
    `
  );

  let text = "📍 <b>Выберите торговую точку</b>\n\n";
  if (!res.rows.length) text += "Нет активных точек.";

  const rows = [];
  for (const p of res.rows) {
    rows.push([
      Markup.button.callback(
        `${p.title}`,
        `admin_shift_day_list_point_${p.id}`
      ),
    ]);
  }
  rows.push([Markup.button.callback("⬅️ Назад", "admin_shift_day_root")]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(rows) },
    { edit: true }
  );
}

async function showDayList(ctx, filter) {
  const rows = await loadDayAssignments(filter);

  let title = "📄 <b>Назначения задач (по расписанию)</b>\n\n";
  if (filter?.mode === "common") title = "📄 <b>Общие авто-задачи</b>\n\n";
  if (filter?.mode === "point")
    title = `📄 <b>Авто-задачи точки #${Number(filter.tradePointId)}</b>\n\n`;

  let text = title;

  if (!rows.length) {
    text += "Пока нет ни одного назначения.\n";
  } else {
    rows.forEach((r, i) => {
      const n = i + 1;
      const on = r.is_active ? "🟢" : "🔴";
      const who = r.task_type === "global" ? "🌐" : "👤";
      const point =
        r.point_scope === "all_points"
          ? "🏬 все точки"
          : `📍 точка #${r.trade_point_id}`;

      const type =
        r.answer_type === "photo"
          ? "📷"
          : r.answer_type === "video"
          ? "🎥"
          : r.answer_type === "number"
          ? "🔢"
          : "📝";

      text += `${n}. ${on} ${who} ${type} ${esc(
        r.title
      )}\n   ${point} • ${scheduleLabel(r)} • ${timeLabel(r)}\n`;
    });
  }

  const kb = [];
  if (rows.length) {
    const btns = rows.map((r, idx) =>
      Markup.button.callback(
        `${idx + 1}`,
        `admin_shift_day_card_${r.assignment_id}`
      )
    );
    for (let i = 0; i < btns.length; i += 5) kb.push(btns.slice(i, i + 5));
  }

  // ВАЖНО: здесь НЕ добавляем "создать задачу" — это отдельно через мастер из других мест
  kb.push([{ text: "⬅️ Назад", callback_data: "admin_shift_day_root" }]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(kb) },
    { edit: true }
  );
}

async function showDayCard(ctx, assignmentId) {
  const res = await pool.query(
    `
      SELECT
        a.id AS assignment_id,
        a.is_active,
        a.task_type,
        a.point_scope,
        a.trade_point_id,
        t.title,
        t.answer_type,
        s.schedule_type,
        s.start_date,
        s.single_date,
        s.weekdays_mask,
        s.every_x_days,
        s.time_mode,
        s.deadline_time
      FROM task_assignments a
      JOIN task_schedules s ON s.assignment_id = a.id
      JOIN task_templates t ON t.id = a.template_id
      WHERE a.id = $1
      LIMIT 1
    `,
    [assignmentId]
  );

  const r = res.rows[0];
  if (!r) {
    await ctx
      .answerCbQuery("Назначение не найдено", { show_alert: true })
      .catch(() => {});
    return showDayRoot(ctx);
  }

  const status = r.is_active ? "🟢 Активно" : "🔴 Выключено";
  const who = r.task_type === "global" ? "🌐 Общая" : "👤 Индивидуальная";
  const point =
    r.point_scope === "all_points"
      ? "🏬 Для всех точек"
      : `📍 Для точки #${r.trade_point_id}`;

  const text =
    `🧾 <b>Назначение задачи</b> #${r.assignment_id}\n\n` +
    `Статус: <b>${status}</b>\n` +
    `Кому: <b>${who}</b>\n` +
    `${point}\n\n` +
    `Задача: <b>${esc(r.title)}</b>\n` +
    `Тип ответа: <b>${esc(r.answer_type)}</b>\n\n` +
    `Расписание: <b>${esc(scheduleLabel(r))}</b>\n` +
    `Время: <b>${esc(timeLabel(r))}</b>`;

  const kb = Markup.inlineKeyboard([
    [
      {
        text: r.is_active ? "🔴 Выключить" : "🟢 Включить",
        callback_data: `admin_shift_day_toggle_${r.assignment_id}`,
      },
    ],
    [{ text: "⬅️ Назад", callback_data: "admin_shift_day_root" }],
  ]);

  await deliver(ctx, { text, extra: kb }, { edit: true });
}

async function showIndividualInfo(ctx) {
  const text =
    "👤 <b>Дать задачу индивидуально сотруднику</b>\n\n" +
    "Чтобы выдать задачу конкретному сотруднику/стажёру:\n" +
    "1) Перейдите в список сотрудников\n" +
    "2) Откройте карточку нужного человека\n" +
    "3) Нажмите кнопку <b>«➕ Дать задачу»</b>\n\n" +
    "Так задача будет назначена именно этому человеку.";

  const kb = Markup.inlineKeyboard([
    [{ text: "👥 Перейти к списку сотрудников", callback_data: "admin_users" }],
    [{ text: "⬅️ Назад", callback_data: "admin_shift_settings" }],
  ]);

  await deliver(ctx, { text, extra: kb }, { edit: true });
}

function registerAdminShiftSettings(bot, ensureUser, logError) {
  // -----------------------------
  // Вход в "Настройка смен"
  // -----------------------------
  bot.action("admin_shift_settings", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const text = "🛠 <b>Настройка смен</b>\n\nВыберите раздел:";
      const keyboard = Markup.inlineKeyboard([
        [
          {
            text: "🚀 Задачи открытия смены",
            callback_data: "admin_shift_opening_root",
          },
        ],
        [
          {
            text: "📋 Задачи в течение дня",
            callback_data: "admin_shift_tasks",
          },
        ],
        [
          {
            text: "🛑 Задачи закрытия смены",
            callback_data: "admin_shift_closing_root",
          },
        ],
        [
          {
            text: "👤 Назначение ответственных",
            callback_data: "admin_resp_root",
          },
        ],
        [{ text: "⬅️ Назад", callback_data: "admin_settings_company" }],
      ]);

      await deliver(ctx, { text, extra: keyboard }, { edit: true });
    } catch (err) {
      logError("admin_shift_settings", err);
    }
  });

  // --- Day tasks root (AUTO) ---
  bot.action("admin_shift_day_root", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      // старый раздел убран → перенаправляем в новый "Задачи смены"
      const text =
        "📋 <b>Задачи в течение дня</b>\n\n" +
        "Этот раздел перенесён.\n" +
        "Открываю новый экран «Задачи смены».";
      const kb = Markup.inlineKeyboard([
        [{ text: "📋 Задачи смены", callback_data: "admin_shift_tasks" }],
        [{ text: "⬅️ Назад", callback_data: "admin_shift_settings" }],
      ]);

      await deliver(ctx, { text, extra: kb }, { edit: true });
    } catch (err) {
      logError("admin_shift_day_root", err);
    }
  });

  bot.action("admin_shift_day_points", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      await showPickPointForDayTasks(ctx);
    } catch (err) {
      logError("admin_shift_day_points", err);
    }
  });

  bot.action("admin_shift_day_auto_root", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      await showAutoRoot(ctx);
    } catch (err) {
      logError("admin_shift_day_auto_root", err);
    }
  });

  bot.action("admin_shift_day_list_common", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      await showDayList(ctx, { mode: "common" });
    } catch (err) {
      logError("admin_shift_day_list_common", err);
    }
  });

  bot.action(/^admin_shift_day_list_point_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      await showDayList(ctx, {
        mode: "point",
        tradePointId: Number(ctx.match[1]),
      });
    } catch (err) {
      logError("admin_shift_day_list_point", err);
    }
  });

  bot.action(/^admin_shift_day_card_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      await showDayCard(ctx, Number(ctx.match[1]));
    } catch (err) {
      logError("admin_shift_day_card", err);
    }
  });

  bot.action(/^admin_shift_day_toggle_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const id = Number(ctx.match[1]);
      await pool.query(
        `UPDATE task_assignments SET is_active = NOT is_active WHERE id = $1`,
        [id]
      );

      await ctx.answerCbQuery("✅ Обновлено").catch(() => {});
      await showDayCard(ctx, id);
    } catch (err) {
      logError("admin_shift_day_toggle", err);
    }
  });

  // --- Info screen about individual tasks ---
  bot.action("admin_shift_day_individual_info", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;
      await showIndividualInfo(ctx);
    } catch (err) {
      logError("admin_shift_individual_info", err);
    }
  });
}

module.exports = { registerAdminShiftSettings };
