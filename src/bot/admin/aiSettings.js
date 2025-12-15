const { Markup } = require("telegraf");
const pool = require("../../db/pool");
const { deliver } = require("../../utils/renderHelpers");

// =======================
// STATE (только для админов)
// =======================
// tgId -> { step, section, entityId, tempTitle }
const stMap = new Map();

function getSt(tgId) {
  return stMap.get(tgId) || null;
}

function setSt(tgId, st) {
  stMap.set(tgId, st);
}

function clearSt(tgId) {
  stMap.delete(tgId);
}

// =======================
// HELPERS
// =======================
function isAdmin(u) {
  return u && (u.role === "admin" || u.role === "super_admin");
}

function safeTrim(s, max = 3500) {
  if (!s) return "";
  const t = String(s);
  return t.length > max ? t.slice(0, max - 3) + "..." : t;
}

async function getAdminsList(limit = 50) {
  const r = await pool.query(
    `
    SELECT id, full_name, "position", username, work_phone
    FROM users
    WHERE role IN ('admin','super_admin')
    ORDER BY full_name
    LIMIT $1
    `,
    [limit]
  );
  return r.rows;
}

// =======================
// RENDER: HOME
// =======================
async function renderHome(ctx, { edit = true } = {}) {
  const text = "🔮🔧 *Настройка ИИ*\n\n" + "Выберите раздел:";

  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "🔄📚🤖 Обновить/посмотреть теорию ИИ",
        "ai_cfg_theory"
      ),
    ],
    [Markup.button.callback("🔄🚫🤖 Обновить запреты", "ai_cfg_bans")],
    [
      Markup.button.callback(
        "🔄📞🤖 Обновить контактные данные",
        "ai_cfg_contacts"
      ),
    ],
    [Markup.button.callback("⬅️ Назад", "admin_settings")],
  ]);

  await deliver(
    ctx,
    { text, extra: { ...kb, parse_mode: "Markdown" } },
    { edit }
  );
}

// =======================
// THEORY CRUD
// =======================
async function theoryList(ctx, { edit = true } = {}) {
  const r = await pool.query(
    `
    SELECT id, title, is_active, updated_at
    FROM ai_theory_topics
    ORDER BY updated_at DESC, id DESC
    LIMIT 20
    `
  );

  let text = "📚 *Теория ИИ*\n\n" + "Темы (последние 20):";

  const kb = [];

  for (const t of r.rows) {
    const label = `${t.is_active ? "✅" : "⛔"} ${t.title}`;
    kb.push([
      Markup.button.callback(label.slice(0, 64), `ai_cfg_theory_open_${t.id}`),
    ]);
  }

  kb.push([Markup.button.callback("➕ Добавить тему", "ai_cfg_theory_add")]);
  kb.push([Markup.button.callback("⬅️ Назад", "admin_settings_ai")]);

  await deliver(
    ctx,
    { text, extra: { ...Markup.inlineKeyboard(kb), parse_mode: "Markdown" } },
    { edit }
  );
}

async function theoryOpen(ctx, id, { edit = true } = {}) {
  const r = await pool.query(
    `SELECT id, title, content, is_active FROM ai_theory_topics WHERE id = $1`,
    [id]
  );
  const t = r.rows[0];
  if (!t) {
    await ctx.answerCbQuery("Не найдено").catch(() => {});
    return;
  }

  const text =
    `📚 *Тема #${t.id}*\n\n` +
    `Название: *${t.title}*\n` +
    `Статус: ${t.is_active ? "активна ✅" : "выключена ⛔"}\n\n` +
    `Текст:\n${safeTrim(t.content, 3200)}`;

  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "✏️ Изменить название",
        `ai_cfg_theory_edit_title_${t.id}`
      ),
    ],
    [
      Markup.button.callback(
        "✏️ Изменить текст",
        `ai_cfg_theory_edit_content_${t.id}`
      ),
    ],
    [
      Markup.button.callback(
        t.is_active ? "⛔ Выключить" : "✅ Включить",
        `ai_cfg_theory_toggle_${t.id}`
      ),
    ],
    [Markup.button.callback("🗑 Удалить", `ai_cfg_theory_del_${t.id}`)],
    [Markup.button.callback("⬅️ К списку", "ai_cfg_theory")],
  ]);

  await deliver(
    ctx,
    { text, extra: { ...kb, parse_mode: "Markdown" } },
    { edit }
  );
}

