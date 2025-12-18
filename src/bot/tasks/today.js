// src/bot/tasks/today.js
const { Markup } = require("telegraf");
const pool = require("../../db/pool");
const { deliver } = require("../../utils/renderHelpers");
const { getUserState, setUserState, clearUserState } = require("../state");

const MODE = "lk_task_answer";

function getTaskState(tgId) {
  const st = getUserState(tgId);
  return st && st.mode === MODE ? st : null;
}

function setTaskState(tgId, patch) {
  const prev = getTaskState(tgId) || { mode: MODE, step: "idle" };
  setUserState(tgId, { ...prev, ...patch });
}

function clearTaskState(tgId) {
  const st = getTaskState(tgId);
  if (st) clearUserState(tgId);
}

// weekday bit: Mon=1<<0 ... Sun=1<<6
function weekdayBit(d) {
  const js = d.getDay(); // 0=Sun..6=Sat
  if (js === 0) return 1 << 6; // Sun
  return 1 << (js - 1); // Mon->0 ... Sat->5
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

async function getActiveShiftForUser(userId) {
  const res = await pool.query(
    `
      SELECT id, trade_point_id
      FROM shifts
      WHERE user_id = $1
        AND opened_at::date = CURRENT_DATE
        AND status IN ('opening_in_progress','opened')
      ORDER BY opened_at DESC
      LIMIT 1
    `,
    [userId]
  );
  return res.rows[0] || null;
}

function scheduleMatchesToday(row, today, todayDateObj) {
  if (row.schedule_type === "single") {
    return row.single_date === today;
  }
  if (row.schedule_type === "weekly") {
    const bit = weekdayBit(todayDateObj);
    const mask = Number(row.weekdays_mask || 0);
    return (mask & bit) !== 0;
  }
  if (row.schedule_type === "every_x_days") {
    const x = Number(row.every_x_days || 0);
    if (!x || !row.start_date) return false;
    const start = new Date(row.start_date);
    const diffMs = todayDateObj.getTime() - start.getTime();
    const diffDays = Math.floor(diffMs / (24 * 3600 * 1000));
    return diffDays >= 0 && diffDays % x === 0;
  }
  return false;
}

function escHtml(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function ensureTodayInstances(user, shift) {
  const today = todayISO();
  const todayObj = new Date(today + "T00:00:00");

  // targets for individual
  const tgtRes = await pool.query(
    `SELECT assignment_id FROM task_assignment_targets WHERE user_id = $1`,
    [user.id]
  );
  const targetSet = new Set(tgtRes.rows.map((r) => Number(r.assignment_id)));

  // load active assignments + schedules + templates
  const asgRes = await pool.query(
    `
      SELECT
        a.id AS assignment_id,
        a.task_type,
        a.template_id,
        a.point_scope,
        a.trade_point_id,
        s.schedule_type,
        s.start_date,
        s.single_date,
        s.weekdays_mask,
        s.every_x_days,
        s.time_mode,
        s.deadline_time,
        t.title,
        t.answer_type
      FROM task_assignments a
      JOIN task_schedules s ON s.assignment_id = a.id
      JOIN task_templates t ON t.id = a.template_id
      WHERE a.is_active = TRUE
    `
  );

  for (const row of asgRes.rows) {
    const assignmentId = Number(row.assignment_id);

    // individual filter
    if (row.task_type === "individual" && !targetSet.has(assignmentId))
      continue;

    // point filter
    if (row.point_scope === "one_point") {
      if (!shift?.trade_point_id) continue;
      if (Number(row.trade_point_id) !== Number(shift.trade_point_id)) continue;
    }

    // schedule filter
    if (!scheduleMatchesToday(row, today, todayObj)) continue;

    // create instance if not exists
    await pool.query(
      `
        INSERT INTO task_instances
          (assignment_id, template_id, user_id, trade_point_id, for_date, time_mode, deadline_at, status)
        VALUES
          ($1, $2, $3, $4, $5, $6, NULL, 'open')
        ON CONFLICT (assignment_id, user_id, for_date) DO NOTHING
      `,
      [
        assignmentId,
        Number(row.template_id),
        user.id,
        shift?.trade_point_id || null,
        today,
        row.time_mode || "all_day",
      ]
    );
  }
}

async function loadTodayInstances(user) {
  const today = todayISO();
  const res = await pool.query(
    `
      SELECT
        ti.id,
        ti.status,
        ti.time_mode,
        ti.deadline_at,
        tt.title,
        tt.answer_type
      FROM task_instances ti
      JOIN task_templates tt ON tt.id = ti.template_id
      WHERE ti.user_id = $1
        AND ti.for_date = $2
      ORDER BY
        (ti.status = 'done') ASC,
        (ti.deadline_at IS NULL) ASC,
        ti.deadline_at NULLS LAST,
        ti.id ASC
    `,
    [user.id, today]
  );
  return res.rows;
}

function buildTasksText(rows) {
  let text = "📋 <b>Задачи на сегодня</b>\n\n";
  if (!rows.length) {
    text += "На сегодня задач нет ✅";
    return text;
  }

  rows.forEach((r, idx) => {
    const n = idx + 1;
    const done = r.status === "done";
    const title = escHtml(r.title || "Без названия");
    const line = done ? `✅ <s>${title}</s>` : `${n}. ${title}`;
    text += line + "\n";
  });

  return text;
}

function buildKeyboard(rows) {
  const kb = [];

  if (rows.length) {
    const btns = rows.map((r, idx) => {
      const n = idx + 1;
      const done = r.status === "done";
      const label = done ? `✅${n}` : `${n}`;
      return Markup.button.callback(label, `lk_task_open_${r.id}`);
    });

    // по 5 кнопок в ряд, чтобы не было гигантской простыни
    for (let i = 0; i < btns.length; i += 5) kb.push(btns.slice(i, i + 5));
  }

  kb.push([Markup.button.callback("⬅️ В меню", "lk_main_menu")]);
  return Markup.inlineKeyboard(kb);
}

async function showTodayTasks(ctx, user) {
  const shift = await getActiveShiftForUser(user.id).catch(() => null);

  // если хочешь строго: "задачи доступны только после открытия смены" — раскомментируй:
  // if (!shift) {
  //   await deliver(ctx, {
  //     text: "Сначала открой смену, чтобы увидеть задачи.",
  //     extra: Markup.inlineKeyboard([[Markup.button.callback("⬅️ В меню", "lk_main_menu")]])
  //   }, { edit: true });
  //   return;
  // }

  await ensureTodayInstances(user, shift);

  const rows = await loadTodayInstances(user);
  const text = buildTasksText(rows);
  const keyboard = buildKeyboard(rows);

  await deliver(ctx, { text, extra: keyboard }, { edit: true });
}

function askForAnswerText(answerType, title) {
  if (answerType === "photo")
    return `📷 <b>${escHtml(
      title
    )}</b>\n\nПришлите <b>фото</b> для этой задачи.`;
  if (answerType === "video")
    return `🎥 <b>${escHtml(
      title
    )}</b>\n\nПришлите <b>видео</b> для этой задачи.`;
  if (answerType === "number")
    return `🔢 <b>${escHtml(title)}</b>\n\nВведите <b>число</b>.`;
  return `📝 <b>${escHtml(title)}</b>\n\nВведите <b>текст</b>.`;
}

async function markDoneWithAnswer(taskInstanceId, payload) {
  const { answerType } = payload;

  // insert answer
  await pool.query(
    `
      INSERT INTO task_instance_answers
        (task_instance_id, answer_text, answer_number, file_id, file_type)
      VALUES
        ($1, $2, $3, $4, $5)
    `,
    [
      taskInstanceId,
      answerType === "text" ? payload.text : null,
      answerType === "number" ? payload.number : null,
      answerType === "photo" || answerType === "video" ? payload.fileId : null,
      answerType === "photo" || answerType === "video" ? answerType : null,
    ]
  );

  // mark done
  await pool.query(
    `
      UPDATE task_instances
      SET status = 'done', done_at = NOW()
      WHERE id = $1
    `,
    [taskInstanceId]
  );
}

function registerTodayTasks(bot, ensureUser, logError) {
  // entry from menu
  bot.action("lk_tasks_today", async (ctx) => {
    try {
      const user = await ensureUser(ctx);
      if (!user) return;

      const staffStatus = user.staff_status || "worker";
      if (staffStatus === "candidate") {
        await ctx
          .answerCbQuery("Доступ появится после начала стажировки.", {
            show_alert: true,
          })
          .catch(() => {});
        return;
      }

      clearTaskState(ctx.from.id);
      await showTodayTasks(ctx, user);
    } catch (err) {
      logError("lk_tasks_today", err);
    }
  });

  // open task by number
  bot.action(/^lk_task_open_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const taskId = Number(ctx.match[1]);
      const res = await pool.query(
        `
          SELECT ti.id, ti.status, tt.title, tt.answer_type
          FROM task_instances ti
          JOIN task_templates tt ON tt.id = ti.template_id
          WHERE ti.id = $1 AND ti.user_id = $2
          LIMIT 1
        `,
        [taskId, user.id]
      );
      const row = res.rows[0];
      if (!row) {
        await ctx
          .answerCbQuery("Задача не найдена", { show_alert: true })
          .catch(() => {});
        return;
      }
      if (row.status === "done") {
        await ctx.answerCbQuery("Уже выполнено ✅").catch(() => {});
        return;
      }

      // switch to await answer
      setTaskState(ctx.from.id, {
        step: "await_answer",
        taskInstanceId: row.id,
        answerType: row.answer_type,
      });

      const text = askForAnswerText(row.answer_type, row.title);
      const keyboard = Markup.inlineKeyboard([
        [{ text: "⬅️ Назад к задачам", callback_data: "lk_tasks_today" }],
        [{ text: "❌ Отмена", callback_data: "lk_task_answer_cancel" }],
      ]);

      await deliver(ctx, { text, extra: keyboard }, { edit: true });
    } catch (err) {
      logError("lk_task_open", err);
    }
  });

  bot.action("lk_task_answer_cancel", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      clearTaskState(ctx.from.id);
      await deliver(
        ctx,
        {
          text: "Ок, отменено.",
          extra: Markup.inlineKeyboard([
            [{ text: "📋 Задачи", callback_data: "lk_tasks_today" }],
          ]),
        },
        { edit: true }
      );
    } catch (err) {
      logError("lk_task_answer_cancel", err);
    }
  });

  // handle TEXT/NUMBER answers
  bot.on("text", async (ctx, next) => {
    const st = getTaskState(ctx.from.id);
    if (!st || st.step !== "await_answer") return next();

    try {
      const user = await ensureUser(ctx);
      if (!user) return;

      const txt = (ctx.message.text || "").trim();
      if (!txt) return;

      if (st.answerType === "number") {
        const num = Number(txt.replace(",", "."));
        if (!Number.isFinite(num)) {
          await ctx.reply("❌ Нужно число. Пример: 12 или 12.5");
          return;
        }
        await markDoneWithAnswer(st.taskInstanceId, {
          answerType: "number",
          number: num,
        });
      } else if (st.answerType === "text") {
        await markDoneWithAnswer(st.taskInstanceId, {
          answerType: "text",
          text: txt,
        });
      } else {
        return next();
      }

      clearTaskState(ctx.from.id);
      await ctx.reply("✅ Принято!");
      // перерисуем список
      await showTodayTasks(ctx, user);
    } catch (err) {
      logError("lk_task_answer_text", err);
      await ctx.reply("❌ Не удалось сохранить ответ. Попробуйте ещё раз.");
    }
  });

  // handle PHOTO
  bot.on("photo", async (ctx, next) => {
    const st = getTaskState(ctx.from.id);
    if (!st || st.step !== "await_answer") return next();

    try {
      const user = await ensureUser(ctx);
      if (!user) return;

      if (st.answerType !== "photo") return next();

      const photos = ctx.message.photo || [];
      const best = photos[photos.length - 1];
      if (!best?.file_id) return next();

      await markDoneWithAnswer(st.taskInstanceId, {
        answerType: "photo",
        fileId: best.file_id,
      });

      clearTaskState(ctx.from.id);
      await ctx.reply("✅ Фото принято!");
      await showTodayTasks(ctx, user);
    } catch (err) {
      logError("lk_task_answer_photo", err);
      await ctx.reply("❌ Не удалось сохранить фото. Попробуйте ещё раз.");
    }
  });

  // handle VIDEO
  bot.on("video", async (ctx, next) => {
    const st = getTaskState(ctx.from.id);
    if (!st || st.step !== "await_answer") return next();

    try {
      const user = await ensureUser(ctx);
      if (!user) return;

      if (st.answerType !== "video") return next();

      const v = ctx.message.video;
      if (!v?.file_id) return next();

      await markDoneWithAnswer(st.taskInstanceId, {
        answerType: "video",
        fileId: v.file_id,
      });

      clearTaskState(ctx.from.id);
      await ctx.reply("✅ Видео принято!");
      await showTodayTasks(ctx, user);
    } catch (err) {
      logError("lk_task_answer_video", err);
      await ctx.reply("❌ Не удалось сохранить видео. Попробуйте ещё раз.");
    }
  });
}

module.exports = { registerTodayTasks, showTodayTasks };
