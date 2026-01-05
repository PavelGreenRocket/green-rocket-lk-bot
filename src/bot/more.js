// src/bot/more.js

const { Markup } = require("telegraf");
const pool = require("../db/pool");
const { getUserState, setUserState, clearUserState } = require("./state");

const PASSWORD = "GR";
const MODE = "more_password";
const MODE_DELETE_USERS = "more_delete_users";
const MODE_DELETE_CANDIDATES = "more_delete_candidates"; // на будущее, для кандидатов

// В памяти храним, кто уже ввёл правильный пароль
const moreAccess = new Map(); // tgId -> true

function getDeleteUsersState(tgId) {
  const st = getUserState(tgId);
  return st && st.mode === MODE_DELETE_USERS ? st : null;
}

function setDeleteUsersState(tgId, patch) {
  const prev = getDeleteUsersState(tgId) || {
    mode: MODE_DELETE_USERS,
    selectedIds: [],
    step: "list",
  };
  setUserState(tgId, { ...prev, ...patch });
}

function clearDeleteUsersState(tgId) {
  const st = getDeleteUsersState(tgId);
  if (st) clearUserState(tgId);
}

function hasMoreAccess(tgId) {
  return moreAccess.get(tgId) === true;
}

function grantMoreAccess(tgId) {
  moreAccess.set(tgId, true);
}

// state только для ввода пароля
function getPasswordState(tgId) {
  const st = getUserState(tgId);
  return st && st.mode === MODE ? st : null;
}

function setPasswordState(tgId, step) {
  setUserState(tgId, { mode: MODE, step });
}

function clearPasswordState(tgId) {
  const st = getUserState(tgId);
  if (st && st.mode === MODE) {
    clearUserState(tgId);
  }
}

// ---------- Общие экраны ----------

