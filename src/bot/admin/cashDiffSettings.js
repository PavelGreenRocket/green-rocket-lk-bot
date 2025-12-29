// src/bot/admin/cashDiffSettings.js

const { Markup } = require("telegraf");
const pool = require("../../db/pool");
const { deliver } = require("../../utils/renderHelpers");

const { getUserState, setUserState, clearUserState } = require("../state");

const MODE = "admin_cash_diff_threshold";

async function getSettings() {
  const r = await pool.query(
    `
    SELECT shortage_threshold, surplus_threshold, updated_at, updated_by_user_id
    FROM cash_diff_settings
    WHERE id = 1
    `
  );
  if (r.rows[0]) return r.rows[0];
  // fallback (на всякий)
  await pool.query(
    `INSERT INTO cash_diff_settings (id) VALUES (1) ON CONFLICT DO NOTHING`
  );
  const r2 = await pool.query(
    `SELECT shortage_threshold, surplus_threshold, updated_at, updated_by_user_id FROM cash_diff_settings WHERE id=1`
  );
  return r2.rows[0];
}

async function setThreshold(kind, value, adminId) {
  if (kind !== "shortage" && kind !== "surplus") throw new Error("bad kind");
  const col = kind === "shortage" ? "shortage_threshold" : "surplus_threshold";
  await pool.query(
    `
    UPDATE cash_diff_settings
    SET ${col} = $1,
        updated_at = now(),
        updated_by_user_id = $2
    WHERE id = 1
    `,
    [value, adminId]
  );
}

function title(kind) {
  return kind === "shortage" ? "❗ Порог недостачи" : "💸 Порог излишек";
}

function explain() {
  return (
    "Если разница между *ожидаемыми* наличными в кассе и тем, что сотрудник указал *в конце смены*, " +
    "превышает порог — ответственным придёт уведомление.\n\n" +
    "Ожидаемо в конце смены = `наличные в начале + наличные продажи - инкассация`"
  );
}

async function showThresholdScreen(ctx, admin, kind, { edit = true } = {}) {
  const s = await getSettings();
  const val = kind === "shortage" ? s.shortage_threshold : s.surplus_threshold;

  const text =
    `*${title(kind)}*\n\n` +
    `Текущее значение: *${Number(val || 0)} ₽*\n\n` +
    `${explain()}`;

  const kb = Markup.inlineKeyboard([
    [
      Markup.button.callback(
        "✏️ Изменить порог",
        `admin_cashdiff_${kind}_edit`
      ),
    ],
    [Markup.button.callback("⬅️ Назад", "admin_shift_settings")],
  ]);

  await deliver(
    ctx,
    { text, extra: { ...kb, parse_mode: "Markdown" } },
    { edit }
  );
}

function registerCashDiffSettings(bot) {
  // открыть экран недостачи
  bot.action("admin_cashdiff_shortage_open", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;
      await showThresholdScreen(ctx, admin, "shortage", { edit: true });
    } catch (e) {
      console.error("[admin_cashdiff_shortage_open]", e);
    }
  });

  // открыть экран излишек
  bot.action("admin_cashdiff_surplus_open", async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;
      await showThresholdScreen(ctx, admin, "surplus", { edit: true });
    } catch (e) {
      console.error("[admin_cashdiff_surplus_open]", e);
    }
  });

  // перейти в режим ввода
  bot.action(/^admin_cashdiff_(shortage|surplus)_edit$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const kind = ctx.match[1];
      setUserState(ctx.from.id, { mode: MODE, kind });

      const kb = Markup.inlineKeyboard([
        [Markup.button.callback("⬅️ Назад", `admin_cashdiff_${kind}_cancel`)],
      ]);

      await deliver(
        ctx,
        {
          text:
            `Введите новое значение для: *${title(kind)}*\n\n` +
            "Число в рублях (можно 0).",
          extra: { ...kb, parse_mode: "Markdown" },
        },
        { edit: true }
      );
    } catch (e) {
      console.error("[admin_cashdiff_edit]", e);
    }
  });

  bot.action(/^admin_cashdiff_(shortage|surplus)_cancel$/, async (ctx) => {
    try {
      await ctx.answerCbQuery().catch(() => {});
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) return;

      const kind = ctx.match[1];
      clearUserState(ctx.from.id);
      await showThresholdScreen(ctx, admin, kind, { edit: true });
    } catch (e) {
      console.error("[admin_cashdiff_cancel]", e);
    }
  });

  // text handler
  bot.on("text", async (ctx, next) => {
    const st = getUserState(ctx.from.id);
    if (!st || st.mode !== MODE) return next();

    try {
      const admin = await ensureUser(ctx);
      if (!isAdmin(admin)) {
        clearUserState(ctx.from.id);
        return;
      }

      const kind = st.kind;
      const raw = String(ctx.message.text || "")
        .trim()
        .replace(",", ".");
      const v = Number(raw);

      if (!Number.isFinite(v) || v < 0) {
        await ctx.reply("Введите число ≥ 0 (например: 500).");
        return;
      }

      await setThreshold(kind, v, admin.id);
      clearUserState(ctx.from.id);

      await ctx.reply("✅ Сохранено.");
      await showThresholdScreen(ctx, admin, kind, { edit: false });
    } catch (e) {
      console.error("[admin_cashdiff_text]", e);
      clearUserState(ctx.from.id);
      await ctx.reply("Ошибка сохранения. Попробуй ещё раз.");
    }
  });
}

module.exports = { registerCashDiffSettings };
