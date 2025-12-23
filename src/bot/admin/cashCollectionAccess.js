// // src/bot/admin/cashCollectionAccess.js
// const { Markup } = require("telegraf");
// const pool = require("../../db/pool");
// const { deliver } = require("../../utils/renderHelpers");

// function isAdmin(user) {
//   return user && (user.role === "admin" || user.role === "super_admin");
// }

// const stMap = new Map();
// function getSt(tgId) {
//   return stMap.get(tgId) || null;
// }
// function setSt(tgId, patch) {
//   const prev = stMap.get(tgId) || {};
//   stMap.set(tgId, { ...prev, ...patch });
// }
// function clearSt(tgId) {
//   stMap.delete(tgId);
// }

// async function loadPointsPage(page = 0, limit = 10) {
//   const off = page * limit;
//   const res = await pool.query(
//     `
//     SELECT id, title
//     FROM trade_points
//     ORDER BY title ASC, id ASC
//     LIMIT $1 OFFSET $2
//     `,
//     [limit, off]
//   );
//   return res.rows;
// }

// async function countPoints() {
//   const r = await pool.query(`SELECT COUNT(*)::int AS c FROM trade_points`);
//   return r.rows[0]?.c || 0;
// }

// async function loadUsersPage(page = 0, limit = 10) {
//   const off = page * limit;
//   const res = await pool.query(
//     `
//     SELECT id, full_name, username, work_phone
//     FROM users
//     ORDER BY full_name NULLS LAST, id ASC
//     LIMIT $1 OFFSET $2
//     `,
//     [limit, off]
//   );
//   return res.rows;
// }

// async function countUsers() {
//   const r = await pool.query(`SELECT COUNT(*)::int AS c FROM users`);
//   return r.rows[0]?.c || 0;
// }

// // checked = пользователь имеет доступ НА ВСЕ выбранные точки
// async function loadCheckedUserIdsForPoints(pointIds) {
//   if (!pointIds?.length) return new Set();
//   const res = await pool.query(
//     `
//     SELECT user_id
//     FROM trade_point_responsibles
//     WHERE event_type = 'cash_collection_access'
//       AND is_active = TRUE
//       AND trade_point_id = ANY($1::int[])
//     GROUP BY user_id
//     HAVING COUNT(*) = $2
//     `,
//     [pointIds.map(Number), pointIds.length]
//   );
//   return new Set(res.rows.map((x) => Number(x.user_id)));
// }

// async function setAccessForUserOnPoints({ pointIds, userId, active, adminId }) {
//   const tpIds = pointIds.map(Number);
//   const uid = Number(userId);

//   if (active) {
//     await pool.query(
//       `
//       INSERT INTO trade_point_responsibles (
//         trade_point_id, event_type, user_id, created_by_user_id, is_active
//       )
//       SELECT tp_id, 'cash_collection_access', $2, $3, TRUE
//       FROM unnest($1::int[]) AS tp_id
//       ON CONFLICT (trade_point_id, event_type, user_id)
//       DO UPDATE SET
//         is_active = TRUE,
//         created_by_user_id = EXCLUDED.created_by_user_id
//       `,
//       [tpIds, uid, Number(adminId)]
//     );
//   } else {
//     await pool.query(
//       `
//       UPDATE trade_point_responsibles
//       SET is_active = FALSE,
//           created_by_user_id = $3
//       WHERE event_type = 'cash_collection_access'
//         AND user_id = $2
//         AND trade_point_id = ANY($1::int[])
//       `,
//       [tpIds, uid, Number(adminId)]
//     );
//   }
// }

// async function renderPickPoints(ctx) {
//   const st = getSt(ctx.from.id) || {};
//   const page = Number(st.pointsPage || 0);
//   const selected = new Set((st.selectedPointIds || []).map(Number));

//   const [rows, total] = await Promise.all([
//     loadPointsPage(page, 10),
//     countPoints(),
//   ]);