function mdEscape(value, fallback = "не указано") {
  if (!value) return fallback;
  return String(value).replace(/([_*\[\]()~`>#+\-=|{}.!])/g, "\\$1");
}

async function showMoreMenu(ctx, user) {
  const text =
    "🔧 *Дополнительные настройки (только для тестов)*\n\n" +
    `Текущий пользователь:\n` +
    `• id: ${user.id}\n` +
    `• Имя: ${mdEscape(user.full_name, "не указано")}\n` +
    `• Роль: ${mdEscape(user.role)}\n` +
    `• Статус: ${mdEscape(user.staff_status)}\n` +
    `• Должность: ${mdEscape(user.position)}\n\n` +
    "Выбери раздел:";

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("🔄 Роль / статус / должность", "lk_more_roles")],
    [Markup.button.callback("🗑️ Удалить пользователей", "lk_more_delete")],
    [
      Markup.button.callback(
        "🗑️ Кандидаты / стажёры без привязки",
        "lk_more_delete_candidates"
      ),
    ],
    [Markup.button.callback("⬅️ В меню", "lk_main_menu")],
  ]);

  if (ctx.updateType === "callback_query") {
    await ctx
      .editMessageText(text, { ...keyboard })
      .catch(async () => ctx.reply(text, { ...keyboard }));
  } else {
    await ctx.reply(text, { parse_mode: "Markdown", ...keyboard });
  }
}

function getDeleteCandidatesState(tgId) {
  const st = getUserState(tgId);
  return st && st.mode === MODE_DELETE_CANDIDATES ? st : null;
}

function setDeleteCandidatesState(tgId, patch) {
  const prev = getDeleteCandidatesState(tgId) || {
    mode: MODE_DELETE_CANDIDATES,
    selectedIds: [],
    step: "list",
  };
  setUserState(tgId, { ...prev, ...patch });
}

function clearDeleteCandidatesState(tgId) {
  const st = getDeleteCandidatesState(tgId);
  if (st) clearUserState(tgId);
}

async function showDeleteCandidatesMenu(ctx) {
  const tgId = ctx.from.id;
  const st = getDeleteCandidatesState(tgId) || {
    mode: MODE_DELETE_CANDIDATES,
    selectedIds: [],
    step: "list",
  };
  const selectedIds = st.selectedIds || [];

  const res = await pool.query(
    `
      SELECT c.id,
             c.name,
             c.status,
             c.created_at,
             c.age,
             c.phone
      FROM candidates c
      WHERE NOT EXISTS (
              SELECT 1
              FROM users u
              WHERE u.candidate_id = c.id
            )
      ORDER BY c.created_at DESC
      LIMIT 50
    `
  );

  const rows = res.rows;

  let text =
    "🗑️ *Кандидаты / стажёры без привязки к пользователям*\n\n" +
    "Здесь можно полностью удалить кандидатов, у которых нет привязанного пользователя ЛК.\n" +
    "1) Нажимай на кандидатов — они будут помечаться красным крестиком.\n" +
    "2) Нажми «✅ Удалить выбранных», чтобы удалить их со всеми данными.\n\n";

  if (!rows.length) {
    text += "_Таких кандидатов сейчас нет._";
  } else {
    text += "Последние кандидаты:\n";
    for (const c of rows) {
      const mark = selectedIds.includes(c.id) ? "❌" : "  ";
      const created = c.created_at ? new Date(c.created_at) : null;
      let dateLabel = "";
      if (created && !Number.isNaN(created.getTime())) {
        const dd = String(created.getDate()).padStart(2, "0");
        const mm = String(created.getMonth() + 1).padStart(2, "0");
        dateLabel = `${dd}.${mm}`;
      }
      const agePart = c.age ? ` (${c.age})` : "";
      const phonePart = c.phone ? ` ${c.phone}` : "";
      text += `${mark} [${c.id}] ${dateLabel} ${
        c.name || "Без имени"
      }${agePart}${phonePart} — ${c.status}\n`;
    }
  }

  const buttons = rows.map((c) => {
    const selected = selectedIds.includes(c.id);
    const mark = selected ? "❌" : " ";
    const created = c.created_at ? new Date(c.created_at) : null;
    let dateLabel = "";
    if (created && !Number.isNaN(created.getTime())) {
      const dd = String(created.getDate()).padStart(2, "0");
      const mm = String(created.getMonth() + 1).padStart(2, "0");
      dateLabel = `${dd}.${mm}`;
    }
    const agePart = c.age ? ` (${c.age})` : "";
    const phonePart = c.phone ? ` ${c.phone}` : "";
    const label = `${mark} ${dateLabel} ${
      c.name || "Без имени"
    }${agePart}${phonePart} [${c.id}]`;

    return [Markup.button.callback(label, `lk_more_del_cand_toggle_${c.id}`)];
  });

  if (rows.length) {
    const allSelected = rows.every((c) => selectedIds.includes(c.id));
    buttons.push([
      Markup.button.callback(
        allSelected ? "📋 Снять выделение" : "📋 Выбрать всех",
        "lk_more_del_cand_select_all"
      ),
    ]);
  }

  if (selectedIds.length) {
    buttons.push([
      Markup.button.callback(
        `✅ Удалить выбранных (${selectedIds.length})`,
        "lk_more_del_cand_confirm"
      ),
    ]);
  }

  buttons.push([Markup.button.callback("⬅️ Назад", "lk_more_menu")]);

  const keyboard = Markup.inlineKeyboard(buttons);

  await ctx
    .editMessageText(text, { ...keyboard })
    .catch(async () => ctx.reply(text, { ...keyboard }));
}

// ---------- Экран изменения роли / статуса / должности ----------

async function showRoleStatusPositionMenu(ctx, user) {
  const text =
    "🔄 *Роль / статус / должность*\n\n" +
    `Сейчас:\n` +
    `• Роль: ${user.role || "не указана"}\n` +
    `• Статус: ${user.staff_status || "не указан"}\n` +
    `• Должность: ${user.position || "не указана"}\n\n` +
    "Что хочешь изменить?";

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("Роль", "lk_more_change_role")],
    [Markup.button.callback("Статус", "lk_more_change_status")],
    [Markup.button.callback("Должность", "lk_more_change_position")],
    [Markup.button.callback("⬅️ Назад", "lk_more_menu")],
  ]);

  await ctx
    .editMessageText(text, { ...keyboard })
    .catch(async () => ctx.reply(text, { ...keyboard }));
}

// --- выбор роли
async function showRoleChooser(ctx, user) {
  const text =
    "Выбери *новую роль* для себя.\n\n" +
    "_Внимание_: не забывай потом возвращать роль в нормальное значение.";

  const roles = ["super_admin", "admin", "user"];
  const buttons = roles.map((r) => [
    Markup.button.callback(
      `${r === user.role ? "✅" : " "} ${r}`,
      `lk_more_set_role_${r}`
    ),
  ]);

  buttons.push([Markup.button.callback("⬅️ Назад", "lk_more_roles")]);

  const keyboard = Markup.inlineKeyboard(buttons);

  await ctx
    .editMessageText(text, { ...keyboard })
    .catch(async () => ctx.reply(text, { ...keyboard }));
}

// --- выбор staff_status
async function showStatusChooser(ctx, user) {
  const text =
    "Выбери *новый статус* (staff_status) для себя.\n\n" +
    "Это влияет на то, как ЛК показывает тебе интерфейс.";

  const statuses = ["candidate", "intern", "worker", "none"];
  const current = user.staff_status || "none";

  const buttons = statuses.map((s) => {
    const label = s === "none" ? "— (пусто)" : s;
    const mark = s === current ? "✅" : " ";
    return [
      Markup.button.callback(`${mark} ${label}`, `lk_more_set_status_${s}`),
    ];
  });

  buttons.push([Markup.button.callback("⬅️ Назад", "lk_more_roles")]);

  const keyboard = Markup.inlineKeyboard(buttons);

  await ctx
    .editMessageText(text, { ...keyboard })
    .catch(async () => ctx.reply(text, { ...keyboard }));
}

// --- выбор position
async function showPositionChooser(ctx, user) {
  const text =
    "Выбери *новую должность* (position) для себя.\n\n" +
    "Список должностей примерный, используй то, что удобно для тестов.";

  const positions = [
    "barista",
    "point_admin",
    "senior_admin",
    "quality_manager",
    "manager",
    "none",
  ];
  const current = user.position || "none";

  const buttons = positions.map((p) => {
    const label = p === "none" ? "— (пусто)" : p;
    const mark = p === current ? "✅" : " ";
    return [
      Markup.button.callback(`${mark} ${label}`, `lk_more_set_position_${p}`),
    ];
  });

  buttons.push([Markup.button.callback("⬅️ Назад", "lk_more_roles")]);

  const keyboard = Markup.inlineKeyboard(buttons);

  await ctx
    .editMessageText(text, { ...keyboard })
    .catch(async () => ctx.reply(text, { ...keyboard }));
}

// ---------- Экран удаления пользователей ----------

async function showDeleteUsersMenu(ctx, currentUser) {
  const tgId = ctx.from.id;
  const st = getDeleteUsersState(tgId) || {
    mode: MODE_DELETE_USERS,
    selectedIds: [],
    step: "list",
  };
  const selectedIds = st.selectedIds || [];

  // последние 30 пользователей кроме супер-админов и самого себя
  const res = await pool.query(
    `
      SELECT id, full_name, role, staff_status
      FROM users
      WHERE id <> $1
        AND role <> 'super_admin'
      ORDER BY id DESC
      LIMIT 30
    `,
    [currentUser.id]
  );

  const users = res.rows;

  let text =
    "🗑️ *Удаление пользователей*\n\n" +
    "Здесь можно быстро пометить тестовых пользователей на удаление.\n" +
    "1) Нажимай на пользователей — они будут отмечаться красным крестиком.\n" +
    "2) Когда выберешь нужных — нажми «✅ Удалить выбранных».\n\n";

  if (!users.length) {
    text +=
      "_Пользователей для удаления не найдено (кроме тебя и супер-админов)._";
  } else {
    text += "Последние пользователи:\n";
    for (const u of users) {
      const mark = selectedIds.includes(u.id) ? "❌" : "  ";
      text += `${mark} id: ${u.id}, ${u.full_name || "Без имени"} (${
        u.role || "-"
      }/${u.staff_status || "-"})\n`;
    }
  }

  const buttons = users.map((u) => {
    const selected = selectedIds.includes(u.id);
    const mark = selected ? "❌" : " ";
    const label = `${mark} ${u.full_name || "Без имени"} [${u.id}] (${
      u.role || "-"
    }/${u.staff_status || "-"})`;
    return [
      Markup.button.callback(
        label,
        `lk_more_del_toggle_${u.id}` // просто переключение отметки
      ),
    ];
  });

  if (users.length) {
    const allSelected = users.every((u) => selectedIds.includes(u.id));
    buttons.push([
      Markup.button.callback(
        allSelected ? "📋 Снять выделение" : "📋 Выбрать всех",
        "lk_more_del_select_all"
      ),
    ]);
  }

  if (selectedIds.length) {
    buttons.push([
      Markup.button.callback(
        `✅ Удалить выбранных (${selectedIds.length})`,
        "lk_more_del_confirm"
      ),
    ]);
  }

  buttons.push([Markup.button.callback("⬅️ Назад", "lk_more_menu")]);

  const keyboard = Markup.inlineKeyboard(buttons);

  await ctx
    .editMessageText(text, { ...keyboard })
    .catch(async () => ctx.reply(text, { ...keyboard }));
}

// ---------- Регистрация всех хендлеров ----------

function registerMore(bot, ensureUser, logError) {
  // /more — входная точка
  bot.command("more", async (ctx) => {
    try {
      const tgId = ctx.from.id;
      const user = await ensureUser(ctx);
      if (!user) return;

      if (!hasMoreAccess(tgId)) {
        // просим пароль
        setPasswordState(tgId, "await_password");
        await ctx.reply(
          "🔐 Введите пароль для доступа к дополнительным настройкам:"
        );
        return;
      }

      await showMoreMenu(ctx, user);
    } catch (err) {
      logError("lk_more_cmd", err);
    }
  });

  // из других частей бота можно будет вызывать через callback
  bot.action("lk_more_menu", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      if (!hasMoreAccess(ctx.from.id)) {
        await ctx.reply("Нет доступа. Введи команду /more и пароль.");
        return;
      }
      await showMoreMenu(ctx, user);
    } catch (err) {
      logError("lk_more_menu", err);
    }
  });

  // обработка ввода пароля
  bot.on("text", async (ctx, next) => {
    const tgId = ctx.from.id;
    const st = getPasswordState(tgId);
    if (!st || st.step !== "await_password") return next();

    try {
      const pwd = (ctx.message.text || "").trim();
      if (pwd !== PASSWORD) {
        await ctx.reply(
          "❌ Неверный пароль. Попробуйте ещё раз или отправьте /more заново."
        );
        clearPasswordState(tgId);
        return;
      }

      grantMoreAccess(tgId);
      clearPasswordState(tgId);

      const user = await ensureUser(ctx);
      if (!user) return;

      await ctx.reply("✅ Доступ к дополнительным настройкам открыт.");
      await showMoreMenu(ctx, user);
    } catch (err) {
      logError("lk_more_password", err);
      clearPasswordState(tgId);
    }
  });

  // --- Роль / статус / должность ---

  bot.action("lk_more_roles", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      if (!hasMoreAccess(ctx.from.id)) {
        await ctx.reply("Нет доступа. Введи команду /more и пароль.");
        return;
      }
      await showRoleStatusPositionMenu(ctx, user);
    } catch (err) {
      logError("lk_more_roles", err);
    }
  });

  bot.action("lk_more_change_role", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      if (!hasMoreAccess(ctx.from.id)) {
        await ctx.reply("Нет доступа. Введи команду /more и пароль.");
        return;
      }
      await showRoleChooser(ctx, user);
    } catch (err) {
      logError("lk_more_change_role", err);
    }
  });

  bot.action("lk_more_change_status", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      if (!hasMoreAccess(ctx.from.id)) {
        await ctx.reply("Нет доступа. Введи команду /more и пароль.");
        return;
      }
      await showStatusChooser(ctx, user);
    } catch (err) {
      logError("lk_more_change_status", err);
    }
  });

  bot.action("lk_more_change_position", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      if (!hasMoreAccess(ctx.from.id)) {
        await ctx.reply("Нет доступа. Введи команду /more и пароль.");
        return;
      }
      await showPositionChooser(ctx, user);
    } catch (err) {
      logError("lk_more_change_position", err);
    }
  });

  // установка роли
  bot.action(/^lk_more_set_role_(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const newRole = ctx.match[1];
      const user = await ensureUser(ctx);
      if (!user) return;
      if (!hasMoreAccess(ctx.from.id)) {
        await ctx.reply("Нет доступа. Введи команду /more и пароль.");
        return;
      }

      await pool.query("UPDATE users SET role = $1 WHERE id = $2", [
        newRole,
        user.id,
      ]);

      const updated = { ...user, role: newRole };
      await showRoleStatusPositionMenu(ctx, updated);
    } catch (err) {
      logError("lk_more_set_role", err);
    }
  });

  // установка staff_status
  bot.action(/^lk_more_set_status_(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      let newStatus = ctx.match[1];
      if (newStatus === "none") newStatus = null;

      const user = await ensureUser(ctx);
      if (!user) return;
      if (!hasMoreAccess(ctx.from.id)) {
        await ctx.reply("Нет доступа. Введи команду /more и пароль.");
        return;
      }

      await pool.query("UPDATE users SET staff_status = $1 WHERE id = $2", [
        newStatus,
        user.id,
      ]);

      const updated = { ...user, staff_status: newStatus };
      await showRoleStatusPositionMenu(ctx, updated);
    } catch (err) {
      logError("lk_more_set_status", err);
    }
  });

  // установка должности
  bot.action(/^lk_more_set_position_(.+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      let newPos = ctx.match[1];
      if (newPos === "none") newPos = null;

      const user = await ensureUser(ctx);
      if (!user) return;
      if (!hasMoreAccess(ctx.from.id)) {
        await ctx.reply("Нет доступа. Введи команду /more и пароль.");
        return;
      }

      await pool.query("UPDATE users SET position = $1 WHERE id = $2", [
        newPos,
        user.id,
      ]);

      const updated = { ...user, position: newPos };
      await showRoleStatusPositionMenu(ctx, updated);
    } catch (err) {
      logError("lk_more_set_position", err);
    }
  });

  // --- Удаление пользователей ---

  bot.action("lk_more_delete", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      if (!hasMoreAccess(ctx.from.id)) {
        await ctx.reply("Нет доступа. Введи команду /more и пароль.");
        return;
      }

      setDeleteUsersState(ctx.from.id, { step: "list", selectedIds: [] });
      await showDeleteUsersMenu(ctx, user);
    } catch (err) {
      logError("lk_more_delete", err);
    }
  });

  bot.action(/^lk_more_del_toggle_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const targetId = Number(ctx.match[1]);
      const currentUser = await ensureUser(ctx);
      if (!currentUser) return;
      if (!hasMoreAccess(ctx.from.id)) {
        await ctx.reply("Нет доступа. Введи команду /more и пароль.");
        return;
      }

      const st = getDeleteUsersState(ctx.from.id) || {
        mode: MODE_DELETE_USERS,
        selectedIds: [],
        step: "list",
      };

      let selected = st.selectedIds || [];
      if (selected.includes(targetId)) {
        selected = selected.filter((id) => id !== targetId);
      } else {
        selected = [...selected, targetId];
      }

      setDeleteUsersState(ctx.from.id, { selectedIds: selected, step: "list" });
      await showDeleteUsersMenu(ctx, currentUser);
    } catch (err) {
      logError("lk_more_del_toggle", err);
    }
  });

  bot.action("lk_more_del_select_all", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const currentUser = await ensureUser(ctx);
      if (!currentUser) return;
      if (!hasMoreAccess(ctx.from.id)) {
        await ctx.reply("Нет доступа. Введи команду /more и пароль.");
        return;
      }

      // вытаскиваем тот же список, что и в showDeleteUsersMenu
      const res = await pool.query(
        `
        SELECT id
        FROM users
        WHERE id <> $1
          AND role <> 'super_admin'
        ORDER BY id DESC
        LIMIT 30
      `,
        [currentUser.id]
      );
      const users = res.rows;

      const st = getDeleteUsersState(ctx.from.id) || {
        mode: MODE_DELETE_USERS,
        selectedIds: [],
        step: "list",
      };

      const allSelected = users.length
        ? users.every((u) => st.selectedIds?.includes(u.id))
        : false;

      const newSelected = allSelected ? [] : users.map((u) => u.id);

      setDeleteUsersState(ctx.from.id, {
        selectedIds: newSelected,
        step: "list",
      });

      await showDeleteUsersMenu(ctx, currentUser);
    } catch (err) {
      logError("lk_more_del_select_all", err);
    }
  });

  bot.action("lk_more_del_confirm", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const currentUser = await ensureUser(ctx);
      if (!currentUser) return;
      if (!hasMoreAccess(ctx.from.id)) {
        await ctx.reply("Нет доступа. Введи команду /more и пароль.");
        return;
      }

      const st = getDeleteUsersState(ctx.from.id);
      const selected = (st && st.selectedIds) || [];
      if (!selected.length) {
        await ctx.reply("Никто не выбран для удаления.");
        return;
      }

      setDeleteUsersState(ctx.from.id, { step: "confirm" });

      const text =
        "⚠️ *Подтверждение удаления*\n\n" +
        `Будут удалены пользователи: ${selected.join(", ")}.\n\n` +
        "Если среди них есть пользователи с привязанными данными, их удалить не получится — бот покажет это отдельно.\n\n" +
        "Продолжить?";

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "🔥 Подтвердить удаление",
            "lk_more_del_confirm_yes"
          ),
        ],
        [Markup.button.callback("⬅️ Отмена", "lk_more_delete")],
      ]);

      await ctx
        .editMessageText(text, { ...keyboard })
        .catch(async () => ctx.reply(text, { ...keyboard }));
    } catch (err) {
      logError("lk_more_del_confirm", err);
    }
  });

  bot.action("lk_more_del_confirm_yes", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const currentUser = await ensureUser(ctx);
      if (!currentUser) return;
      if (!hasMoreAccess(ctx.from.id)) {
        await ctx.reply("Нет доступа. Введи команду /more и пароль.");
        return;
      }

      const st = getDeleteUsersState(ctx.from.id);
      const selected = (st && st.selectedIds) || [];
      if (!selected.length) {
        await ctx.reply("Никто не выбран для удаления.");
        return;
      }

      const ok = [];
      const failed = [];

      for (const id of selected) {
        if (id === currentUser.id) {
          failed.push({ id, reason: "самого себя нельзя удалить" });
          continue;
        }

        const res = await pool.query(
          "SELECT id, full_name, role FROM users WHERE id = $1",
          [id]
        );
        if (!res.rows.length) {
          failed.push({ id, reason: "не найден" });
          continue;
        }
        const userRow = res.rows[0];
        if (userRow.role === "super_admin") {
          failed.push({ id, reason: "super_admin" });
          continue;
        }

        try {
          // --- МЯГКИЙ КАСКАД УДАЛЕНИЯ СВЯЗАННЫХ ДАННЫХ ---

          // логи ИИ
          await pool.query("DELETE FROM ai_chat_logs WHERE user_id = $1", [id]);

          // уведомления пользователю
          await pool.query(
            "DELETE FROM user_notifications WHERE user_id = $1",
            [id]
          );

          // статусы по аттестациям / блокировкам
          await pool.query(
            "DELETE FROM user_attestation_status WHERE user_id = $1",
            [id]
          );
          await pool.query("DELETE FROM user_block_status WHERE user_id = $1", [
            id,
          ]);

          // тесты
          await pool.query(
            `
            DELETE FROM test_session_answers
            WHERE session_id IN (
              SELECT id FROM test_sessions WHERE user_id = $1
            )
          `,
            [id]
          );
          await pool.query("DELETE FROM test_sessions WHERE user_id = $1", [
            id,
          ]);

          // стажировки
          await pool.query(
            `
            DELETE FROM internship_step_results
            WHERE session_id IN (
              SELECT id FROM internship_sessions WHERE user_id = $1
            )
          `,
            [id]
          );
          await pool.query(
            "DELETE FROM internship_sessions WHERE user_id = $1",
            [id]
          );

          // админ-логи (на всякий случай, если этот юзер был админом при тестах)
          await pool.query(
            "DELETE FROM admin_action_logs WHERE admin_id = $1",
            [id]
          );

          // если этот пользователь где-то стоит ответственным по стажировке/кандидатам — обнулим ссылки
          await pool.query(
            `
            UPDATE candidates
               SET admin_id = NULL
             WHERE admin_id = $1
          `,
            [id]
          );
          await pool.query(
            `
            UPDATE candidates
               SET internship_admin_id = NULL
             WHERE internship_admin_id = $1
          `,
            [id]
          );
          await pool.query(
            `
            UPDATE candidates
               SET closed_by_admin_id = NULL
             WHERE closed_by_admin_id = $1
          `,
            [id]
          );

          // если у пользователя был привязан кандидат — не трогаем кандидата,
          // но обнулим candidate_id, чтобы не было "висячей" ссылки в других местах
          await pool.query(
            "UPDATE users SET candidate_id = NULL WHERE id = $1",
            [id]
          );

          // если пользователь указан в отчётах как "кто делал инкассацию" — обнуляем ссылку
          await pool.query(
            `
  UPDATE shift_closings
     SET cash_collection_by_user_id = NULL
   WHERE cash_collection_by_user_id = $1
  `,
            [id]
          );

          // уведомления, которые создавал этот пользователь — отвязываем автора
          await pool.query(
            "UPDATE notifications SET created_by = NULL WHERE created_by = $1",
            [id]
          );

          // --- и только теперь пробуем удалить самого пользователя ---
          await pool.query("DELETE FROM users WHERE id = $1", [id]);

          // записи онбординга / ожидания, привязанные к этому пользователю
          await pool.query(
            "DELETE FROM lk_waiting_users WHERE linked_user_id = $1",
            [id]
          );

          ok.push({ id, name: userRow.full_name });
        } catch (e) {
          console.error("Failed to delete user", id, e); // лог в консоль

          failed.push({
            id,
            name: userRow.full_name,
            reason: e.detail || e.message || "есть связанные данные в базе",
          });
        }
      }

      clearDeleteUsersState(ctx.from.id);

      let text = "Результат удаления пользователей:\n\n";
      if (ok.length) {
        text += "✅ Удалены:\n";
        for (const u of ok) {
          text += `• ${u.name || "без имени"} [${u.id}]\n`;
        }
        text += "\n";
      }
      if (failed.length) {
        text += "❌ Не удалось удалить:\n";
        for (const u of failed) {
          text += `• [${u.id}] ${u.name || ""} — ${u.reason}\n`;
        }
        text += "\n";
      }

      await ctx.reply(text);

      // возвращаемся к экрану удаления с обновлённым списком
      await showDeleteUsersMenu(ctx, currentUser);
    } catch (err) {
      logError("lk_more_del_confirm_yes", err);
    }
  });

  bot.action("lk_more_delete_candidates", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      if (!hasMoreAccess(ctx.from.id)) {
        await ctx.reply("Нет доступа. Введи команду /more и пароль.");
        return;
      }

      setDeleteCandidatesState(ctx.from.id, { step: "list", selectedIds: [] });
      await showDeleteCandidatesMenu(ctx);
    } catch (err) {
      logError("lk_more_delete_candidates", err);
    }
  });

  bot.action(/^lk_more_del_cand_toggle_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const candId = Number(ctx.match[1]);
      const user = await ensureUser(ctx);
      if (!user) return;
      if (!hasMoreAccess(ctx.from.id)) {
        await ctx.reply("Нет доступа. Введи команду /more и пароль.");
        return;
      }

      const st = getDeleteCandidatesState(ctx.from.id) || {
        mode: MODE_DELETE_CANDIDATES,
        selectedIds: [],
        step: "list",
      };
      let selected = st.selectedIds || [];
      if (selected.includes(candId)) {
        selected = selected.filter((id) => id !== candId);
      } else {
        selected = [...selected, candId];
      }

      setDeleteCandidatesState(ctx.from.id, {
        selectedIds: selected,
        step: "list",
      });
      await showDeleteCandidatesMenu(ctx);
    } catch (err) {
      logError("lk_more_del_cand_toggle", err);
    }
  });

  bot.action("lk_more_del_cand_select_all", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      if (!hasMoreAccess(ctx.from.id)) {
        await ctx.reply("Нет доступа. Введи команду /more и пароль.");
        return;
      }

      const res = await pool.query(
        `
        SELECT id
        FROM candidates c
        WHERE NOT EXISTS (
                SELECT 1
                FROM users u
                WHERE u.candidate_id = c.id
              )
        ORDER BY c.created_at DESC
        LIMIT 50
      `
      );
      const rows = res.rows;

      const st = getDeleteCandidatesState(ctx.from.id) || {
        mode: MODE_DELETE_CANDIDATES,
        selectedIds: [],
        step: "list",
      };

      const allSelected = rows.length
        ? rows.every((c) => st.selectedIds?.includes(c.id))
        : false;

      const newSelected = allSelected ? [] : rows.map((c) => c.id);

      setDeleteCandidatesState(ctx.from.id, {
        selectedIds: newSelected,
        step: "list",
      });

      await showDeleteCandidatesMenu(ctx);
    } catch (err) {
      logError("lk_more_del_cand_select_all", err);
    }
  });

  bot.action("lk_more_del_cand_confirm", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      if (!hasMoreAccess(ctx.from.id)) {
        await ctx.reply("Нет доступа. Введи команду /more и пароль.");
        return;
      }

      const st = getDeleteCandidatesState(ctx.from.id);
      const selected = (st && st.selectedIds) || [];
      if (!selected.length) {
        await ctx.reply("Никто не выбран для удаления.");
        return;
      }

      setDeleteCandidatesState(ctx.from.id, { step: "confirm" });

      const text =
        "⚠️ *Подтверждение удаления кандидатов*\n\n" +
        `Будут удалены кандидаты: ${selected.join(", ")}.\n\n` +
        "Они будут полностью удалены вместе со всей информацией по собеседованиям/стажировке.\n\n" +
        "Продолжить?";

      const keyboard = Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "🔥 Подтвердить удаление",
            "lk_more_del_cand_confirm_yes"
          ),
        ],
        [Markup.button.callback("⬅️ Отмена", "lk_more_delete_candidates")],
      ]);

      await ctx
        .editMessageText(text, { ...keyboard })
        .catch(async () => ctx.reply(text, { ...keyboard }));
    } catch (err) {
      logError("lk_more_del_cand_confirm", err);
    }
  });

  bot.action("lk_more_del_cand_confirm_yes", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;
      if (!hasMoreAccess(ctx.from.id)) {
        await ctx.reply("Нет доступа. Введи команду /more и пароль.");
        return;
      }

      const st = getDeleteCandidatesState(ctx.from.id);
      const selected = (st && st.selectedIds) || [];
      if (!selected.length) {
        await ctx.reply("Никто не выбран для удаления.");
        return;
      }

      const ok = [];
      const failed = [];

      for (const id of selected) {
        const res = await pool.query(
          "SELECT id, name FROM candidates WHERE id = $1",
          [id]
        );
        if (!res.rows.length) {
          failed.push({ id, reason: "не найден" });
          continue;
        }
        try {
          await pool.query("DELETE FROM candidates WHERE id = $1", [id]);
          ok.push({ id, name: res.rows[0].name });
        } catch (e) {
          failed.push({
            id,
            name: res.rows[0].name,
            reason: "есть связанные данные в базе",
          });
        }
      }

      clearDeleteCandidatesState(ctx.from.id);

      let text = "Результат удаления кандидатов:\n\n";
      if (ok.length) {
        text += "✅ Удалены:\n";
        for (const c of ok) {
          text += `• ${c.name || "без имени"} [${c.id}]\n`;
        }
        text += "\n";
      }
      if (failed.length) {
        text += "❌ Не удалось удалить:\n";
        for (const c of failed) {
          text += `• [${c.id}] ${c.name || ""} — ${c.reason}\n`;
        }
        text += "\n";
      }

      await ctx.reply(text);
      await showDeleteCandidatesMenu(ctx);
    } catch (err) {
      logError("lk_more_del_cand_confirm_yes", err);
    }
  });
}

module.exports = {
  registerMore,
};
