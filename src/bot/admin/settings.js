const { Markup } = require("telegraf");
const pool = require("../../db/pool");
const { deliver } = require("../../utils/renderHelpers");
const { registerAiSettings } = require("./aiSettings");
const { registerAdminShiftSettings } = require("./shiftSettings");
const { registerAdminShiftOpeningTasks } = require("./shiftOpeningTasks");
const { registerAdminShiftClosingTasks } = require("./shiftClosingTasks");
const { registerAdminResponsibles } = require("./responsibles");
const { registerAdminCashCollectionAccess } = require("./cashCollectionAccess");
const { registerCashDiffSettings } = require("./cashDiffSettings");
const { registerAdminPositions } = require("./positions");


// Состояния для создания / редактирования торговых точек
const tradePointStates = new Map();

function getTpState(tgId) {
  return tradePointStates.get(tgId) || null;
}

function setTpState(tgId, state) {
  tradePointStates.set(tgId, state);
}

function clearTpState(tgId) {
  tradePointStates.delete(tgId);
}

function registerAdminSettings(bot, ensureUser, logError) {
  registerAdminShiftSettings(bot, ensureUser, logError);
  registerAdminShiftOpeningTasks(bot, ensureUser, logError);
  registerAdminShiftClosingTasks(bot, ensureUser, logError);
  registerAdminResponsibles(bot, ensureUser, logError);
  registerAdminCashCollectionAccess(bot, ensureUser, logError);
  registerCashDiffSettings(bot, ensureUser, logError);

  registerAdminPositions(bot, ensureUser, logError);

  registerAiSettings(bot, ensureUser, logError);
  // -----------------------------
  // ВХОД В НАСТРОЙКИ
  // -----------------------------
  bot.action("admin_settings", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin"))
        return;

      const text = "⚙️ *Настройки*\n\nВыберите категорию:";
      const keyboard = Markup.inlineKeyboard([
        [
          {
            text: "🏢🔧 Настройка компании",
            callback_data: "admin_settings_company",
          },
        ],
        [{ text: "🔮🔧 Настройка ИИ", callback_data: "admin_settings_ai" }],
        [{ text: "👥🔧 Пользователи", callback_data: "admin_settings_users" }],
        [{ text: "⬅️ Назад", callback_data: "lk_admin_menu" }],
      ]);

      await deliver(ctx, { text, extra: keyboard }, { edit: true });
    } catch (err) {
      logError("admin_settings_root", err);
    }
  });

  // -----------------------------
  // НАСТРОЙКИ КОМПАНИИ
  // -----------------------------
  bot.action("admin_settings_company", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin"))
        return;

      const text = "🏢 *Настройки компании*\n\nВыберите раздел:";
      const keyboard = Markup.inlineKeyboard([
        [{ text: "🏬 Торговые точки", callback_data: "admin_tp_list" }],
        [{ text: "🛠️ Настройка смен", callback_data: "admin_shift_settings" }],
        [{ text: "⬅️ Назад", callback_data: "admin_settings" }],
      ]);

      await deliver(ctx, { text, extra: keyboard }, { edit: true });
    } catch (err) {
      logError("admin_settings_company", err);
    }
  });

  // -----------------------------
  // СПИСОК ТОРГОВЫХ ТОЧЕК
  // -----------------------------
  async function showTradePointsList(ctx) {
    const res = await pool.query(
      `
        SELECT id, title, is_active
        FROM trade_points
        ORDER BY title
      `
    );
    const rows = res.rows;

    let text = "🏬 *Торговые точки:*\n";
    if (!rows.length) {
      text += "\nПока нет ни одной торговой точки.";
    }

    const buttons = [];

    for (const tp of rows) {
      const statusIcon = tp.is_active === false ? "⚪️" : "🟢";
      const title = tp.title || "Без названия";
      buttons.push([
        Markup.button.callback(
          `${statusIcon} ${title}`,
          `admin_tp_open_${tp.id}`
        ),
      ]);
    }

    buttons.push([Markup.button.callback("➕ Добавить", "admin_tp_add")]);
    buttons.push([
      Markup.button.callback("🔙 Назад", "admin_settings_company"),
    ]);

    const keyboard = Markup.inlineKeyboard(buttons);

    await deliver(ctx, { text, extra: keyboard }, { edit: true });
  }

  async function getTradePointPhotosCount(pointId) {
    const res = await pool.query(
      `SELECT COUNT(*) AS cnt FROM trade_point_photos WHERE trade_point_id = $1`,
      [pointId]
    );
    return Number(res.rows[0]?.cnt || 0);
  }

  bot.action("admin_tp_list", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin"))
        return;
      await showTradePointsList(ctx);
    } catch (err) {
      logError("admin_tp_list", err);
    }
  });

  // старый алиас, если вдруг где-то уже используется
  bot.action("admin_settings_company_points", async (ctx) => {
    await ctx.answerCbQuery().catch(() => {});
    return showTradePointsList(ctx);
  });

  // -----------------------------
  // КАРТОЧКА ТОРГОВОЙ ТОЧКИ
  // -----------------------------
  async function showTradePointCard(ctx, pointId) {
    const res = await pool.query(
      `
        SELECT id, title, address, work_hours, landmark, is_active
        FROM trade_points
        WHERE id = $1
      `,
      [pointId]
    );

    if (!res.rows.length) {
      await ctx.reply("Эта торговая точка не найдена или была удалена.");
      return;
    }

    const tp = res.rows[0];

    const photosCount = await getTradePointPhotosCount(pointId);
    const shortName = tp.title || "не указано";
    const fullAddr = tp.address || "не указан";
    const workHours = tp.work_hours || "не указано";
    const landmark = tp.landmark || "не указан";
    const isActive = tp.is_active !== false;

    let text = "🏬 *Торговая точка*\n\n";
    text += `• Короткое имя: ${shortName}\n`;
    text += `• Полный адрес: ${fullAddr}\n`;
    text += `• Время работы: ${workHours}\n`;
    text += `• Ориентир: ${landmark}\n`;
    text += `• Фото ориентиров: ${photosCount} / 3\n`;
    text += `• Статус: ${isActive ? "активна ✅" : "отключена ⚪️"}\n`;

    const keyboard = Markup.inlineKeyboard([
      [
        Markup.button.callback(
          "✏️ Короткое имя",
          `admin_tp_edit_title_${tp.id}`
        ),
      ],
      [
        Markup.button.callback(
          "✏️ Полный адрес",
          `admin_tp_edit_address_${tp.id}`
        ),
      ],
      [
        Markup.button.callback(
          "✏️ Время работы",
          `admin_tp_edit_work_hours_${tp.id}`
        ),
      ],
      [
        Markup.button.callback(
          "✏️ Ориентир",
          `admin_tp_edit_landmark_${tp.id}`
        ),
      ],
      [
        Markup.button.callback(
          `📷 Фото ориентиров (${photosCount}/3)`,
          `admin_tp_photos_${tp.id}`
        ),
      ],
      [
        Markup.button.callback(
          isActive ? "⚪️ Выключить точку" : "🟢 Включить точку",
          `admin_tp_toggle_${tp.id}`
        ),
      ],
      [Markup.button.callback("⬅️ К списку точек", "admin_tp_list")],
    ]);

    await deliver(ctx, { text, extra: keyboard }, { edit: true });
  }

  bot.action(/^admin_tp_open_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin"))
        return;

      const pointId = Number(ctx.match[1]);
      await showTradePointCard(ctx, pointId);
    } catch (err) {
      logError("admin_tp_open", err);
    }
  });

  // -----------------------------
  // СОЗДАНИЕ НОВОЙ ТОЧКИ
  // -----------------------------
  bot.action("admin_tp_add", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin"))
        return;

      const tgId = ctx.from.id;
      setTpState(tgId, {
        mode: "create",
        step: "title",
        pointId: null,
        data: {},
      });

      await ctx.reply(
        "➕ Добавление торговой точки.\n\nВведи короткое имя (например, «КП79», «БХ2»):"
      );
    } catch (err) {
      logError("admin_tp_add", err);
    }
  });

  bot.action("admin_tp_cancel", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      clearTpState(ctx.from.id);
      await showTradePointsList(ctx);
    } catch (err) {
      logError("admin_tp_cancel", err);
    }
  });

  // Показ / управление фото ориентиров
  bot.action(/^admin_tp_photos_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin"))
        return;

      const pointId = Number(ctx.match[1]);

      const res = await pool.query(
        `
        SELECT id, file_id
        FROM trade_point_photos
        WHERE trade_point_id = $1
        ORDER BY created_at ASC
      `,
        [pointId]
      );
      const photos = res.rows;
      const count = photos.length;

      let text = "📷 Фото ориентиров для точки.\n\n";
      if (!count) {
        text += "Пока нет ни одного фото.";
      } else {
        text += `Сейчас загружено фото: ${count} / 3.\n`;
      }

      // Если есть фото — отправим их отдельными сообщениями
      for (const row of photos) {
        await ctx.replyWithPhoto(row.file_id).catch(() => {});
      }

      const buttons = [];

      if (count < 3) {
        buttons.push([
          Markup.button.callback(
            "➕ Добавить фото",
            `admin_tp_photos_add_${pointId}`
          ),
        ]);
      }

      if (count > 0) {
        buttons.push([
          Markup.button.callback(
            "🗑 Очистить все фото",
            `admin_tp_photos_clear_${pointId}`
          ),
        ]);
      }

      buttons.push([
        Markup.button.callback("⬅️ Назад к точке", `admin_tp_open_${pointId}`),
      ]);

      const keyboard = Markup.inlineKeyboard(buttons);

      await ctx.reply(text, { reply_markup: keyboard.reply_markup });
    } catch (err) {
      logError("admin_tp_photos", err);
    }
  });

  // Вход в режим добавления фото
  bot.action(/^admin_tp_photos_add_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin"))
        return;

      const pointId = Number(ctx.match[1]);
      const tgId = ctx.from.id;

      // Проверим, сколько уже есть
      const count = await getTradePointPhotosCount(pointId);
      if (count >= 3) {
        await ctx.reply("У этой точки уже загружено максимум (3) фото.");
        return;
      }

      setTpState(tgId, {
        mode: "photo_add",
        step: null,
        pointId,
        data: {},
      });

      await ctx.reply(
        `Отправь фото ориентиров для этой точки.\n` +
          `Можно добавить ещё ${3 - count} шт.\n\n` +
          `Чтобы отменить — отправь /cancel.`
      );
    } catch (err) {
      logError("admin_tp_photos_add", err);
    }
  });

  // Очистить все фото
  bot.action(/^admin_tp_photos_clear_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin"))
        return;

      const pointId = Number(ctx.match[1]);

      await pool.query(
        `DELETE FROM trade_point_photos WHERE trade_point_id = $1`,
        [pointId]
      );

      await ctx.reply("Все фото ориентиров для этой точки удалены.");
      await showTradePointCard(ctx, pointId);
    } catch (err) {
      logError("admin_tp_photos_clear", err);
    }
  });

  // -----------------------------
  // РЕДАКТИРОВАНИЕ ПОЛЕЙ
  // -----------------------------
  function startEditField(ctx, pointId, field, promptText) {
    const tgId = ctx.from.id;
    setTpState(tgId, {
      mode: "edit",
      step: field,
      pointId,
      data: {},
    });

    return ctx.reply(promptText + "\n\nЕсли передумал — отправь «/cancel».");
  }

  bot.action(/^admin_tp_edit_title_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin"))
        return;

      const pointId = Number(ctx.match[1]);
      await startEditField(
        ctx,
        pointId,
        "title",
        "✏️ Введи новое короткое имя для этой точки:"
      );
    } catch (err) {
      logError("admin_tp_edit_title", err);
    }
  });

  bot.action(/^admin_tp_edit_address_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin"))
        return;

      const pointId = Number(ctx.match[1]);
      await startEditField(
        ctx,
        pointId,
        "address",
        "✏️ Введи новый полный адрес точки:"
      );
    } catch (err) {
      logError("admin_tp_edit_address", err);
    }
  });

  bot.action(/^admin_tp_edit_work_hours_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin"))
        return;

      const pointId = Number(ctx.match[1]);
      await startEditField(
        ctx,
        pointId,
        "work_hours",
        "✏️ Введи новое время работы точки (или «-» чтобы очистить):"
      );
    } catch (err) {
      logError("admin_tp_edit_work_hours", err);
    }
  });

  bot.action(/^admin_tp_edit_landmark_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin"))
        return;

      const pointId = Number(ctx.match[1]);
      await startEditField(
        ctx,
        pointId,
        "landmark",
        "✏️ Опиши ориентир / как пройти (или «-» чтобы очистить):"
      );
    } catch (err) {
      logError("admin_tp_edit_landmark", err);
    }
  });

  // Переключение статуса точки
  bot.action(/^admin_tp_toggle_(\d+)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin"))
        return;

      const pointId = Number(ctx.match[1]);

      const res = await pool.query(
        `
          UPDATE trade_points
          SET is_active = NOT COALESCE(is_active, true)
          WHERE id = $1
          RETURNING is_active
        `,
        [pointId]
      );

      const isActive = res.rows[0]?.is_active !== false;
      await ctx
        .answerCbQuery(isActive ? "Точка включена" : "Точка выключена", {
          show_alert: false,
        })
        .catch(() => {});

      await showTradePointCard(ctx, pointId);
    } catch (err) {
      logError("admin_tp_toggle", err);
    }
  });

  // -----------------------------
  // ОБРАБОТКА ТЕКСТА ДЛЯ СОЗДАНИЯ/РЕДАКТА
  // -----------------------------
  bot.on("text", async (ctx, next) => {
    try {
      const tgId = ctx.from.id;
      const state = getTpState(tgId);
      if (!state) return next();

      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        clearTpState(tgId);
        return next();
      }

      const text = (ctx.message.text || "").trim();
      if (!text) return;

      // Отмена редактирования через /cancel
      if (text.toLowerCase() === "/cancel") {
        clearTpState(tgId);
        await ctx.reply("Ок, изменения отменены.");
        return;
      }

      // ------- CREATE FLOW -------
      if (state.mode === "create") {
        if (state.step === "title") {
          if (text.length < 2 || text.length > 50) {
            await ctx.reply("Короткое имя выглядит странно, попробуй ещё раз.");
            return;
          }
          state.data.title = text;
          state.step = "address";
          setTpState(tgId, state);
          await ctx.reply("Теперь введи полный адрес торговой точки:");
          return;
        }

        if (state.step === "address") {
          if (text.length < 5) {
            await ctx.reply("Адрес слишком короткий, попробуй ещё раз.");
            return;
          }
          state.data.address = text;
          state.step = "work_hours";
          setTpState(tgId, state);
          await ctx.reply(
            "Укажи время работы точки (например, «Пн–Вс: 8:00–22:00»).\nЕсли не хочешь указывать сейчас — отправь «-»."
          );
          return;
        }

        if (state.step === "work_hours") {
          state.data.work_hours = text === "-" ? null : text;
          state.step = "landmark";
          setTpState(tgId, state);
          await ctx.reply(
            "Теперь опиши ориентир / как пройти.\nЕсли не хочешь указывать сейчас — отправь «-»."
          );
          return;
        }

        if (state.step === "landmark") {
          state.data.landmark = text === "-" ? null : text;

          const { title, address, work_hours, landmark } = state.data;

          await pool.query(
            `
              INSERT INTO trade_points (title, address, work_hours, landmark, is_active)
              VALUES ($1, $2, $3, $4, true)
            `,
            [title, address, work_hours, landmark]
          );

          clearTpState(tgId);
          await ctx.reply("Торговая точка добавлена ✅");
          await showTradePointsList(ctx);
          return;
        }
      }

      // ------- EDIT FLOW -------
      if (state.mode === "edit") {
        const pointId = state.pointId;

        if (state.step === "title") {
          if (text.length < 2 || text.length > 50) {
            await ctx.reply("Короткое имя выглядит странно, попробуй ещё раз.");
            return;
          }
          await pool.query(`UPDATE trade_points SET title = $1 WHERE id = $2`, [
            text,
            pointId,
          ]);
          clearTpState(tgId);
          await ctx.reply("Короткое имя обновлено ✅");
          await showTradePointCard(ctx, pointId);
          return;
        }

        if (state.step === "address") {
          if (text.length < 5) {
            await ctx.reply("Адрес слишком короткий, попробуй ещё раз.");
            return;
          }
          await pool.query(
            `UPDATE trade_points SET address = $1 WHERE id = $2`,
            [text, pointId]
          );
          clearTpState(tgId);
          await ctx.reply("Адрес обновлён ✅");
          await showTradePointCard(ctx, pointId);
          return;
        }

        if (state.step === "work_hours") {
          const value = text === "-" ? null : text;
          await pool.query(
            `UPDATE trade_points SET work_hours = $1 WHERE id = $2`,
            [value, pointId]
          );
          clearTpState(tgId);
          await ctx.reply("Время работы обновлено ✅");
          await showTradePointCard(ctx, pointId);
          return;
        }

        if (state.step === "landmark") {
          const value = text === "-" ? null : text;
          await pool.query(
            `UPDATE trade_points SET landmark = $1 WHERE id = $2`,
            [value, pointId]
          );
          clearTpState(tgId);
          await ctx.reply("Ориентир обновлён ✅");
          await showTradePointCard(ctx, pointId);
          return;
        }
      }

      return next();
    } catch (err) {
      logError("admin_tp_text_flow", err);
      return next();
    }
  });

  bot.on("photo", async (ctx, next) => {
    try {
      const tgId = ctx.from.id;
      const state = getTpState(tgId);
      if (!state || state.mode !== "photo_add") return next();

      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        clearTpState(tgId);
        return next();
      }

      const pointId = state.pointId;

      // Уже сколько есть?
      const count = await getTradePointPhotosCount(pointId);
      if (count >= 3) {
        await ctx.reply("У этой точки уже загружено максимум (3) фото.");
        clearTpState(tgId);
        return;
      }

      const photos = ctx.message.photo || [];
      if (!photos.length) {
        await ctx.reply("Не смог прочитать фото, попробуй ещё раз.");
        return;
      }

      // Берём самое большое фото
      const fileId = photos[photos.length - 1].file_id;

      await pool.query(
        `
        INSERT INTO trade_point_photos (trade_point_id, file_id)
        VALUES ($1, $2)
      `,
        [pointId, fileId]
      );

      const newCount = await getTradePointPhotosCount(pointId);

      await ctx.reply(`Фото сохранено ✅ (${newCount} / 3)`);

      if (newCount >= 3) {
        clearTpState(tgId);
        await ctx.reply("Достигнут лимит (3 фото) для этой точки.");
      }

      return;
    } catch (err) {
      logError("admin_tp_photo_add_flow", err);
      return next();
    }
  });

  bot.action("admin_settings_users", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin"))
        return;

      const text =
        "👥 <b>Пользователи</b>\n\n" +
        "Здесь настраиваются справочники, связанные с пользователями.\n" +
        "В частности — список доступных должностей сотрудников.";

      const keyboard = Markup.inlineKeyboard([
        [{ text: "🧩 Настройка должностей", callback_data: "admin_positions" }],
        [{ text: "⬅️ Назад", callback_data: "admin_settings" }],
      ]);

      await deliver(ctx, { text, extra: keyboard }, { edit: true });
    } catch (err) {
      logError("admin_settings_users", err);
    }
  });

  // -----------------------------
  // ЗАГЛУШКИ ДЛЯ ПРОЧИХ РАЗДЕЛОВ
  // -----------------------------
  bot.action(/admin_settings_(academy|stock)/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});

      const section = ctx.callbackQuery.data.replace("admin_settings_", "");
      const text = `🔧 Раздел *${section}* пока в разработке.`;

      await deliver(
        ctx,
        {
          text,
          extra: {
            reply_markup: {
              inline_keyboard: [
                [{ text: "⬅️ Назад", callback_data: "admin_settings" }],
              ],
            },
          },
        },
        { edit: true }
      );
    } catch (err) {
      logError("admin_settings_section", err);
    }
  });
}

module.exports = { registerAdminSettings };
