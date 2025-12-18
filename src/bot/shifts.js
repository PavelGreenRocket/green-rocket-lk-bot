function registerShifts(bot, ensureUser, logError) {
  bot.action("lk_shift_toggle", async (ctx) => {
    try {
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

      await ctx
        .answerCbQuery("Функционал учёта смен пока не готов.", {
          show_alert: true,
        })
        .catch(() => {});
    } catch (err) {
      logError("lk_shift_toggle", err);
      // на всякий случай, чтобы не зависали “часики”
      await ctx.answerCbQuery("Ошибка", { show_alert: true }).catch(() => {});
    }
  });
}
