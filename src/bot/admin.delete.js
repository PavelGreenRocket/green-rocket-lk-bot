// const { Markup } = require("telegraf");
// const pool = require("../db/pool");
// const { deliver } = require("../utils/renderHelpers");
// const { setUserState, getUserState, clearUserState } = require("./state");


// // =========================
// //  /role  — работает ТОЛЬКО здесь
// // =========================

// function buildRoleKeyboard(user) {
//   const staffStatus = user.staff_status || "worker";
//   const role = user.role || "user";
//   const position = user.position || null;

//   const staffButtons = [
//     Markup.button.callback(
//       (staffStatus === "candidate" ? "✅ " : "") + "Кандидат",
//       "lk_role_status_candidate"
//     ),
//     Markup.button.callback(
//       (staffStatus === "intern" ? "✅ " : "") + "Стажёр",
//       "lk_role_status_intern"
//     ),
//     Markup.button.callback(
//       (staffStatus === "worker" ? "✅ " : "") + "Работник",
//       "lk_role_status_worker"
//     ),
//   ];

//   const roleButtons = [
//     Markup.button.callback(
//       (role === "super_admin" ? "✅ " : "") + "Супер админ",
//       "lk_role_role_super_admin"
//     ),
//     Markup.button.callback(
//       (role === "admin" ? "✅ " : "") + "Админ",
//       "lk_role_role_admin"
//     ),
//     Markup.button.callback(
//       (role === "user" ? "✅ " : "") + "Пользователь",
//       "lk_role_role_user"
//     ),
//   ];

//   const positionButtons = [
//     Markup.button.callback(
//       (position === "barista" ? "✅ " : "") + "Бариста",
//       "lk_role_pos_barista"
//     ),
//     Markup.button.callback(
//       (position === "point_admin" ? "✅ " : "") + "Админ точки",
//       "lk_role_pos_point_admin"
//     ),
//     Markup.button.callback(
//       (position === "senior_admin" ? "✅ " : "") + "Старший админ",
//       "lk_role_pos_senior_admin"
//     ),
//     Markup.button.callback(
//       (position === "quality_manager" ? "✅ " : "") + "Менеджер по качеству",
//       "lk_role_pos_quality_manager"
//     ),
//     Markup.button.callback(
//       (position === "manager" ? "✅ " : "") + "Управляющий",
//       "lk_role_pos_manager"
//     ),
//   ];

//   return Markup.inlineKeyboard([
//     staffButtons,
//     roleButtons,
//     positionButtons,
//     [Markup.button.callback("⬅️ В меню", "lk_main_menu")],
//   ]);
// }

// function buildRoleText(user) {
//   const name = user.full_name || "Без имени";
//   const staffStatus = user.staff_status || "worker";
//   const role = user.role || "user";
//   const position = user.position || null;

//   const staffLabel =
//     staffStatus === "candidate"
//       ? "кандидат"
//       : staffStatus === "intern"
//       ? "стажёр"
//       : "работник";

//   let roleLabel = role;
//   if (role === "super_admin") roleLabel = "супер админ";
//   if (role === "admin") roleLabel = "админ";
//   if (role === "user") roleLabel = "пользователь";

//   let posLabel = "не указана";
//   if (position === "barista") posLabel = "бариста";
//   if (position === "point_admin") posLabel = "администратор точки";
//   if (position === "senior_admin") posLabel = "старший администратор";
//   if (position === "quality_manager") posLabel = "менеджер по качеству";
//   if (position === "manager") posLabel = "управляющий";

//   return (
//     "🔐 Панель /role\n\n" +
//     `Имя: ${name}\n` +
//     `Текущий статус: ${staffLabel}\n` +
//     `Текущая роль: ${roleLabel}\n` +
//     `Должность: ${posLabel}\n\n` +
//     "Выбери, что хочешь поменять кнопками ниже."
//   );
// }

// function registerRolePanel(bot, ensureUser, logError) {
//   bot.command("role", async (ctx) => {
//     try {
//       const user = await ensureUser(ctx);
//       if (!user) return;

//       const tgId = ctx.from.id;
//       setUserState(tgId, { mode: "awaiting_role_password" });

//       await ctx.reply(
//         "Введите пароль для входа в режим /role:\nЕсли передумали — отправьте /cancel."
//       );
//     } catch (err) {
//       logError("lk_role_command", err);
//     }
//   });

//   bot.command("cancel", async (ctx) => {
//     const tgId = ctx.from.id;
//     clearUserState(tgId);
//     await ctx.reply("Действие отменено.");
//   });

//   bot.on("text", async (ctx, next) => {
//     const tgId = ctx.from.id;
//     const state = getUserState(tgId);

//     if (!state || state.mode !== "awaiting_role_password") {
//       return next && next();
//     }

//     const password = ctx.message.text.trim();
//     if (password !== "GR") {
//       await ctx.reply(
//         "Неверный пароль, попробуйте ещё раз или отправьте /cancel."
//       );
//       return;
//     }

//     clearUserState(tgId);
//     const user = await ensureUser(ctx);
//     if (!user) return;

//     const text = buildRoleText(user);
//     const keyboard = buildRoleKeyboard(user);

//     await ctx.reply(text, keyboard);
//   });

//   async function reloadUser(ctx) {
//     const tgId = ctx.from.id;
//     const res = await pool.query(
//       "SELECT id, full_name, role, staff_status, position FROM users WHERE telegram_id = $1",
//       [tgId]
//     );
//     return res.rows[0];
//   }

//   bot.action(/lk_role_status_(candidate|intern|worker)/, async (ctx) => {
//     const user = await ensureUser(ctx);
//     if (!user) return;

//     const status = ctx.match[1];
//     await pool.query("UPDATE users SET staff_status = $1 WHERE id = $2", [
//       status,
//       user.id,
//     ]);

//     const freshUser = await reloadUser(ctx);
//     await deliver(
//       ctx,
//       {
//         text: buildRoleText(freshUser),
//         extra: buildRoleKeyboard(freshUser),
//       },
//       { edit: true }
//     );
//   });

//   bot.action(/lk_role_role_(super_admin|admin|user)/, async (ctx) => {
//     const user = await ensureUser(ctx);
//     if (!user) return;

//     const role = ctx.match[1];
//     await pool.query("UPDATE users SET role = $1 WHERE id = $2", [
//       role,
//       user.id,
//     ]);

//     const freshUser = await reloadUser(ctx);
//     await deliver(
//       ctx,
//       {
//         text: buildRoleText(freshUser),
//         extra: buildRoleKeyboard(freshUser),
//       },
//       { edit: true }
//     );
//   });

//   bot.action(
//     /lk_role_pos_(barista|point_admin|senior_admin|quality_manager|manager)/,
//     async (ctx) => {
//       const user = await ensureUser(ctx);
//       if (!user) return;

//       const pos = ctx.match[1];
//       await pool.query("UPDATE users SET position = $1 WHERE id = $2", [
//         pos,
//         user.id,
//       ]);

//       const freshUser = await reloadUser(ctx);
//       await deliver(
//         ctx,
//         {
//           text: buildRoleText(freshUser),
//           extra: buildRoleKeyboard(freshUser),
//         },
//         { edit: true }
//       );
//     }
//   );
// }

// module.exports = { registerRolePanel };
