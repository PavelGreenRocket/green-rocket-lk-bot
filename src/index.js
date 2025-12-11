//src\index.js
require("dotenv").config();
const { Telegraf } = require("telegraf");
const pool = require("./db/pool");
const { registerLkBot } = require("./bot");
const { registerInternshipUser } = require("./bot/internshipUser");
const {
  registerWaitingOnboarding,
  startWaitingOnboarding,
} = require("./bot/onboarding");
const { buildStatusText, buildMainKeyboard } = require("./bot/menu");
const { deliver } = require("./utils/renderHelpers");

const BOT_TOKEN = process.env.BOT_TOKEN_LK;

if (!BOT_TOKEN) {
  throw new Error("Не указан BOT_TOKEN_LK в .env");
}

const bot = new Telegraf(BOT_TOKEN);

// Простенький логгер ошибок
function logError(tag, err) {
  console.error(`[${tag}]`, err);
}

async function ensureUser(ctx) {
  const tgId = ctx.from?.id;
  if (!tgId) return null;

  // 1. Пытаемся найти полноценного пользователя
  const res = await pool.query(
    `
      SELECT id, full_name, role, staff_status, position, candidate_id
      FROM users
      WHERE telegram_id = $1
    `,
    [tgId]
  );

  if (res.rows.length) {
    return res.rows[0]; // уже полноценный пользователь ЛК
  }

  // 2. Пользователь пока не в users — смотрим, есть ли он в таблице ожидания
  const waitRes = await pool.query(
    `
      SELECT full_name, age, phone, created_at
      FROM lk_waiting_users
      WHERE telegram_id = $1
      ORDER BY id DESC
      LIMIT 1
    `,
    [tgId]
  );

  if (waitRes.rows.length) {
    // Мы уже взяли у человека данные, просто напоминаем, что он "в очереди"
    await ctx.reply(
      "Привет! 👋\n\n" +
        "Мы уже записали ваши контакты и ждём, когда вас пригласят " +
        "на собеседование или стажировку.\n" +
        "Как только это произойдёт, вы получите уведомление в этом боте."
    );
    return null;
  }

  // 3. Совсем новый человек — запускаем онбординг (опрос имя/возраст/телефон)
  await startWaitingOnboarding(ctx);
  return null;
}

// Универсальный показ главного меню (его ты уже используешь в notifications)
async function showMainMenu(ctx) {
  const user = await ensureUser(ctx);
  if (!user) return;

  const text = await buildStatusText(user);
  const keyboard = await buildMainKeyboard(user);

  await deliver(
    ctx,
    {
      text,
      extra: keyboard,
    },
    { edit: false }
  );
}

// Регистрация всех хендлеров ЛК-бота
registerWaitingOnboarding(bot, logError);

registerLkBot(bot, ensureUser, logError);
registerInternshipUser(bot, ensureUser, logError, showMainMenu);
// Запускаем
bot.launch().then(() => {
  console.log("✅ ЛК-бот запущен");
});

// Красивое завершение
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