// =======================
// BANS CRUD
// =======================
async function bansList(ctx, { edit = true } = {}) {
  const r = await pool.query(
    `
    SELECT id, title, is_active, updated_at
    FROM ai_ban_topics
    ORDER BY updated_at DESC, id DESC
    LIMIT 20
    `
  );

  let text =
    "🚫 *Запретные темы*\n\n" +
    "Важно: ИИ всё равно отвечает, но обращения по этим темам помечаются ❗.\n\n" +
    "Темы (последние 20):";

  const kb = [];

  for (const b of r.rows) {
    const label = `${b.is_active ? "✅" : "⛔"} ${b.title}`;
    kb.push([
      Markup.button.callback(label.slice(0, 64), `ai_cfg_bans_open_${b.id}`),
    ]);
  }

  kb.push([Markup.button.callback("➕ Добавить запрет", "ai_cfg_bans_add")]);
  kb.push([Markup.button.callback("⬅️ Назад", "admin_settings_ai")]);

  await deliver(
    ctx,
    { text, extra: { ...Markup.inlineKeyboard(kb), parse_mode: "Markdown" } },
    { edit }
  );
}

async function bansOpen(ctx, id, { edit = true } = {}) {
  const r = await pool.query(
    `SELECT id, title, description, is_active FROM ai_ban_topics WHERE id = $1`,
    [id]
  );
  const b = r.rows[0];
  if (!b) {
    await ctx.answerCbQuery("Не найдено").catch(() => {});
    return;
  }

  const text =
    `🚫 *Запрет #${b.id}*\n\n` +
    `Название: *${b.title}*\n` +
    `Статус: ${b.is_active ? "активен ✅" : "выключен ⛔"}\n\n` +
    `Описание (как понять, что вопрос относится к теме):\n${safeTrim(
      b.description,
      3200
    )}`;

  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "✏️ Изменить название",
        `ai_cfg_bans_edit_title_${b.id}`
      ),
    ],
    [
      Markup.button.callback(
        "✏️ Изменить описание",
        `ai_cfg_bans_edit_desc_${b.id}`
      ),
    ],
    [
      Markup.button.callback(
        b.is_active ? "⛔ Выключить" : "✅ Включить",
        `ai_cfg_bans_toggle_${b.id}`
      ),
    ],
    [Markup.button.callback("🗑 Удалить", `ai_cfg_bans_del_${b.id}`)],
    [Markup.button.callback("⬅️ К списку", "ai_cfg_bans")],
  ]);

  await deliver(
    ctx,
    { text, extra: { ...kb, parse_mode: "Markdown" } },
    { edit }
  );
}

// =======================
// CONTACTS CRUD
// =======================
async function contactsHome(ctx, { edit = true } = {}) {
  const text =
    "📞 *Контактные темы ИИ*\n\n" +
    "Здесь можно настроить темы, по которым ИИ будет подсказывать живого человека.\n" +
    "У темы есть название и описание. Если вопрос сотрудника совпадает с темой, в ответе ИИ появляется кнопка с контактами администратора(ов).\n" +
    "По нажатию админ получает уведомление.";

  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "🧩 Тематические элементы",
        "ai_cfg_contacts_list"
      ),
    ],
    [Markup.button.callback("➕ Добавить элемент", "ai_cfg_contacts_add")],
    [Markup.button.callback("⬅️ Назад", "admin_settings_ai")],
  ]);

  await deliver(
    ctx,
    { text, extra: { ...kb, parse_mode: "Markdown" } },
    { edit }
  );
}