//   const kbRows = [];
//   rows.forEach((p) => {
//     const on = selected.has(Number(p.id));
//     kbRows.push([
//       Markup.button.callback(
//         `${on ? "✅" : "⬜️"} ${p.title}`,
//         `admin_cash_access_tp_${p.id}`
//       ),
//     ]);
//   });

//   kbRows.push([
//     Markup.button.callback("✅ Выбрать все", "admin_cash_access_tp_all"),
//   ]);

//   const hasMore = (page + 1) * 10 < total;
//   if (hasMore)
//     kbRows.push([
//       Markup.button.callback("➡️ ещё", "admin_cash_access_tp_more"),
//     ]);

//   kbRows.push([
//     Markup.button.callback("➡️ Далее", "admin_cash_access_tp_next"),
//   ]);
//   kbRows.push([Markup.button.callback("⬅️ Назад", "admin_resp_root")]);

//   const text =
//     "💰 <b>Доступ к инкассации</b>\n\n" +
//     "Шаг 1/2: выберите торговые точки (мультивыбор).";

//   await deliver(
//     ctx,
//     { text, extra: { ...Markup.inlineKeyboard(kbRows), parse_mode: "HTML" } },
//     { edit: true }
//   );
// }

// async function renderPickUsers(ctx) {
//   const st = getSt(ctx.from.id) || {};
//   const page = Number(st.usersPage || 0);
//   const pointIds = (st.selectedPointIds || []).map(Number);

//   if (!pointIds.length) {
//     await ctx.answerCbQuery("Сначала выберите точки").catch(() => {});
//     return renderPickPoints(ctx);
//   }

//   const [users, total, checkedSet] = await Promise.all([
//     loadUsersPage(page, 10),
//     countUsers(),
//     loadCheckedUserIdsForPoints(pointIds),
//   ]);

//   const kbRows = [];
//   users.forEach((u) => {
//     const uid = Number(u.id);
//     const on = checkedSet.has(uid);
//     const labelName = u.full_name || u.username || u.work_phone || `#${uid}`;
//     kbRows.push([
//       Markup.button.callback(
//         `${on ? "✅" : "⬜️"} ${labelName}`,
//         `admin_cash_access_user_${uid}`
//       ),
//     ]);
//   });

//   kbRows.push([
//     Markup.button.callback(
//       "✅ Выбрать всех на странице",
//       "admin_cash_access_user_page_all"
//     ),
//   ]);

//   const hasMore = (page + 1) * 10 < total;
//   if (hasMore)
//     kbRows.push([
//       Markup.button.callback("➡️ ещё", "admin_cash_access_user_more"),
//     ]);

//   kbRows.push([
//     Markup.button.callback("⬅️ К точкам", "admin_cash_access_back_points"),
//   ]);

//   const text =
//     "💰 <b>Доступ к инкассации</b>\n\n" +
//     "Шаг 2/2: выберите сотрудников.\n" +
//     "Нажатие по сотруднику включает/выключает доступ для всех выбранных точек.";

//   await deliver(
//     ctx,
//     { text, extra: { ...Markup.inlineKeyboard(kbRows), parse_mode: "HTML" } },
//     { edit: true }
//   );
// }

// function registerAdminCashCollectionAccess(bot, ensureUser, logError) {
//   bot.action("admin_cash_access_root", async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const user = await ensureUser(ctx);
//       if (!isAdmin(user)) return;

//       setSt(ctx.from.id, {
//         step: "pick_points",
//         pointsPage: 0,
//         usersPage: 0,
//         selectedPointIds: [],
//       });

//       await renderPickPoints(ctx);
//     } catch (e) {
//       logError("admin_cash_access_root", e);
//     }
//   });

//   bot.action(/^admin_cash_access_tp_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const user = await ensureUser(ctx);
//       if (!isAdmin(user)) return;

//       const tpId = Number(ctx.match[1]);
//       const st = getSt(ctx.from.id) || {};
//       const selected = new Set((st.selectedPointIds || []).map(Number));
//       if (selected.has(tpId)) selected.delete(tpId);
//       else selected.add(tpId);

