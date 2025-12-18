// src/bot/shifts/flow.js
function registerShiftFlow(bot, ensureUser, logError) {
  bot.action("lk_shift_toggle", async (ctx) => {
    try {
      const user = await ensureUser(ctx);
      if (!user) {
        await ctx.answerCbQuery().catch(() => {});
        return;
      }

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

      await ctx
        .answerCbQuery("Скоро тут будет открытие/закрытие смены ✅", {
          show_alert: true,
        })
        .catch(() => {});
    } catch (err) {
      logError("lk_shift_toggle", err);
      await ctx.answerCbQuery("Ошибка", { show_alert: true }).catch(() => {});
    }
  });
}

module.exports = { registerShiftFlow };