async function contactsList(ctx, { edit = true } = {}) {
  const r = await pool.query(
    `
    SELECT id, title, is_active, updated_at
    FROM ai_contact_topics
    ORDER BY updated_at DESC, id DESC
    LIMIT 20
    `
  );

  const text = "🧩 *Контактные темы*\n\n" + "Выберите элемент:";

  const kb = [];
  for (const t of r.rows) {
    const label = `${t.is_active ? "✅" : "⛔"} ${t.title}`;
    kb.push([
      Markup.button.callback(label.slice(0, 64), `ai_cfg_contact_open_${t.id}`),
    ]);
  }
  kb.push([
    Markup.button.callback("➕ Добавить элемент", "ai_cfg_contacts_add"),
  ]);
  kb.push([Markup.button.callback("⬅️ Назад", "ai_cfg_contacts")]);

  await deliver(
    ctx,
    { text, extra: { ...Markup.inlineKeyboard(kb), parse_mode: "Markdown" } },
    { edit }
  );
}

async function contactOpen(ctx, id, { edit = true } = {}) {
  const r = await pool.query(
    `SELECT id, title, description, is_active FROM ai_contact_topics WHERE id = $1`,
    [id]
  );
  const t = r.rows[0];
  if (!t) {
    await ctx.answerCbQuery("Не найдено").catch(() => {});
    return;
  }

  const a = await pool.query(
    `
    SELECT u.id, u.full_name, u."position"
    FROM ai_contact_topic_admins ta
    JOIN users u ON u.id = ta.admin_user_id
    WHERE ta.topic_id = $1
    ORDER BY u.full_name
    `,
    [id]
  );

  const admins = a.rows;
  let adminsText = "—";
  if (admins.length) {
    adminsText = admins
      .map((x) => `• ${x.full_name}${x.position ? `, ${x.position}` : ""}`)
      .join("\n");
  }

  const text =
    `📞 *Тема #${t.id}*\n\n` +
    `Название: *${t.title}*\n` +
    `Статус: ${t.is_active ? "активна ✅" : "выключена ⛔"}\n\n` +
    `Описание:\n${safeTrim(t.description, 2200)}\n\n` +
    `Администраторы:\n${adminsText}`;

  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "➕ Добавить администратора",
        `ai_cfg_contact_add_admin_${t.id}`
      ),
    ],
    [
      Markup.button.callback(
        "❌ Убрать администратора",
        `ai_cfg_contact_remove_admin_${t.id}`
      ),
    ],
    [
      Markup.button.callback(
        t.is_active ? "⛔ Выключить" : "✅ Включить",
        `ai_cfg_contact_toggle_${t.id}`
      ),
    ],
    [Markup.button.callback("🗑 Удалить тему", `ai_cfg_contact_del_${t.id}`)],
    [Markup.button.callback("⬅️ К списку", "ai_cfg_contacts_list")],
  ]);

  await deliver(
    ctx,
    { text, extra: { ...kb, parse_mode: "Markdown" } },
    { edit }
  );
}

async function contactPickAdmin(ctx, topicId, mode, { edit = true } = {}) {
  // mode = add | remove
  const allAdmins = await getAdminsList(50);

  const linked = await pool.query(
    `SELECT admin_user_id FROM ai_contact_topic_admins WHERE topic_id = $1`,
    [topicId]
  );
  const linkedSet = new Set(linked.rows.map((x) => Number(x.admin_user_id)));

  let text =
    mode === "add"
      ? "➕ *Добавить администратора к теме*\n\nВыберите администратора:"
      : "❌ *Убрать администратора из темы*\n\nВыберите администратора:";

  const kb = [];
  const btns = [];

  for (const a of allAdmins) {
    const isLinked = linkedSet.has(Number(a.id));
    if (mode === "add" && isLinked) continue;
    if (mode === "remove" && !isLinked) continue;

    btns.push(
      Markup.button.callback(
        a.full_name.slice(0, 40),
        `ai_cfg_contact_${mode}_admin_do_${topicId}_${a.id}`
      )
    );
  }

  if (!btns.length) {
    kb.push([Markup.button.callback("— список пуст —", "noop")]);
  } else {
    for (let i = 0; i < btns.length; i += 2) kb.push(btns.slice(i, i + 2));
  }

  kb.push([
    Markup.button.callback("⬅️ Назад", `ai_cfg_contact_open_${topicId}`),
  ]);

  await deliver(
    ctx,
    { text, extra: { ...Markup.inlineKeyboard(kb), parse_mode: "Markdown" } },
    { edit }
  );
}

