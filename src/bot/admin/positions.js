const pool = require("../../db/pool");
const { deliver } = require("../../utils/renderHelpers");
const { Markup } = require("telegraf");

const addPositionStates = new Map();
// key: telegram_id, value: { step: "title" }

function toCode(title) {
  const map = {
    а: "a",
    б: "b",
    в: "v",
    г: "g",
    д: "d",
    е: "e",
    ё: "e",
    ж: "zh",
    з: "z",
    и: "i",
    й: "y",
    к: "k",
    л: "l",
    м: "m",
    н: "n",
    о: "o",
    п: "p",
    р: "r",
    с: "s",
    т: "t",
    у: "u",
    ф: "f",
    х: "h",
    ц: "ts",
    ч: "ch",
    ш: "sh",
    щ: "sch",
    ъ: "",
    ы: "y",
    ь: "",
    э: "e",
    ю: "yu",
    я: "ya",
  };

  const s = (title || "")
    .toString()
    .trim()
    .toLowerCase()
    .split("")
    .map((ch) => (map[ch] !== undefined ? map[ch] : ch))
    .join("");

  let code = s
    .replace(/[^a-z0-9\s_-]+/g, "") // выкинуть всё лишнее
    .replace(/[\s-]+/g, "_") // пробелы/дефисы в _
    .replace(/_+/g, "_") // сжать __
    .replace(/^_+|_+$/g, ""); // обрезать _ по краям

  if (!code) code = `pos_${Date.now()}`;
  if (code.length > 50) code = code.slice(0, 50).replace(/_+$/g, "");
  return code;
}

async function renderPositionsList(ctx, { editTo } = {}) {
  const res = await pool.query(
    `SELECT id, title, code
     FROM positions
     WHERE is_active = true
     ORDER BY id`
  );

  let text = "🧩 <b>Должности</b>\n\nСписок доступных должностей:";

  const kb = [];

  if (!res.rows.length) {
    kb.push([Markup.button.callback("— список пуст —", "noop")]);
  } else {
    for (const p of res.rows) {
      kb.push([
        Markup.button.callback(
          (p.title || p.code || `#${p.id}`).slice(0, 64),
          `admin_position_open:${p.id}`
        ),
      ]);
    }
  }

  kb.push([
    Markup.button.callback("➕ Добавить должность", "admin_position_add"),
  ]);
  kb.push([Markup.button.callback("⬅️ Назад", "admin_settings_users")]);

  const extra = {
    parse_mode: "HTML",
    reply_markup: Markup.inlineKeyboard(kb).reply_markup,
  };

  // Если нужно отредактировать конкретное сообщение
  if (editTo?.chatId && editTo?.messageId) {
    await ctx.telegram.editMessageText(
      editTo.chatId,
      editTo.messageId,
      undefined,
      text,
      extra
    );
    return;
  }

  // Иначе обычный deliver (на случай вызовов из callback)
  await deliver(
    ctx,
    { text, extra: Markup.inlineKeyboard(kb) },
    { edit: true }
  );
}

