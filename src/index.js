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
const { startOutboxWorker } = require("./outbox/worker");
const {
  startShiftOpeningControlWatcher,
} = require("./bot/shifts/shiftOpeningControlWatcher");

const BOT_TOKEN = process.env.BOT_TOKEN_LK;

if (!BOT_TOKEN) {
  throw new Error("Не указан BOT_TOKEN_LK в .env");
}

const bot = new Telegraf(BOT_TOKEN);
startOutboxWorker(bot);
startShiftOpeningControlWatcher({ intervalMs: 60_000, logError });

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
    return res.rows[0];
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
    await ctx.reply(
      "Привет! 👋\n\n" +
        "Мы уже записали ваши контакты и ждём, когда вас пригласят " +
        "на собеседование или стажировку.\n" +
        "Как только это произойдёт, вы получите уведомление в этом боте."
    );
    return null;
  }

  // 3. Совсем новый человек — запускаем онбординг
  await startWaitingOnboarding(ctx);
  return null;
}

// Универсальный показ главного меню
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
bot.use(async (ctx, next) => {
  try {
    return await next();
  } catch (err) {
    console.error("💥 Unhandled middleware error:", err);
    // чтобы юзер не зависал в ожидании
    try {
      await ctx.reply("⚠️ Ошибка. Попробуйте ещё раз.");
    } catch (_) {}
  }
});

// Регистрация всех хендлеров
registerWaitingOnboarding(bot, logError);
registerLkBot(bot, ensureUser, logError);
registerInternshipUser(bot, ensureUser, logError, showMainMenu);
process.on("unhandledRejection", (r) => console.error("unhandledRejection", r));
process.on("uncaughtException", (e) => console.error("uncaughtException", e));

// Глобальная обработка ошибок telegraf
bot.catch((err, ctx) => {
  console.error("❌ Telegraf error for update", ctx?.updateType, err);
});

async function main() {
  await bot.telegram.deleteWebhook({ drop_pending_updates: true });

  const me = await bot.telegram.getMe();
  console.log("🤖 Running as:", me.username);

  bot.use((ctx, next) => {
    console.log("📩 update:", ctx.updateType, ctx.message?.text);
    return next();
  });

  await bot.launch({ dropPendingUpdates: true });
  console.log("✅ ЛК-бот запущен");
}

main().catch((err) => {
  console.error("❌ startup failed:", err);
  process.exit(1);
});

// Красивое завершение
process.once("SIGINT", () => bot.stop("SIGINT"));
process.once("SIGTERM", () => bot.stop("SIGTERM"));
0;
