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

async function loadDayAssignments() {
  const res = await pool.query(`
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
    ORDER BY a.id DESC
    LIMIT 30
  `);
  return res.rows;
}

async function showDayRoot(ctx) {
  const text = "📋 <b>Задачи смены (в течение дня)</b>\n\nВыберите действие:";
  const kb = Markup.inlineKeyboard([
    [
      {
        text: "➕ Назначить / создать задачу",
        callback_data: "admin_task_create",
      },
    ],
    [{ text: "📄 Список назначений", callback_data: "admin_shift_day_list" }],
    [{ text: "⬅️ Назад", callback_data: "admin_shift_settings" }],
  ]);
  await deliver(ctx, { text, extra: kb }, { edit: true });
}

async function showDayList(ctx) {
  const rows = await loadDayAssignments();

  let text = "📄 <b>Назначения задач (в течение дня)</b>\n\n";
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
  kb.push([
    { text: "➕ Назначить / создать", callback_data: "admin_task_create" },
  ]);
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
    return showDayList(ctx);
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
    [{ text: "⬅️ Назад к списку", callback_data: "admin_shift_day_list" }],
  ]);

  await deliver(ctx, { text, extra: kb }, { edit: true });
}

function registerAdminShiftSettings(bot, ensureUser, logError) {
  // Вход в "Настройка смен"
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
            text: "📋 Задачи смены (в течении дня)",
            callback_data: "admin_shift_day_root",
          },
        ],
        [
          {
            text: "🛑 Задачи закрытия смены",
            callback_data: "admin_shift_closing_root",
          },
        ],
        [{ text: "⬅️ Назад", callback_data: "admin_settings_company" }],
      ]);

      await deliver(ctx, { text, extra: keyboard }, { edit: true });
    } catch (err) {
      logError("admin_shift_settings", err);
    }
  });

  bot.action("admin_shift_day_root", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      await showDayRoot(ctx);
    } catch (err) {
      logError("admin_shift_day_root", err);
    }
  });

  bot.action("admin_shift_day_list", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      await showDayList(ctx);
    } catch (err) {
      logError("admin_shift_day_list", err);
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
}

module.exports = { registerAdminShiftSettings };