// =======================
// TEXT INPUT HANDLER (wizard)
// =======================
async function handleText(ctx, ensureUser) {
  const st = getSt(ctx.from.id);
  if (!st) return false;

  const admin = await ensureUser(ctx);
  if (!isAdmin(admin)) {
    clearSt(ctx.from.id);
    return false;
  }

  const input = (ctx.message?.text || "").trim();
  if (!input) return true;

  // THEORY add/edit
  if (st.section === "theory") {
    if (st.step === "add_title") {
      setSt(ctx.from.id, {
        section: "theory",
        step: "add_content",
        tempTitle: input,
      });
      await deliver(
        ctx,
        {
          text: "Отправьте *текст темы* (контент).",
          extra: { parse_mode: "Markdown" },
        },
        { edit: false }
      );
      return true;
    }
    if (st.step === "add_content") {
      const title = st.tempTitle;
      const content = input;
      await pool.query(
        `
        INSERT INTO ai_theory_topics (title, content, is_active, created_at, updated_at)
        VALUES ($1, $2, true, NOW(), NOW())
        `,
        [title, content]
      );
      clearSt(ctx.from.id);
      await deliver(
        ctx,
        { text: "✅ Тема добавлена.", extra: { parse_mode: "Markdown" } },
        { edit: false }
      );
      await theoryList(ctx, { edit: false });
      return true;
    }
    if (st.step === "edit_title") {
      await pool.query(
        `UPDATE ai_theory_topics SET title = $2, updated_at = NOW() WHERE id = $1`,
        [st.entityId, input]
      );
      clearSt(ctx.from.id);
      await deliver(
        ctx,
        { text: "✅ Название обновлено.", extra: { parse_mode: "Markdown" } },
        { edit: false }
      );
      await theoryOpen(ctx, st.entityId, { edit: false });
      return true;
    }
    if (st.step === "edit_content") {
      await pool.query(
        `UPDATE ai_theory_topics SET content = $2, updated_at = NOW() WHERE id = $1`,
        [st.entityId, input]
      );
      clearSt(ctx.from.id);
      await deliver(
        ctx,
        { text: "✅ Текст обновлён.", extra: { parse_mode: "Markdown" } },
        { edit: false }
      );
      await theoryOpen(ctx, st.entityId, { edit: false });
      return true;
    }
  }

  // BANS add/edit
  if (st.section === "bans") {
    if (st.step === "add_title") {
      setSt(ctx.from.id, {
        section: "bans",
        step: "add_desc",
        tempTitle: input,
      });
      await deliver(
        ctx,
        {
          text: "Отправьте *описание запрета* (как понять, что вопрос относится к теме).",
          extra: { parse_mode: "Markdown" },
        },
        { edit: false }
      );
      return true;
    }
    if (st.step === "add_desc") {
      const title = st.tempTitle;
      const description = input;
      await pool.query(
        `
        INSERT INTO ai_ban_topics (title, description, is_active, created_at, updated_at)
        VALUES ($1, $2, true, NOW(), NOW())
        `,
        [title, description]
      );
      clearSt(ctx.from.id);
      await deliver(
        ctx,
        { text: "✅ Запрет добавлен.", extra: { parse_mode: "Markdown" } },
        { edit: false }
      );
      await bansList(ctx, { edit: false });
      return true;
    }
    if (st.step === "edit_title") {
      await pool.query(
        `UPDATE ai_ban_topics SET title = $2, updated_at = NOW() WHERE id = $1`,
        [st.entityId, input]
      );
      clearSt(ctx.from.id);
      await deliver(
        ctx,
        { text: "✅ Название обновлено.", extra: { parse_mode: "Markdown" } },
        { edit: false }
      );
      await bansOpen(ctx, st.entityId, { edit: false });
      return true;
    }
    if (st.step === "edit_desc") {
      await pool.query(
        `UPDATE ai_ban_topics SET description = $2, updated_at = NOW() WHERE id = $1`,
        [st.entityId, input]
      );
      clearSt(ctx.from.id);
      await deliver(
        ctx,
        { text: "✅ Описание обновлено.", extra: { parse_mode: "Markdown" } },
        { edit: false }
      );
      await bansOpen(ctx, st.entityId, { edit: false });
      return true;
    }
  }

  // CONTACTS add/edit
  if (st.section === "contacts") {
    if (st.step === "add_title") {
      setSt(ctx.from.id, {
        section: "contacts",
        step: "add_desc",
        tempTitle: input,
      });
      await deliver(
        ctx,
        {
          text: "Отправьте *описание темы* (как понять, что вопрос относится к этой теме).",
          extra: { parse_mode: "Markdown" },
        },
        { edit: false }
      );
      return true;
    }
    if (st.step === "add_desc") {
      const title = st.tempTitle;
      const description = input;
      await pool.query(
        `
        INSERT INTO ai_contact_topics (title, description, is_active, created_at, updated_at)
        VALUES ($1, $2, true, NOW(), NOW())
        `,
        [title, description]
      );
      clearSt(ctx.from.id);
      await deliver(
        ctx,
        {
          text: "✅ Контактная тема добавлена.",
          extra: { parse_mode: "Markdown" },
        },
        { edit: false }
      );
      await contactsList(ctx, { edit: false });
      return true;
    }
    if (st.step === "edit_title") {
      await pool.query(
        `UPDATE ai_contact_topics SET title = $2, updated_at = NOW() WHERE id = $1`,
        [st.entityId, input]
      );
      clearSt(ctx.from.id);
      await deliver(
        ctx,
        { text: "✅ Название обновлено.", extra: { parse_mode: "Markdown" } },
        { edit: false }
      );
      await contactOpen(ctx, st.entityId, { edit: false });
      return true;
    }
    if (st.step === "edit_desc") {
      await pool.query(
        `UPDATE ai_contact_topics SET description = $2, updated_at = NOW() WHERE id = $1`,
        [st.entityId, input]
      );
      clearSt(ctx.from.id);
      await deliver(
        ctx,
        { text: "✅ Описание обновлено.", extra: { parse_mode: "Markdown" } },
        { edit: false }
      );
      await contactOpen(ctx, st.entityId, { edit: false });
      return true;
    }
  }

  // fallback: если что-то пошло не так — чистим стейт
  clearSt(ctx.from.id);
  return false;
}

