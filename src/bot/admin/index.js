// src/bot/admin/index.js
const { Markup } = require("telegraf");
const { deliver } = require("../../utils/renderHelpers");
const registerAdminUsers = require("./users");
const { registerAdminMailings } = require("./mailings");
const { registerAdminSettings } = require("./settings");
const { registerAdminTasks } = require("./tasks");
const { registerAdminShiftTasks } = require("./shiftTasks");
const { registerAdminPositions } = require("./positions");

function registerAdminPanel(bot, ensureUser, logError) {
  bot.action("lk_admin_menu", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin"))
        return;

      const text = "🛠 <b>Админ-панель</b>\n\nВыберите раздел:";
      const keyboard = Markup.inlineKeyboard([
        [{ text: "👥 Пользователи", callback_data: "admin_users" }],
        [{ text: "📋 Задачи смены", callback_data: "admin_shift_tasks" }],
        [{ text: "📢 Рассылки", callback_data: "admin_mailings" }],
        [{ text: "⚙️ Настройки", callback_data: "admin_settings" }],
        [{ text: "⬅️ В меню", callback_data: "lk_main_menu" }],
      ]);

      await deliver(ctx, { text, extra: keyboard }, { edit: true });
    } catch (err) {
      logError("lk_admin_menu", err);
    }
  });

  registerAdminUsers(bot, ensureUser, logError, deliver);
  registerAdminMailings(bot, ensureUser, logError);
  registerAdminSettings(bot, ensureUser, logError);
  registerAdminTasks(bot, ensureUser, logError);
  registerAdminShiftTasks(bot, ensureUser, logError);
  registerAdminPositions(bot);
}

module.exports = { registerAdminPanel };