function registerAdminPositions(bot, ensureUser, logError) {
  // Список должностей
  bot.action("admin_positions", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin"))
        return;

      addPositionStates.delete(ctx.from.id); // сброс ввода
      await renderPositionsList(ctx);
    } catch (err) {
      logError("admin_positions", err);
    }
  });

  // Карточка должности
  bot.action(/^admin_position_open:(\d+)$/, async (ctx) => {
    const id = ctx.match[1];

    const { rows } = await pool.query(
      "SELECT id, title, code FROM positions WHERE id = $1",
      [id]
    );

    if (!rows.length) {
      return ctx.answerCbQuery("Должность не найдена");
    }

    const pos = rows[0];

    const countRes = await pool.query(
      "SELECT COUNT(*) FROM users WHERE position = $1",
      [pos.code]
    );

    await deliver(
      ctx,
      {
        text:
          `🧩 <b>${pos.title}</b>\n\n` +
          `Код: <code>${pos.code}</code>\n` +
          `Пользователей с этой должностью: ${countRes.rows[0].count}`,
        extra: Markup.inlineKeyboard([
          [
            Markup.button.callback(
              "🗑 Удалить эту должность",
              `admin_position_delete:${id}`
            ),
          ],
          [Markup.button.callback("⬅️ Назад", "admin_positions")],
        ]),
      },
      { edit: true }
    );
  });

  // Удаление
  bot.action(/^admin_position_delete:(\d+)$/, async (ctx) => {
    const id = ctx.match[1];

    const { rows } = await pool.query(
      "SELECT code FROM positions WHERE id = $1",
      [id]
    );
    if (!rows.length) return;

    const code = rows[0].code;

    await pool.query("UPDATE users SET position = NULL WHERE position = $1", [
      code,
    ]);
    await pool.query("DELETE FROM positions WHERE id = $1", [id]);

    await ctx.answerCbQuery("Должность удалена");

    return bot.emit("callback_query", {
      ...ctx.update.callback_query,
      data: "admin_positions",
    });
  });

  // Добавление — первый шаг
  bot.action("admin_position_add", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin"))
        return;

      addPositionStates.set(ctx.from.id, {
        step: "title",
        chatId: ctx.callbackQuery?.message?.chat?.id,
        messageId: ctx.callbackQuery?.message?.message_id,
      });

      await deliver(
        ctx,
        {
          text:
            "➕ <b>Добавление должности</b>\n\n" +
            "Введите <b>название</b> должности (например: Менеджер по качеству):",
          extra: Markup.inlineKeyboard([
            [Markup.button.callback("⬅️ Отмена", "admin_positions")],
          ]),
        },
        { edit: true }
      );
    } catch (err) {
      logError("admin_position_add", err);
    }
  });

  // Обработка текста
  bot.on("text", async (ctx, next) => {
    const st = addPositionStates.get(ctx.from.id);
    if (!st) return next();

    try {
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
        addPositionStates.delete(ctx.from.id);
        return next();
      }

      const title = ctx.message.text.trim();
      if (!title) {
        return ctx.reply("Введите название должности текстом.", {
          parse_mode: "HTML",
        });
      }

      const base = toCode(title);

      // Вставляем с попытками, если code уже занят — добавляем суффикс _2, _3...
      let inserted = false;
      let finalCode = base;

      for (let i = 0; i < 20; i++) {
        finalCode = i === 0 ? base : `${base}_${i + 1}`; // base_2, base_3...
        const r = await pool.query(
          `INSERT INTO positions (code, title, is_active)
         VALUES ($1, $2, true)
         ON CONFLICT (code) DO NOTHING
         RETURNING id`,
          [finalCode, title]
        );
        if (r.rows.length) {
          inserted = true;
          break;
        }
      }

      if (!inserted) {
        addPositionStates.delete(ctx.from.id);
        return ctx.reply(
          "💥 Не удалось создать должность (конфликт кодов). Попробуйте другое название."
        );
      }
      // ...после успешной вставки
      const editTo = { chatId: st.chatId, messageId: st.messageId };
      addPositionStates.delete(ctx.from.id);

      // 1) тост (как сообщение) и быстро удалить
      const toast = await ctx.reply("✅ Должность добавлена").catch(() => null);
      if (toast?.message_id) {
        setTimeout(() => {
          ctx.telegram
            .deleteMessage(ctx.chat.id, toast.message_id)
            .catch(() => {});
        }, 1300);
      }

      // 2) вернуть к списку должностей редактированием экрана "Добавление должности"
      await renderPositionsList(ctx, { editTo });
      return;
    } catch (err) {
      addPositionStates.delete(ctx.from.id);
      logError("admin_positions_text", err);
      return ctx.reply(
        "💥 Ошибка при добавлении должности. Попробуйте ещё раз."
      );
    }
  });

  bot.action("noop", async (ctx) => ctx.answerCbQuery().catch(() => {}));
}

module.exports = { registerAdminPositions };
