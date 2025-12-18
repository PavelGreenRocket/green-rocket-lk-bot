// src/bot/admin/tasks/create.js
const { Markup } = require("telegraf");
const pool = require("../../../db/pool");
const { deliver } = require("../../../utils/renderHelpers");

const createStates = new Map();

function getState(tgId) {
  return createStates.get(tgId) || null;
}
function setState(tgId, s) {
  createStates.set(tgId, s);
}
function clearState(tgId) {
  createStates.delete(tgId);
}

function isAdmin(user) {
  return user && (user.role === "admin" || user.role === "super_admin");
}

async function showStepType(ctx) {
  const text = "📝 <b>Создать задачу</b>\n\nКакая задача?";
  const keyboard = Markup.inlineKeyboard([
    [{ text: "👤 Индивидуальная", callback_data: "tcreate_type_individual" }],
    [{ text: "🌐 Общая (для всех)", callback_data: "tcreate_type_global" }],
    [{ text: "❌ Отмена", callback_data: "tcreate_cancel" }],
  ]);
  await deliver(ctx, { text, extra: keyboard }, { edit: true });
}

async function showStepUsers(ctx, selectedIds) {
  // минимально: показываем последние 20 сотрудников/стажёров
  const res = await pool.query(
    `
      SELECT id, full_name, staff_status
      FROM users
      WHERE staff_status IN ('intern','worker')
      ORDER BY full_name
      LIMIT 25
    `
  );

  const rows = res.rows;

  let text = "👥 <b>Выбор пользователей</b>\n";
  text += "Нажимай, чтобы отметить ✅\n\n";

  const buttons = [];
  for (const u of rows) {
    const checked = selectedIds.has(u.id) ? "✅ " : "";
    const status = u.staff_status === "intern" ? "🎓" : "👨‍💼";
    buttons.push([
      Markup.button.callback(
        `${checked}${status} ${u.full_name || "Без имени"}`,
        `tcreate_users_toggle_${u.id}`
      ),
    ]);
  }

  buttons.push([Markup.button.callback("➡️ Продолжить", "tcreate_users_done")]);
  buttons.push([Markup.button.callback("⬅️ Назад", "tcreate_users_back")]);
  buttons.push([Markup.button.callback("❌ Отмена", "tcreate_cancel")]);

  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(buttons) },
    { edit: true }
  );
}

async function showStepSource(ctx) {
  const text = "📌 <b>Откуда берём задачу?</b>";
  const keyboard = Markup.inlineKeyboard([
    [{ text: "➕ Новая задача", callback_data: "tcreate_source_new" }],
    [{ text: "📌 Сохранённая задача", callback_data: "tcreate_source_saved" }],
    [{ text: "⬅️ Назад", callback_data: "tcreate_source_back" }],
    [{ text: "❌ Отмена", callback_data: "tcreate_cancel" }],
  ]);
  await deliver(ctx, { text, extra: keyboard }, { edit: true });
}

