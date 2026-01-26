
// src/utils/toast.js
async function toast(ctx, text) {
  // Если text не передали (undefined/null/""), не показываем "undefined"
  if (text === undefined || text === null) {
    return ctx.answerCbQuery().catch(() => {});
  }
  const msg = String(text).trim();
  if (!msg) {
    return ctx.answerCbQuery().catch(() => {});
  }
  await ctx.answerCbQuery(msg, { show_alert: false }).catch(() => {});
}


async function alert(ctx, text) {
  await ctx.answerCbQuery(text, { show_alert: true }).catch(() => {});
}

module.exports = { toast, alert };