// =======================
// REGISTER
// =======================
function registerAiSettings(bot, ensureUser, logError) {
  // ===== Entry from settings menu
  bot.action("admin_settings_ai", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;
      clearSt(ctx.from.id);
      await renderHome(ctx);
    } catch (e) {
      logError("admin_settings_ai", e);
    }
  });

  // ===== HOME buttons
  bot.action("ai_cfg_theory", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await theoryList(ctx);
  });

  bot.action("ai_cfg_bans", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await bansList(ctx);
  });

  bot.action("ai_cfg_contacts", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await contactsHome(ctx);
  });

  // ===== THEORY
  bot.action("ai_cfg_theory_add", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    setSt(ctx.from.id, { section: "theory", step: "add_title" });
    await deliver(
      ctx,
      { text: "Отправьте *название темы*.", extra: { parse_mode: "Markdown" } },
      { edit: false }
    );
  });

  bot.action(/ai_cfg_theory_open_(\d+)/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await theoryOpen(ctx, Number(ctx.match[1]));
  });

  bot.action(/ai_cfg_theory_edit_title_(\d+)/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const id = Number(ctx.match[1]);
    setSt(ctx.from.id, { section: "theory", step: "edit_title", entityId: id });
    await deliver(
      ctx,
      {
        text: "Отправьте *новое название*.",
        extra: { parse_mode: "Markdown" },
      },
      { edit: false }
    );
  });

  bot.action(/ai_cfg_theory_edit_content_(\d+)/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const id = Number(ctx.match[1]);
    setSt(ctx.from.id, {
      section: "theory",
      step: "edit_content",
      entityId: id,
    });
    await deliver(
      ctx,
      {
        text: "Отправьте *новый текст темы*.",
        extra: { parse_mode: "Markdown" },
      },
      { edit: false }
    );
  });

  bot.action(/ai_cfg_theory_toggle_(\d+)/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const id = Number(ctx.match[1]);
    await pool.query(
      `UPDATE ai_theory_topics SET is_active = NOT is_active, updated_at = NOW() WHERE id = $1`,
      [id]
    );
    await theoryOpen(ctx, id);
  });

  bot.action(/ai_cfg_theory_del_(\d+)/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const id = Number(ctx.match[1]);
    await deliver(ctx, {
      text: "🗑 Удалить тему? Это действие необратимо.",
      extra: Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "✅ Да, удалить",
            `ai_cfg_theory_del_yes_${id}`
          ),
        ],
        [Markup.button.callback("⬅️ Отмена", `ai_cfg_theory_open_${id}`)],
      ]),
    });
  });

  bot.action(/ai_cfg_theory_del_yes_(\d+)/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const id = Number(ctx.match[1]);
    await pool.query(`DELETE FROM ai_theory_topics WHERE id = $1`, [id]);
    await deliver(ctx, {
      text: "✅ Удалено.",
      extra: { parse_mode: "Markdown" },
    });
    await theoryList(ctx);
  });

  // ===== BANS
  bot.action("ai_cfg_bans_add", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    setSt(ctx.from.id, { section: "bans", step: "add_title" });
    await deliver(
      ctx,
      {
        text: "Отправьте *название запрета*.",
        extra: { parse_mode: "Markdown" },
      },
      { edit: false }
    );
  });

  bot.action(/ai_cfg_bans_open_(\d+)/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await bansOpen(ctx, Number(ctx.match[1]));
  });

  bot.action(/ai_cfg_bans_edit_title_(\d+)/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const id = Number(ctx.match[1]);
    setSt(ctx.from.id, { section: "bans", step: "edit_title", entityId: id });
    await deliver(
      ctx,
      {
        text: "Отправьте *новое название запрета*.",
        extra: { parse_mode: "Markdown" },
      },
      { edit: false }
    );
  });

  bot.action(/ai_cfg_bans_edit_desc_(\d+)/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const id = Number(ctx.match[1]);
    setSt(ctx.from.id, { section: "bans", step: "edit_desc", entityId: id });
    await deliver(
      ctx,
      {
        text: "Отправьте *новое описание запрета*.",
        extra: { parse_mode: "Markdown" },
      },
      { edit: false }
    );
  });

  bot.action(/ai_cfg_bans_toggle_(\d+)/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const id = Number(ctx.match[1]);
    await pool.query(
      `UPDATE ai_ban_topics SET is_active = NOT is_active, updated_at = NOW() WHERE id = $1`,
      [id]
    );
    await bansOpen(ctx, id);
  });

  bot.action(/ai_cfg_bans_del_(\d+)/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const id = Number(ctx.match[1]);
    await deliver(ctx, {
      text: "🗑 Удалить запрет? Это действие необратимо.",
      extra: Markup.inlineKeyboard([
        [Markup.button.callback("✅ Да, удалить", `ai_cfg_bans_del_yes_${id}`)],
        [Markup.button.callback("⬅️ Отмена", `ai_cfg_bans_open_${id}`)],
      ]),
    });
  });

  bot.action(/ai_cfg_bans_del_yes_(\d+)/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const id = Number(ctx.match[1]);
    await pool.query(`DELETE FROM ai_ban_topics WHERE id = $1`, [id]);
    await deliver(ctx, {
      text: "✅ Удалено.",
      extra: { parse_mode: "Markdown" },
    });
    await bansList(ctx);
  });

  // ===== CONTACTS
  bot.action("ai_cfg_contacts_list", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await contactsList(ctx);
  });

  bot.action("ai_cfg_contacts_add", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    setSt(ctx.from.id, { section: "contacts", step: "add_title" });
    await deliver(
      ctx,
      {
        text: "Отправьте *название контактной темы*.",
        extra: { parse_mode: "Markdown" },
      },
      { edit: false }
    );
  });

  bot.action(/ai_cfg_contact_open_(\d+)/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await contactOpen(ctx, Number(ctx.match[1]));
  });

  bot.action(/ai_cfg_contact_toggle_(\d+)/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const id = Number(ctx.match[1]);
    await pool.query(
      `UPDATE ai_contact_topics SET is_active = NOT is_active, updated_at = NOW() WHERE id = $1`,
      [id]
    );
    await contactOpen(ctx, id);
  });

  bot.action(/ai_cfg_contact_del_(\d+)/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const id = Number(ctx.match[1]);
    await deliver(ctx, {
      text: "🗑 Удалить контактную тему? Это действие необратимо.",
      extra: Markup.inlineKeyboard([
        [
          Markup.button.callback(
            "✅ Да, удалить",
            `ai_cfg_contact_del_yes_${id}`
          ),
        ],
        [Markup.button.callback("⬅️ Отмена", `ai_cfg_contact_open_${id}`)],
      ]),
    });
  });

  bot.action(/ai_cfg_contact_del_yes_(\d+)/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    const id = Number(ctx.match[1]);
    await pool.query(`DELETE FROM ai_contact_topics WHERE id = $1`, [id]);
    await deliver(ctx, {
      text: "✅ Удалено.",
      extra: { parse_mode: "Markdown" },
    });
    await contactsList(ctx);
  });

  bot.action(/ai_cfg_contact_add_admin_(\d+)/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await contactPickAdmin(ctx, Number(ctx.match[1]), "add");
  });

  bot.action(/ai_cfg_contact_remove_admin_(\d+)/, async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    await contactPickAdmin(ctx, Number(ctx.match[1]), "remove");
  });

  bot.action(
    /ai_cfg_contact_(add|remove)_admin_do_(\d+)_(\d+)/,
    async (ctx) => {
      try {
        await ctx.answerCbQuery().catch(() => {});
        const mode = ctx.match[1];
        const topicId = Number(ctx.match[2]);
        const adminId = Number(ctx.match[3]);

        if (mode === "add") {
          await pool.query(
            `
          INSERT INTO ai_contact_topic_admins (topic_id, admin_user_id)
          VALUES ($1, $2)
          ON CONFLICT DO NOTHING
          `,
            [topicId, adminId]
          );
        } else {
          await pool.query(
            `
          DELETE FROM ai_contact_topic_admins
          WHERE topic_id = $1 AND admin_user_id = $2
          `,
            [topicId, adminId]
          );
        }

        await contactOpen(ctx, topicId);
      } catch (e) {
        logError("ai_cfg_contact_admin_do", e);
      }
    }
  );

  // общий noop
  bot.action("noop", (ctx) => ctx.answerCbQuery().catch(() => {}));

  // TEXT wizard handler (важно: не мешает другим, если нет state)
  bot.on("text", async (ctx, next) => {
    try {
      const handled = await handleText(ctx, ensureUser);
      if (handled) return;
    } catch (e) {
      logError("aiSettings_text", e);
      clearSt(ctx.from.id);
    }
    return next();
  });
}

module.exports = { registerAiSettings };
