// src/bot/onboarding.js

const { Markup } = require("telegraf");
const pool = require("../db/pool");
const { getUserState, setUserState, clearUserState } = require("./state");

const MODE = "waiting_onboarding";

// вспомогательный геттер
function getState(tgId) {
  const st = getUserState(tgId);
  return st && st.mode === MODE ? st : null;
}

// Запуск онбординга (вызываем из ensureUser, если user ещё не существует)
async function startWaitingOnboarding(ctx) {
  const tgId = ctx.from.id;

  // вдруг мы уже записали этого человека раньше
  const existing = await pool.query(
    `
      SELECT full_name, age, phone, created_at
      FROM lk_waiting_users
      WHERE telegram_id = $1
      ORDER BY id DESC
      LIMIT 1
    `,
    [tgId]
  );

  if (existing.rows.length) {
    await ctx.reply(
      "Привет! 👋\n\n" +
        "Мы уже записали ваши контакты и ждём, когда вас пригласят на собеседование или стажировку.\n" +
        "Как только это произойдёт, вы получите уведомление в этом боте."
    );
    return;
  }

  const text =
    "Привет! Я — Личный кабинет Green Rocket. 🚀\n\n" +
    "Чтобы мы могли пригласить вас на собеседование или стажировку, " +
    "нам нужно сохранить ваши данные: *имя*, *возраст* и *номер телефона*.\n\n" +
    "Нажимая «✅ Согласен», вы даёте согласие на обработку этих данных " +
    "для организации собеседований и стажировок.\n\n" +
    "Если не согласны, нажмите «❌ Не согласен» — тогда Личный кабинет не будет активирован.";

  const keyboard = Markup.inlineKeyboard([
    [Markup.button.callback("✅ Согласен", "lk_waiting_consent_yes")],
    [Markup.button.callback("❌ Не согласен", "lk_waiting_consent_no")],
  ]);

  await ctx.reply(text, { parse_mode: "Markdown", ...keyboard });

  setUserState(tgId, {
    mode: MODE,
    step: "consent",
  });
}

function registerWaitingOnboarding(bot, logError) {
  // Ответ "не согласен"
  bot.action("lk_waiting_consent_no", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const tgId = ctx.from.id;
      const st = getState(tgId);
      if (!st || st.step !== "consent") return;

      clearUserState(tgId);

      await ctx.editMessageText(
        "Понимаю. Без согласия на обработку данных Личный кабинет использовать нельзя.\n\n" +
          "Если передумаете — просто заново нажмите /start."
      );
    } catch (err) {
      logError("lk_waiting_consent_no", err);
    }
  });

  // Ответ "согласен"
  bot.action("lk_waiting_consent_yes", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const tgId = ctx.from.id;
      const st = getState(tgId);
      if (!st || st.step !== "consent") return;

      setUserState(tgId, {
        mode: MODE,
        step: "name",
      });

      await ctx.editMessageText(
        "Отлично! ✍️\n\n" +
          "1/3. Как к вам обращаться?\n" +
          "Напишите, пожалуйста, имя (можно просто имя, без фамилии)."
      );
    } catch (err) {
      logError("lk_waiting_consent_yes", err);
    }
  });

  // Текстовые ответы (имя / возраст / телефон)
  bot.on("text", async (ctx, next) => {
    const tgId = ctx.from.id;
    const st = getState(tgId);
    if (!st) return next(); // это не наш сценарий

    try {
      const text = (ctx.message.text || "").trim();

      // 1/3 — имя
      if (st.step === "name") {
        if (!text) {
          await ctx.reply("Пожалуйста, напишите ваше имя текстом.");
          return;
        }

        setUserState(tgId, {
          mode: MODE,
          step: "age",
          name: text,
        });

        await ctx.reply(
          "2/3. Сколько вам лет?\n" +
            "Можно написать просто число (например, 18).\n" +
            "Если не хотите указывать возраст — напишите «-»."
        );
        return;
      }

      // 2/3 — возраст
      if (st.step === "age") {
        let age = null;
        if (text !== "-" && text !== "—") {
          const n = Number.parseInt(text, 10);
          if (!Number.isFinite(n) || n < 10 || n > 100) {
            await ctx.reply(
              "Возраст не распознан. Напишите, пожалуйста, число (например, 18) " +
                "или «-», если не хотите указывать."
            );
            return;
          }
          age = n;
        }

        setUserState(tgId, {
          mode: MODE,
          step: "phone",
          name: st.name,
          age,
        });

        await ctx.reply(
          "3/3. Напишите, пожалуйста, номер телефона для связи.\n" +
            "Можно *отправить контакт* кнопкой ниже или просто написать номер текстом.",
          {
            parse_mode: "Markdown",
            reply_markup: {
              keyboard: [
                [{ text: "📱 Отправить мой номер", request_contact: true }],
                [{ text: "Ввести номер вручную" }],
              ],
              resize_keyboard: true,
              one_time_keyboard: true,
            },
          }
        );
        return;
      }

      // 3/3 — телефон
      if (st.step === "phone") {
        if (!text) {
          await ctx.reply("Пожалуйста, отправьте номер телефона текстом.");
          return;
        }

        const phone = text;
        const { name, age } = st;

        await pool.query(
          `
            INSERT INTO lk_waiting_users (telegram_id, full_name, age, phone, consent_given)
            VALUES ($1, $2, $3, $4, TRUE)
          `,
          [tgId, name, age, phone]
        );

        clearUserState(tgId);

        await ctx.reply(
          "Спасибо! ✅\n\n" +
            "Мы записали ваши данные и поставили вас в очередь ожидания.\n" +
            "Когда вас пригласят на собеседование или стажировку в Green Rocket, " +
            "вы получите уведомление в этом боте."
        );

        return;
      }

      // если почему-то шаг неизвестен — чистим и пускаем дальше
      clearUserState(tgId);
      return next();
    } catch (err) {
      logError("lk_waiting_onboarding_text", err);
      clearUserState(ctx.from.id);
      await ctx.reply(
        "Произошла ошибка при сохранении данных. Попробуйте ещё раз через /start."
      );
    }
  });

  bot.on("contact", async (ctx, next) => {
    const tgId = ctx.from.id;
    const st = getState(tgId);
    if (!st || st.step !== "phone") return next();

    try {
      const contact = ctx.message.contact;
      if (!contact || !contact.phone_number) {
        await ctx.reply(
          "Не удалось прочитать номер, попробуйте отправить ещё раз."
        );
        return;
      }

      const phone = contact.phone_number;
      const { name, age } = st;

      await pool.query(
        `
        INSERT INTO lk_waiting_users (telegram_id, full_name, age, phone, consent_given)
        VALUES ($1, $2, $3, $4, TRUE)
      `,
        [tgId, name, age, phone]
      );

      clearUserState(tgId);

      await ctx.reply(
        "Спасибо! ✅\n\n" +
          "Мы записали ваши данные и поставили вас в очередь ожидания.\n" +
          "Когда вас пригласят на собеседование или стажировку, вы получите уведомление в этом боте.",
        { reply_markup: { remove_keyboard: true } }
      );
    } catch (err) {
      logError("lk_waiting_onboarding_contact", err);
      clearUserState(tgId);
      await ctx.reply(
        "Произошла ошибка при сохранении данных. Попробуйте ещё раз через /start.",
        { reply_markup: { remove_keyboard: true } }
      );
    }
  });
}

module.exports = {
  registerWaitingOnboarding,
  startWaitingOnboarding,
};