function registerAdminTaskCreate(bot, ensureUser, logError) {
  // вход
  bot.action("admin_task_create", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      setState(ctx.from.id, {
        mode: "tcreate",
        step: "type",
        taskType: null, // individual/global
        selectedUserIds: [],
      });

      await showStepType(ctx);
    } catch (err) {
      logError("admin_task_create", err);
    }
  });

  // отмена
  bot.action("tcreate_cancel", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      clearState(ctx.from.id);
      // вернём в админ-меню
      await bot.telegram
        .editMessageText(
          ctx.chat.id,
          ctx.callbackQuery.message.message_id,
          undefined,
          "Ок, отменено.",
          { parse_mode: "HTML" }
        )
        .catch(() => {});
      // можно сразу открыть админ-меню:
      await ctx.telegram
        .sendMessage(ctx.chat.id, "Вернуться в админ-панель:", {
          reply_markup: Markup.inlineKeyboard([
            [{ text: "🛠 Админ-панель", callback_data: "lk_admin_menu" }],
          ]).reply_markup,
        })
        .catch(() => {});
    } catch (err) {
      logError("tcreate_cancel", err);
    }
  });

  // выбор типа
  bot.action("tcreate_type_individual", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getState(ctx.from.id);
      if (!st || st.mode !== "tcreate") return;

      st.step = "users";
      st.taskType = "individual";
      st.selectedUserIds = st.selectedUserIds || [];
      setState(ctx.from.id, st);

      await showStepUsers(ctx, new Set(st.selectedUserIds));
    } catch (err) {
      logError("tcreate_type_individual", err);
    }
  });

  bot.action("tcreate_type_global", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getState(ctx.from.id);
      if (!st || st.mode !== "tcreate") return;

      st.step = "source";
      st.taskType = "global";
      st.selectedUserIds = [];
      setState(ctx.from.id, st);

      await showStepSource(ctx);
    } catch (err) {
      logError("tcreate_type_global", err);
    }
  });

  // users: toggle
  bot.action(/^tcreate_users_toggle_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getState(ctx.from.id);
      if (!st || st.mode !== "tcreate" || st.step !== "users") return;

      const uid = Number(ctx.match[1]);
      const set = new Set(st.selectedUserIds || []);
      if (set.has(uid)) set.delete(uid);
      else set.add(uid);

      st.selectedUserIds = Array.from(set);
      setState(ctx.from.id, st);

      await showStepUsers(ctx, set);
    } catch (err) {
      logError("tcreate_users_toggle", err);
    }
  });

  bot.action("tcreate_users_back", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getState(ctx.from.id);
      if (!st || st.mode !== "tcreate") return;

      st.step = "type";
      st.taskType = null;
      st.selectedUserIds = [];
      setState(ctx.from.id, st);

      await showStepType(ctx);
    } catch (err) {
      logError("tcreate_users_back", err);
    }
  });

  bot.action("tcreate_users_done", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getState(ctx.from.id);
      if (!st || st.mode !== "tcreate" || st.step !== "users") return;

      if (!st.selectedUserIds || st.selectedUserIds.length === 0) {
        await ctx
          .answerCbQuery("Выбери хотя бы одного пользователя", {
            show_alert: true,
          })
          .catch(() => {});
        return;
      }

      st.step = "source";
      setState(ctx.from.id, st);

      await showStepSource(ctx);
    } catch (err) {
      logError("tcreate_users_done", err);
    }
  });

  // source step (пока заглушки экранов — дальше расширим)
  bot.action("tcreate_source_back", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getState(ctx.from.id);
      if (!st || st.mode !== "tcreate") return;

      if (st.taskType === "individual") {
        st.step = "users";
        setState(ctx.from.id, st);
        await showStepUsers(ctx, new Set(st.selectedUserIds || []));
      } else {
        st.step = "type";
        setState(ctx.from.id, st);
        await showStepType(ctx);
      }
    } catch (err) {
      logError("tcreate_source_back", err);
    }
  });

  bot.action("tcreate_source_new", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getState(ctx.from.id);
      if (!st || st.mode !== "tcreate" || st.step !== "source") return;

      // дальше будет: описание + answer_type + сохранить как шаблон
      await deliver(
        ctx,
        {
          text:
            "➕ <b>Новая задача</b>\n\n" +
            "Следующим шагом сделаем ввод описания и выбор типа ответа.\n" +
            "(я добавлю это в следующем куске кода)",
          extra: Markup.inlineKeyboard([
            [{ text: "⬅️ Назад", callback_data: "tcreate_source_back" }],
            [{ text: "❌ Отмена", callback_data: "tcreate_cancel" }],
          ]),
        },
        { edit: true }
      );
    } catch (err) {
      logError("tcreate_source_new", err);
    }
  });

  bot.action("tcreate_source_saved", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!isAdmin(user)) return;

      const st = getState(ctx.from.id);
      if (!st || st.mode !== "tcreate" || st.step !== "source") return;

      // дальше будет: список task_templates, выбор, затем расписание
      await deliver(
        ctx,
        {
          text:
            "📌 <b>Сохранённая задача</b>\n\n" +
            "Следующим шагом покажем список шаблонов из task_templates.\n" +
            "(я добавлю это в следующем куске кода)",
          extra: Markup.inlineKeyboard([
            [{ text: "⬅️ Назад", callback_data: "tcreate_source_back" }],
            [{ text: "❌ Отмена", callback_data: "tcreate_cancel" }],
          ]),
        },
        { edit: true }
      );
    } catch (err) {
      logError("tcreate_source_saved", err);
    }
  });
}

module.exports = { registerAdminTaskCreate };
