const { deliver } = require("../utils/renderHelpers");

function registerShifts(bot, ensureUser, logError) {
  bot.action("lk_shift_toggle", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const user = await ensureUser(ctx);
      if (!user) return;

      const staffStatus = user.staff_status || "worker";

      if (staffStatus === "candidate") {
        await ctx
          .answerCbQuery(
            "Ракета ещё на старте.\nОткрыть смену можно будет после начала стажировки.",
            { show_alert: true }
          )
          .catch(() => {});
        return;
      }

      // стажёр / работник
      await ctx
        .answerCbQuery("Функционал учёта смен пока не готов.", {
          show_alert: true,
        })
        .catch(() => {});
    } catch (err) {
      logError("lk_shift_toggle", err);
    }
  });
}

module.exports = { registerShifts };
