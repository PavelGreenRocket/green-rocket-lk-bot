// src/utils/toast.js
async function toast(ctx, text) {
  // toast = answerCbQuery без show_alert (не модалка)
  await ctx.answerCbQuery(text, { show_alert: false }).catch(() => {});
}

async function alert(ctx, text) {
  await ctx.answerCbQuery(text, { show_alert: true }).catch(() => {});
}

module.exports = { toast, alert };
