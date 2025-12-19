// src/bot/admin/shiftSettings.js
const { Markup } = require("telegraf");
const { deliver } = require("../../utils/renderHelpers");

function registerAdminShiftSettings(bot, ensureUser, logError) {
  // -----------------------------
  // Вход в "Настройка смен"
  // -----------------------------
  bot.action("admin_shift_settings", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin"))
        return;

      const text = "🛠 <b>Настройка смен</b>\n\nВыберите раздел:";
      const keyboard = Markup.inlineKeyboard([
        [
          {
            text: "🚀 Задачи открытия смены",
            callback_data: "admin_shift_opening_root",
          },
        ],
        [
          {
            text: "📋 Задачи смены (в течении дня)",
            callback_data: "admin_shift_day_root",
          },
        ],
        [
          {
            text: "🛑 Задачи закрытия смены",
            callback_data: "admin_shift_closing_root",
          },
        ],
        [{ text: "⬅️ Назад", callback_data: "admin_settings_company" }],
      ]);

      await deliver(ctx, { text, extra: keyboard }, { edit: true });
    } catch (err) {
      logError("admin_shift_settings", err);
    }
  });

  // -----------------------------
  // Заглушки разделов (пока)
  // -----------------------------
  bot.action(/^(admin_shift_day_root)$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin"))
        return;

      const key = ctx.callbackQuery.data;
      const title =
        key === "admin_shift_opening_root"
          ? "🚀 Задачи открытия смены"
          : key === "admin_shift_day_root"
          ? "📋 Задачи смены (в течении дня)"
          : "🛑 Задачи закрытия смены";

      const text = `${title}\n\nРаздел в разработке. Следующим модулем добавим CRUD задач.`;
      const keyboard = Markup.inlineKeyboard([
        [{ text: "⬅️ Назад", callback_data: "admin_shift_settings" }],
      ]);

      await deliver(ctx, { text, extra: keyboard }, { edit: true });
    } catch (err) {
      logError("admin_shift_settings_section_stub", err);
    }
  });
}

module.exports = { registerAdminShiftSettings };
