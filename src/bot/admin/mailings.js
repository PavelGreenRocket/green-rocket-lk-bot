const { Markup } = require("telegraf");
const { deliver } = require("../../utils/renderHelpers");

function registerAdminMailings(bot, ensureUser, logError) {
  bot.action("admin_mailings", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user || (user.role !== "admin" && user.role !== "super_admin"))
        return;

      const text =
        "📢 *Рассылки*\n\n" +
        "Здесь позже появятся:\n" +
        "• массовые уведомления\n" +
        "• шаблоны уведомлений\n" +
        "• события автопроверок\n";

      const keyboard = Markup.inlineKeyboard([
        [{ text: "⬅️ Назад", callback_data: "lk_admin_menu" }],
      ]);

      await deliver(ctx, { text, extra: keyboard }, { edit: true });
    } catch (err) {
      logError("admin_mailings", err);
    }
  });
}

module.exports = { registerAdminMailings };