//       setSt(ctx.from.id, { selectedPointIds: Array.from(selected) });
//       await renderPickPoints(ctx);
//     } catch (e) {
//       logError("admin_cash_access_tp_toggle", e);
//     }
//   });

//   bot.action("admin_cash_access_tp_all", async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const user = await ensureUser(ctx);
//       if (!isAdmin(user)) return;

//       const all = await pool.query(
//         `SELECT id FROM trade_points ORDER BY title ASC, id ASC`
//       );
//       setSt(ctx.from.id, {
//         selectedPointIds: all.rows.map((r) => Number(r.id)),
//       });
//       await renderPickPoints(ctx);
//     } catch (e) {
//       logError("admin_cash_access_tp_all", e);
//     }
//   });

//   bot.action("admin_cash_access_tp_more", async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const user = await ensureUser(ctx);
//       if (!isAdmin(user)) return;

//       const st = getSt(ctx.from.id) || {};
//       setSt(ctx.from.id, { pointsPage: Number(st.pointsPage || 0) + 1 });
//       await renderPickPoints(ctx);
//     } catch (e) {
//       logError("admin_cash_access_tp_more", e);
//     }
//   });

//   bot.action("admin_cash_access_tp_next", async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const user = await ensureUser(ctx);
//       if (!isAdmin(user)) return;

//       const st = getSt(ctx.from.id) || {};
//       if (!st.selectedPointIds || st.selectedPointIds.length === 0) {
//         await ctx
//           .answerCbQuery("Выберите хотя бы одну точку", { show_alert: true })
//           .catch(() => {});
//         return;
//       }

//       setSt(ctx.from.id, { step: "pick_users", usersPage: 0 });
//       await renderPickUsers(ctx);
//     } catch (e) {
//       logError("admin_cash_access_tp_next", e);
//     }
//   });

//   bot.action("admin_cash_access_back_points", async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const user = await ensureUser(ctx);
//       if (!isAdmin(user)) return;

//       setSt(ctx.from.id, { step: "pick_points", pointsPage: 0, usersPage: 0 });
//       await renderPickPoints(ctx);
//     } catch (e) {
//       logError("admin_cash_access_back_points", e);
//     }
//   });

//   bot.action("admin_cash_access_user_more", async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const user = await ensureUser(ctx);
//       if (!isAdmin(user)) return;

//       const st = getSt(ctx.from.id) || {};
//       setSt(ctx.from.id, { usersPage: Number(st.usersPage || 0) + 1 });
//       await renderPickUsers(ctx);
//     } catch (e) {
//       logError("admin_cash_access_user_more", e);
//     }
//   });

//   bot.action(/^admin_cash_access_user_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const st = getSt(ctx.from.id) || {};
//       const pointIds = (st.selectedPointIds || []).map(Number);
//       const userId = Number(ctx.match[1]);

//       const checkedSet = await loadCheckedUserIdsForPoints(pointIds);
//       const isOn = checkedSet.has(userId);

//       // toggle: если был доступ на всех точках -> снимаем, иначе назначаем
//       await setAccessForUserOnPoints({
//         pointIds,
//         userId,
//         active: !isOn,
//         adminId: admin.id,
//       });

//       await renderPickUsers(ctx);
//     } catch (e) {
//       logError("admin_cash_access_user_toggle", e);
//     }
//   });

//   bot.action("admin_cash_access_user_page_all", async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const admin = await ensureUser(ctx);
//       if (!isAdmin(admin)) return;

//       const st = getSt(ctx.from.id) || {};
//       const pointIds = (st.selectedPointIds || []).map(Number);
//       const page = Number(st.usersPage || 0);

//       const users = await loadUsersPage(page, 10);
//       const ids = users.map((u) => Number(u.id));

//       // назначим доступ всем на странице
//       for (const uid of ids) {
//         await setAccessForUserOnPoints({
//           pointIds,
//           userId: uid,
//           active: true,
//           adminId: admin.id,
//         });
//       }

//       await renderPickUsers(ctx);
//     } catch (e) {
//       logError("admin_cash_access_user_page_all", e);
//     }
//   });
// }

// module.exports = { registerAdminCashCollectionAccess };
