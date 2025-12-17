// // src/bot/admin/users.js

// const { Markup } = require("telegraf");
// const pool = require("../../db/pool");
// const { deliver } = require("../../utils/renderHelpers");

// // --- состояние фильтров кандидатов по tg_id ---
// const candidateFiltersByTgId = new Map();

// // Состояние опроса "собеседование пройдено"
// const interviewResultByTgId = new Map();

// // Состояние опроса "пригласить на стажировку"
// const internshipStateByTgId = new Map();

// function getDefaultFilters() {
//   return {
//     cancelled: false,
//     arrived: true,
//     internshipInvited: true,
//     waiting: true,
//     scope: "personal", // personal | all
//     filtersExpanded: false,
//     historyExpanded: false,
//   };
// }

// function getFilterState(tgId) {
//   const existing = candidateFiltersByTgId.get(tgId);
//   if (!existing) return { ...getDefaultFilters() };
//   return { ...getDefaultFilters(), ...existing };
// }

// function setFilterState(tgId, patch) {
//   const current = getFilterState(tgId);
//   candidateFiltersByTgId.set(tgId, { ...current, ...patch });
// }



// // --- утилиты для кандидатов ---

// function getStatusIcon(status) {
//   switch (status) {
//     case "interviewed":
//       return "✔️";
//     case "internship_invited":
//       return "☑️";
//     case "cancelled":
//     case "declined":
//       return "❌";
//     case "invited":
//     default:
//       return "🕒";
//   }
// }

// function getStageLabel(status) {
//   switch (status) {
//     case "interviewed":
//       return "Собеседование проведено";
//     case "internship_invited":
//       return "Приглашён на стажировку";
//     case "cancelled":
//       return "Собеседование отменено";
//     case "invited":
//     default:
//       return "Ожидание собеседования";
//   }
// }

// // Шапка карточки кандидата по статусу
// function getCandidateHeader(status) {
//   switch (status) {
//     case "invited":
//       // ждет собеседования
//       return "🔻 КАНДИДАТ — ОЖИДАНИЕ СОБЕСЕДОВАНИЯ (🕒)";
//     case "interviewed":
//       // собеседование уже проведено, ждет решения
//       return "🔻 КАНДИДАТ — СОБЕСЕДОВАНИЕ ПРОВЕДЕНО (✔️)";
//     case "internship_invited":
//       // приглашен на стажировку
//       return "🔻 КАНДИДАТ — ПРИГЛАШЁН НА СТАЖИРОВКУ (☑️)";
//     case "cancelled":
//       return "🔻 КАНДИДАТ — СОБЕСЕДОВАНИЕ ОТМЕНЕНО (❌)";
//     case "declined":
//       return "🔻 КАНДИДАТ — ОТКАЗАНО (❌)";
//     default:
//       return "🔻 КАНДИДАТ";
//   }
// }

// const WEEK_DAYS = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

// function formatDateTimeShort(isoDate, timeStr) {
//   if (!isoDate && !timeStr) return "не указано";

//   let datePart = "";
//   let weekdayPart = "";
//   let date = null;

//   if (isoDate) {
//     if (isoDate instanceof Date) {
//       // если из БД пришёл Date
//       date = isoDate;
//     } else if (typeof isoDate === "string") {
//       // если строка вида "YYYY-MM-DD"
//       const parts = isoDate.split("-");
//       if (parts.length === 3) {
//         const [y, m, d] = parts.map((x) => parseInt(x, 10));
//         if (Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d)) {
//           date = new Date(y, m - 1, d);
//         }
//       }
//     }
//   }

//   if (date && !Number.isNaN(date.getTime())) {
//     const dd = String(date.getDate()).padStart(2, "0");
//     const mm = String(date.getMonth() + 1).padStart(2, "0");
//     datePart = `${dd}.${mm}`;
//     weekdayPart = WEEK_DAYS[date.getDay()];
//   }

//   let result = "";
//   if (datePart) result += datePart;
//   if (timeStr) result += (result ? " на " : "") + timeStr;
//   if (weekdayPart) result += ` (${weekdayPart})`;
//   return result || "не указано";
// }

// function formatDateTimeFull(isoDate, timeStr) {
//   if (!isoDate && !timeStr) return "не указана";
//   let datePart = "";
//   let weekdayPart = "";

//   if (isoDate) {
//     const [y, m, d] = isoDate.split("-").map((x) => parseInt(x, 10));
//     if (Number.isFinite(y) && Number.isFinite(m) && Number.isFinite(d)) {
//       const date = new Date(y, m - 1, d);
//       if (!Number.isNaN(date.getTime())) {
//         const dd = String(date.getDate()).padStart(2, "0");
//         const mm = String(date.getMonth() + 1).pad(2, "0");
//       }
//     }
//   }

//   // проще: используем короткую форму
//   return formatDateTimeShort(isoDate, timeStr);
// }

// // --- отображение списка кандидатов ---

// async function showCandidatesListLk(ctx, user, options = {}) {
//   const tgId = ctx.from.id;
//   const filters = getFilterState(tgId);
//   const editMode = options.edit !== false;

//   let allowedStatuses = [];
//   if (filters.waiting) allowedStatuses.push("invited");
//   if (filters.arrived) allowedStatuses.push("interviewed");
//   if (filters.internshipInvited) allowedStatuses.push("internship_invited");
//   if (filters.cancelled) allowedStatuses.push("cancelled");

//   if (!allowedStatuses.length) {
//     allowedStatuses = ["invited", "interviewed", "internship_invited"];
//   }

//   const params = [allowedStatuses];
//   let where = "c.status = ANY($1) AND c.status <> 'declined'";

//   if (filters.scope === "personal") {
//     params.push(user.id);
//     where += " AND c.admin_id = $2";
//   }

//   const res = await pool.query(
//     `
//       SELECT
//         c.id,
//         c.name,
//         c.age,
//         c.status,
//         c.interview_date,
//         c.interview_time,
//         COALESCE(tp_place.title, 'не указано')   AS place_title
//       FROM candidates c
//         LEFT JOIN trade_points tp_place ON c.point_id = tp_place.id
//       WHERE ${where}
//       ORDER BY
//         CASE c.status
//           WHEN 'invited' THEN 1
//           WHEN 'interviewed' THEN 2
//           WHEN 'internship_invited' THEN 3
//           WHEN 'cancelled' THEN 4
//           ELSE 5
//         END,
//         COALESCE(c.interview_time, '99:99'),
//         c.id DESC
//     `,
//     params
//   );

//   const candidates = res.rows;

//   let text = "🟢 *Кандидаты*\n\n";
//   text += "🕒 — приглашены на собеседование\n";
//   text += "✔️ — пришли на собеседование, ожидают решения\n";
//   text += "☑️ — приглашены на стажировку\n\n";

//   if (filters.scope === "personal") {
//     text += "Показаны только твои кандидаты.\n\n";
//   } else {
//     text += "Показаны все собеседования.\n\n";
//   }

//   if (!candidates.length) {
//     text += "⚠️ По текущим фильтрам кандидатов нет.\n";
//   } else {
//     text += "Выбери кандидата:\n\n";
//   }

//   const rows = [];

//   for (const cand of candidates) {
//     const icon = getStatusIcon(cand.status);
//     let main = cand.name || "Без имени";
//     if (cand.age) {
//       main += ` (${cand.age})`;
//     }
//     const dt = formatDateTimeShort(cand.interview_date, cand.interview_time);
//     const place =
//       cand.place_title && cand.place_title !== "не указано"
//         ? cand.place_title
//         : "";

//     let tail = "";
//     if (place && dt) tail = ` — ${place}, ${dt}`;
//     else if (place) tail = ` — ${place}`;
//     else if (dt) tail = ` — ${dt}`;

//     const label = `${icon} ${main}${tail}`;
//     rows.push([Markup.button.callback(label, `lk_admin_candidate_${cand.id}`)]);
//   }

//   // три режима: фильтры, история, обычный

//   if (filters.filtersExpanded) {
//     rows.push([
//       Markup.button.callback("🔼 Фильтр 🔼", "lk_cand_filter_toggle"),
//     ]);

//     const cancelLabel = filters.cancelled
//       ? "❌ отменённые ✅"
//       : "❌ отменённые";
//     const arrivedLabel = filters.arrived
//       ? "✔️ пришёл на собес ✅"
//       : "✔️ пришёл на собес";
//     const internshipLabel = filters.internshipInvited
//       ? "☑️ приглашены (стаж) ✅"
//       : "☑️ приглашены (стаж)";
//     const waitingLabel = filters.waiting ? "🕒 ожидание ✅" : "🕒 ожидание";

//     const personalLabel =
//       filters.scope === "personal" ? "👤 личные ✅" : "👤 личные";
//     const allLabel =
//       filters.scope === "all"
//         ? "👥 все собеседования ✅"
//         : "👥 все собеседования";

//     rows.push([
//       Markup.button.callback(cancelLabel, "lk_cand_filter_cancelled"),
//       Markup.button.callback(arrivedLabel, "lk_cand_filter_arrived"),
//     ]);
//     rows.push([
//       Markup.button.callback(internshipLabel, "lk_cand_filter_internship"),
//       Markup.button.callback(waitingLabel, "lk_cand_filter_waiting"),
//     ]);
//     rows.push([
//       Markup.button.callback(personalLabel, "lk_cand_filter_personal"),
//       Markup.button.callback(allLabel, "lk_cand_filter_all"),
//     ]);
//     rows.push([
//       Markup.button.callback("🔄 снять фильтр", "lk_cand_filter_reset"),
//     ]);
//     rows.push([Markup.button.callback("⬅️ Назад", "lk_admin_menu")]);
//   } else if (filters.historyExpanded) {
//     rows.push([
//       Markup.button.callback("🔼 скрыть 🔼", "lk_cand_toggle_history"),
//     ]);
//     rows.push([
//       Markup.button.callback("📜 история кандидатов", "lk_cand_history"),
//     ]);
//     rows.push([Markup.button.callback("⬅️ Назад", "lk_admin_menu")]);
//   } else {
//     rows.push([
//       Markup.button.callback("🔽 Фильтр 🔽", "lk_cand_filter_toggle"),
//       Markup.button.callback("🔽 раскрыть 🔽", "lk_cand_toggle_history"),
//     ]);

//     rows.push([
//       Markup.button.callback("✅ Кандидаты", "admin_users_candidates"),
//       Markup.button.callback("Стажёры", "admin_users_interns"),
//       Markup.button.callback("Сотрудники", "admin_users_workers"),
//     ]);

//     rows.push([
//       Markup.button.callback("+ добавить", "lk_add_candidate"),
//       Markup.button.callback("+ добавить", "lk_add_intern"),
//       Markup.button.callback("+ добавить", "lk_add_worker"),
//     ]);

//     rows.push([Markup.button.callback("⬅️ Назад", "lk_admin_menu")]);
//   }

//   const keyboard = Markup.inlineKeyboard(rows);
//   const extra = { ...keyboard, parse_mode: "Markdown" };

//   const shouldEdit =
//     typeof options.edit === "boolean"
//       ? options.edit
//       : ctx.updateType === "callback_query";

//   await deliver(
//     ctx,
//     {
//       text,
//       extra,
//     },
//     { edit: shouldEdit }
//   );
// }

// function formatDateWithWeekday(dateIso) {
//   if (!dateIso) return "не указана";
//   const d = new Date(dateIso);
//   if (Number.isNaN(d.getTime())) return "не указана";

//   const day = String(d.getDate()).padStart(2, "0");
//   const month = String(d.getMonth() + 1).padStart(2, "0");
//   const weekdayNames = ["пн", "вт", "ср", "чт", "пт", "сб", "вс"];
//   const wd = weekdayNames[d.getDay() === 0 ? 6 : d.getDay() - 1];

//   return `${day}.${month} (${wd})`;
// }

// // --- карточка кандидата в ЛК ---

// // --- карточка кандидата в ЛК ---
// async function showCandidateCardLk(ctx, candidateId) {
//   const res = await pool.query(
//     `
//       SELECT
//         c.id,
//         c.name,
//         c.age,
//         c.phone,
//         c.status,
//         c.salary,
//         c.schedule,
//         c.questionnaire,
//         c.comment,
//         c.interview_date,
//         c.interview_time,
//         c.was_on_time,
//         c.late_minutes,
//         c.interview_comment,
//         c.decline_reason,

//         c.internship_date,
//         c.internship_time_from,
//         c.internship_time_to,

//         COALESCE(tp_place.title,   'не указано') AS place_title,
//         COALESCE(tp_desired.title, 'не указано') AS desired_point_title,
//         COALESCE(tp_intern.title,  'не указано') AS internship_point_title,

//         COALESCE(u.full_name,        'не назначен') AS admin_name,
//         COALESCE(u_intern.full_name, 'не указан')   AS internship_admin_name
//       FROM candidates c
//         LEFT JOIN trade_points tp_place
//           ON c.point_id = tp_place.id
//         LEFT JOIN trade_points tp_desired
//           ON c.desired_point_id = tp_desired.id
//         LEFT JOIN trade_points tp_intern
//           ON c.internship_point_id = tp_intern.id
//         LEFT JOIN users u
//           ON c.admin_id = u.id
//         LEFT JOIN users u_intern
//           ON c.internship_admin_id = u_intern.id
//       WHERE c.id = $1
//     `,
//     [candidateId]
//   );

//   if (!res.rows.length) {
//     await ctx.reply("Кандидат не найден.");
//     return;
//   }

//   const cand = res.rows[0];

//   const header = getCandidateHeader(cand.status);
//   const agePart = cand.age ? ` (${cand.age})` : "";

//   const desiredPointTitle = cand.desired_point_title || "не указано";
//   const phoneText = cand.phone || "не указан";
//   const salaryText = cand.salary || "не указана";
//   const scheduleText = cand.schedule || "не указан";
//   const experienceText = cand.questionnaire || "не указан";
//   const commentText = cand.comment || "не указан";
//   const interviewCommentText = cand.interview_comment || "не указан";

//   const dtFull = formatDateTimeShort(cand.interview_date, cand.interview_time);
//   const placeTitle = cand.place_title || "не указано";
//   const adminName = cand.admin_name || "не назначен";

//   let text = "";
//   text += `${header}\n`;
//   text += "────────────────────────────────\n";

//   // 🔹 Общая информация
//   text += "🔹 *Общая информация*\n";
//   text += `• *Имя:* ${cand.name || "не указано"}${agePart}\n`;
//   text += `• *Желаемая точка:* ${desiredPointTitle}\n`;
//   text += `• *Телефон:* ${phoneText}\n`;
//   text += `• *Желаемая ЗП:* ${salaryText}\n`;
//   text += `• *Желаемый график:* ${scheduleText}\n`;
//   text += `• *Предыдущий опыт:* ${experienceText}\n`;
//   text += `• *Общий комментарий:* ${commentText}\n\n`;

//   // 📅 О собеседовании / Итоги собеседования
//   if (cand.status === "interviewed" || cand.status === "internship_invited") {
//     text += "📅 *Итоги собеседования*\n";
//   } else {
//     text += "📅 *О собеседовании*\n";
//   }

//   text += `• *Дата/время:* ${dtFull}\n`;
//   text += `• *Место собеседования:* ${placeTitle}\n`;
//   text += `• *Ответственный:* ${adminName}\n`;

//   // Комментарий по собеседованию – только когда собес уже проведён
//   if (cand.status === "interviewed" || cand.status === "internship_invited") {
//     text += `• *Комментарий по собеседованию:* ${interviewCommentText}\n`;
//   }

//   text += "\n";

//   // 🔹 Замечания — только если собес уже прошёл
//   if (cand.status === "interviewed" || cand.status === "internship_invited") {
//     text += "🔹 *Замечания*\n";

//     if (cand.was_on_time === true) {
//       text += "• *Опоздание:* пришёл вовремя\n";
//     } else if (cand.was_on_time === false) {
//       const minutes =
//         cand.late_minutes != null ? `${cand.late_minutes} мин` : "есть";
//       text += `• *Опоздание:* опоздал (${minutes})\n`;
//     } else {
//       text += "• *Опоздание:* не указано\n";
//     }

//     text += "\n";
//   }

//   // 📌 О стажировке — только когда уже приглашён на стажировку
//   if (cand.status === "internship_invited") {
//     text += "📌 *О стажировке*\n";

//     if (cand.internship_date) {
//       const dateLabel = formatDateWithWeekday(cand.internship_date);
//       if (cand.internship_time_from && cand.internship_time_to) {
//         const from = cand.internship_time_from.slice(0, 5);
//         const to = cand.internship_time_to.slice(0, 5);
//         text += `• Дата стажировки: ${dateLabel} (с ${from} до ${to})\n`;
//       } else {
//         text += `• Дата стажировки: ${dateLabel}\n`;
//       }
//     } else {
//       text += "• Дата стажировки: не указана\n";
//     }

//     text += `• Место стажировки: ${
//       cand.internship_point_title || "не указано"
//     }\n`;
//     text += `• Ответственный по стажировке: ${
//       cand.internship_admin_name || "не указан"
//     }\n\n`;
//   }

//   if (cand.decline_reason) {
//     text += `• *Причина отказа:* ${cand.decline_reason}\n\n`;
//   }

//   const rows = [];

//   if (cand.status === "invited") {
//     // Ещё не было собеседования
//     rows.push([
//       Markup.button.callback(
//         "✅ Собеседование пройдено",
//         `lk_cand_passed_${cand.id}`
//       ),
//     ]);
//     rows.push([
//       Markup.button.callback(
//         "❌ Отменить собеседование",
//         `lk_cand_cancel_${cand.id}`
//       ),
//     ]);
//   } else if (cand.status === "interviewed") {
//     // Собеседование проведено, ждём решения
//     rows.push([
//       Markup.button.callback(
//         "✅ Пригласить на стажировку",
//         `lk_cand_invite_${cand.id}`
//       ),
//     ]);
//     rows.push([
//       Markup.button.callback(
//         "❌ отказать кандидату",
//         `lk_cand_decline_${cand.id}`
//       ),
//     ]);
//   } else if (cand.status === "internship_invited") {
//     // Уже приглашён на стажировку
//     rows.push([
//       Markup.button.callback(
//         "▶️ Начать стажировку",
//         `lk_cand_intern_create_${cand.id}`
//       ),
//     ]);
//     rows.push([
//       Markup.button.callback(
//         "❌ отказать кандидату",
//         `lk_cand_decline_${cand.id}`
//       ),
//     ]);
//   }

//   rows.push([
//     Markup.button.callback("⚙️ Настройки", `lk_cand_settings_${cand.id}`),
//   ]);
//   rows.push([
//     Markup.button.callback("◀️ К кандидатам", "admin_users_candidates"),
//   ]);

//   const keyboard = Markup.inlineKeyboard(rows);

//   await deliver(
//     ctx,
//     {
//       text,
//       extra: { ...keyboard, parse_mode: "Markdown" },
//     },
//     { edit: true }
//   );
// }

// // --- регистрация обработчиков раздела "Пользователи" ---

// function registerAdminUsers(bot, ensureUser, logError) {
//   // Вход из админ-панели
//   bot.action("admin_users", async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const text =
//         "📋 *Сотрудники*\n\n(пока заглушка — позже подставим список из users)";
//       await deliver(
//         ctx,
//         {
//           text,
//           extra: {
//             ...Markup.inlineKeyboard([
//               [
//                 Markup.button.callback("Кандидаты", "admin_users_candidates"),
//                 Markup.button.callback("Стажёры", "admin_users_interns"),
//                 Markup.button.callback("✅ Сотрудники", "admin_users_workers"),
//               ],
//               [Markup.button.callback("⬅️ Назад", "lk_admin_menu")],
//             ]),
//             parse_mode: "Markdown",
//           },
//         },
//         { edit: true }
//       );
//     } catch (err) {
//       logError("admin_users", err);
//     }
//   });

//   // Кандидаты
//   bot.action("admin_users_candidates", async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const user = await ensureUser(ctx);
//       if (!user || (user.role !== "admin" && user.role !== "super_admin"))
//         return;
//       await showCandidatesListLk(ctx, user, { edit: true });
//     } catch (err) {
//       logError("admin_users_candidates", err);
//     }
//   });

//   // Открыть карточку кандидата
//   bot.action(/^lk_admin_candidate_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const user = await ensureUser(ctx);
//       if (!user || (user.role !== "admin" && user.role !== "super_admin"))
//         return;
//       const candidateId = parseInt(ctx.match[1], 10);
//       if (!candidateId) return;
//       await showCandidateCardLk(ctx, candidateId);
//     } catch (err) {
//       logError("lk_admin_candidate_open", err);
//     }
//   });

//   // Фильтры
//   bot.action("lk_cand_filter_toggle", async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const tgId = ctx.from.id;
//       const f = getFilterState(tgId);
//       setFilterState(tgId, {
//         filtersExpanded: !f.filtersExpanded,
//         historyExpanded: false,
//       });

//       const user = await ensureUser(ctx);
//       if (!user || (user.role !== "admin" && user.role !== "super_admin"))
//         return;
//       await showCandidatesListLk(ctx, user, { edit: true });
//     } catch (err) {
//       logError("lk_cand_filter_toggle", err);
//     }
//   });

//   bot.action("lk_cand_toggle_history", async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const tgId = ctx.from.id;
//       const f = getFilterState(tgId);
//       setFilterState(tgId, {
//         historyExpanded: !f.historyExpanded,
//         filtersExpanded: false,
//       });

//       const user = await ensureUser(ctx);
//       if (!user || (user.role !== "admin" && user.role !== "super_admin"))
//         return;
//       await showCandidatesListLk(ctx, user, { edit: true });
//     } catch (err) {
//       logError("lk_cand_toggle_history", err);
//     }
//   });

//   const simpleToggle = (field) => async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const tgId = ctx.from.id;
//       const f = getFilterState(tgId);
//       setFilterState(tgId, { [field]: !f[field] });

//       const user = await ensureUser(ctx);
//       if (!user || (user.role !== "admin" && user.role !== "super_admin"))
//         return;
//       await showCandidatesListLk(ctx, user, { edit: true });
//     } catch (err) {
//       logError(`lk_cand_filter_${field}`, err);
//     }
//   };

//   bot.action("lk_cand_filter_cancelled", simpleToggle("cancelled"));
//   bot.action("lk_cand_filter_arrived", simpleToggle("arrived"));
//   bot.action("lk_cand_filter_internship", simpleToggle("internshipInvited"));
//   bot.action("lk_cand_filter_waiting", simpleToggle("waiting"));

//   bot.action("lk_cand_filter_personal", async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const tgId = ctx.from.id;
//       setFilterState(tgId, { scope: "personal" });
//       const user = await ensureUser(ctx);
//       if (!user || (user.role !== "admin" && user.role !== "super_admin"))
//         return;
//       await showCandidatesListLk(ctx, user, { edit: true });
//     } catch (err) {
//       logError("lk_cand_filter_personal", err);
//     }
//   });

//   bot.action("lk_cand_filter_all", async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const tgId = ctx.from.id;
//       setFilterState(tgId, { scope: "all" });
//       const user = await ensureUser(ctx);
//       if (!user || (user.role !== "admin" && user.role !== "super_admin"))
//         return;
//       await showCandidatesListLk(ctx, user, { edit: true });
//     } catch (err) {
//       logError("lk_cand_filter_all", err);
//     }
//   });

//   bot.action("lk_cand_filter_reset", async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const tgId = ctx.from.id;
//       candidateFiltersByTgId.delete(tgId);
//       const user = await ensureUser(ctx);
//       if (!user || (user.role !== "admin" && user.role !== "super_admin"))
//         return;
//       await showCandidatesListLk(ctx, user, { edit: true });
//     } catch (err) {
//       logError("lk_cand_filter_reset", err);
//     }
//   });

//   bot.action("lk_cand_history", async (ctx) => {
//     try {
//       await ctx
//         .answerCbQuery("История кандидатов пока в разработке.")
//         .catch(() => {});
//     } catch (err) {
//       logError("lk_cand_history", err);
//     }
//   });

//   // Заглушки для + добавить стажёра / сотрудника
//   bot.action("lk_add_intern", async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       await ctx.reply("Добавление стажёра из ЛК пока в разработке.");
//     } catch (err) {
//       logError("lk_add_intern", err);
//     }
//   });

//   bot.action("lk_add_worker", async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       await ctx.reply("Добавление сотрудника из ЛК пока в разработке.");
//     } catch (err) {
//       logError("lk_add_worker", err);
//     }
//   });

//   // Стажёры (заглушка)
//   bot.action("admin_users_interns", async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const text = "📋 *Стажёры*\n\n(пока заглушка — позже подставим список)";
//       await deliver(
//         ctx,
//         {
//           text,
//           extra: {
//             ...Markup.inlineKeyboard([
//               [
//                 Markup.button.callback(
//                   "✅ Кандидаты",
//                   "admin_users_candidates"
//                 ),
//                 Markup.button.callback("Стажёры", "admin_users_interns"),
//                 Markup.button.callback("Сотрудники", "admin_users_workers"),
//               ],
//               [Markup.button.callback("⬅️ Назад", "lk_admin_menu")],
//             ]),
//             parse_mode: "Markdown",
//           },
//         },
//         { edit: true }
//       );
//     } catch (err) {
//       logError("admin_users_interns", err);
//     }
//   });

//   // Сотрудники (заглушка)
//   bot.action("admin_users_workers", async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const text =
//         "📋 *Сотрудники*\n\n(пока заглушка — позже подставим список из users)";
//       await deliver(
//         ctx,
//         {
//           text,
//           extra: {
//             ...Markup.inlineKeyboard([
//               [
//                 Markup.button.callback("Кандидаты", "admin_users_candidates"),
//                 Markup.button.callback("Стажёры", "admin_users_interns"),
//                 Markup.button.callback("✅ Сотрудники", "admin_users_workers"),
//               ],
//               [Markup.button.callback("⬅️ Назад", "lk_admin_menu")],
//             ]),
//             parse_mode: "Markdown",
//           },
//         },
//         { edit: true }
//       );
//     } catch (err) {
//       logError("admin_users_workers", err);
//     }
//   });

//   // --- КНОПКИ С КАРТОЧКИ: "СОБЕСЕДОВАНИЕ ПРОЙДЕНО" ---

//   // =======================
//   //  СОВЕРШЕНОЕ СОБЕСЕДОВАНИЕ
//   // =======================

//   bot.action(/^lk_cand_passed_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const user = await ensureUser(ctx);
//       if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
//         return;
//       }

//       const candidateId = Number(ctx.match[1]);
//       interviewResultByTgId.set(ctx.from.id, {
//         candidateId,
//         step: "on_time",
//         wasLate: null,
//         lateMinutes: null,
//         issues: null,
//       });

//       const keyboard = Markup.inlineKeyboard([
//         [
//           Markup.button.callback(
//             "✅ Да",
//             `lk_cand_passed_on_time_yes_${candidateId}`
//           ),
//           Markup.button.callback(
//             "⏰ Опоздал",
//             `lk_cand_passed_on_time_no_${candidateId}`
//           ),
//         ],
//         [
//           Markup.button.callback(
//             "⬅️ Назад к кандидату",
//             `lk_cand_back_${candidateId}`
//           ),
//         ],
//       ]);

//       await deliver(
//         ctx,
//         {
//           text: "Кандидат пришёл вовремя?",
//           extra: { ...keyboard },
//         },
//         { edit: true }
//       );
//     } catch (err) {
//       logError(err, "lk_cand_passed_");
//     }
//   });

//   bot.action(/^lk_cand_back_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const candidateId = Number(ctx.match[1]);
//       interviewResultByTgId.delete(ctx.from.id);
//       internshipStateByTgId.delete(ctx.from.id);
//       await showCandidateCardLk(ctx, candidateId, { edit: true });
//     } catch (err) {
//       logError(err, "lk_cand_back_");
//     }
//   });

//   // пришёл вовремя
//   bot.action(/^lk_cand_passed_on_time_yes_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const candidateId = Number(ctx.match[1]);
//       const state = interviewResultByTgId.get(ctx.from.id);
//       if (!state || state.candidateId !== candidateId) return;

//       state.wasLate = false;
//       state.lateMinutes = null;
//       state.step = "issues";

//       interviewResultByTgId.set(ctx.from.id, state);

//       const keyboard = Markup.inlineKeyboard([
//         [
//           Markup.button.callback(
//             "ℹ замечаний нет",
//             `lk_cand_passed_issues_none_${candidateId}`
//           ),
//         ],
//         [
//           Markup.button.callback(
//             "⬅️ Назад к кандидату",
//             `lk_cand_back_${candidateId}`
//           ),
//         ],
//       ]);

//       await deliver(
//         ctx,
//         {
//           text:
//             "Оставьте замечания по собеседованию одним сообщением.\n" +
//             "Если замечаний нет — нажмите «ℹ замечаний нет».",
//           extra: { ...keyboard },
//         },
//         { edit: true }
//       );
//     } catch (err) {
//       logError(err, "lk_cand_passed_on_time_yes_");
//     }
//   });

//   // опоздал
//   bot.action(/^lk_cand_passed_on_time_no_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const candidateId = Number(ctx.match[1]);
//       const state = interviewResultByTgId.get(ctx.from.id);
//       if (!state || state.candidateId !== candidateId) return;

//       state.wasLate = true;
//       state.step = "late_minutes";
//       interviewResultByTgId.set(ctx.from.id, state);

//       const keyboard = Markup.inlineKeyboard([
//         [
//           Markup.button.callback(
//             "⬅️ Назад к кандидату",
//             `lk_cand_back_${candidateId}`
//           ),
//         ],
//       ]);

//       await deliver(
//         ctx,
//         {
//           text: "На сколько минут кандидат опоздал? Введите число.",
//           extra: { ...keyboard },
//         },
//         { edit: true }
//       );
//     } catch (err) {
//       logError(err, "lk_cand_passed_on_time_no_");
//     }
//   });

//   // замечаний нет
//   bot.action(/^lk_cand_passed_issues_none_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const candidateId = Number(ctx.match[1]);
//       const state = interviewResultByTgId.get(ctx.from.id);
//       if (!state || state.candidateId !== candidateId) return;

//       state.issues = "замечаний нет";
//       await finishInterviewResult(ctx, state);
//     } catch (err) {
//       logError(err, "lk_cand_passed_issues_none_");
//     }
//   });

//   // =======================
//   //  ПРИГЛАШЕНИЕ НА СТАЖИРОВКУ (черновой вариант)
//   // =======================

//   // состояние опроса стажировки
//   const internshipStateByTgId = new Map();

//   // запуск опроса
//   bot.action(/^lk_cand_invite_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const user = await ensureUser(ctx);
//       if (!user || (user.role !== "admin" && user.role !== "super_admin"))
//         return;

//       const candidateId = Number(ctx.match[1]);
//       const now = new Date();
//       const todayIso = now.toISOString().slice(0, 10);
//       const tomorrow = new Date(now.getTime() + 24 * 60 * 60 * 1000);
//       const tomorrowIso = tomorrow.toISOString().slice(0, 10);

//       internshipStateByTgId.set(ctx.from.id, {
//         candidateId,
//         step: "internship_date",
//         dateIso: null,
//         todayIso,
//         tomorrowIso,
//         timeFrom: null,
//         timeTo: null,
//         pointId: null,
//         adminId: null,
//         linkMethod: null,
//         linkedUserId: null,
//       });

//       const keyboard = Markup.inlineKeyboard([
//         [
//           Markup.button.callback(
//             "сегодня",
//             `lk_cand_intern_date_today_${candidateId}`
//           ),
//           Markup.button.callback(
//             "завтра",
//             `lk_cand_intern_date_tomorrow_${candidateId}`
//           ),
//         ],
//         [
//           Markup.button.callback(
//             "⬅️ Назад к кандидату",
//             `lk_cand_back_${candidateId}`
//           ),
//         ],
//       ]);

//       await deliver(
//         ctx,
//         {
//           text:
//             "📅 Укажите дату стажировки в формате ДД.MM (например, 03.12).\n" +
//             "Или выберите «сегодня» / «завтра» кнопками ниже.",
//           extra: { ...keyboard },
//         },
//         { edit: true }
//       );
//     } catch (err) {
//       logError(err, "lk_cand_invite_");
//     }
//   });

//   // выбор сегодня/завтра
//   bot.action(/^lk_cand_intern_date_(today|tomorrow)_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const [, which, idStr] = ctx.match;
//       const candidateId = Number(idStr);
//       const state = internshipStateByTgId.get(ctx.from.id);
//       if (!state || state.candidateId !== candidateId) return;

//       state.dateIso = which === "today" ? state.todayIso : state.tomorrowIso;
//       state.step = "internship_time_from";
//       internshipStateByTgId.set(ctx.from.id, state);

//       const keyboard = Markup.inlineKeyboard([
//         [
//           Markup.button.callback(
//             "⬅️ Назад к кандидату",
//             `lk_cand_back_${candidateId}`
//           ),
//         ],
//       ]);

//       await deliver(
//         ctx,
//         {
//           text: "⏰ С какого времени стажировка? Укажите время в формате ЧЧ:ММ (например, 11:00).",
//           extra: { ...keyboard },
//         },
//         { edit: true }
//       );
//     } catch (err) {
//       logError(err, "lk_cand_intern_date_today/tomorrow");
//     }
//   });

//   // текстовые шаги опроса стажировки
//   bot.on("text", async (ctx, next) => {
//     try {
//       const tgId = ctx.from?.id;
//       if (!tgId) return next();

//       const state = internshipStateByTgId.get(tgId);
//       const text = (ctx.message.text || "").trim();

//       if (!state) return next();
//       const candidateId = state.candidateId;

//       // 1. дата руками ДД.MM
//       if (state.step === "internship_date") {
//         const parsed = parseShortDateToIso(text);
//         if (!parsed) {
//           await ctx.reply(
//             "Не понял дату. Используй формат ДД.MM, например 07.12."
//           );
//           return;
//         }
//         state.dateIso = parsed;
//         state.step = "internship_time_from";
//         internshipStateByTgId.set(tgId, state);

//         const keyboard = Markup.inlineKeyboard([
//           [
//             Markup.button.callback(
//               "⬅️ Назад к кандидату",
//               `lk_cand_back_${candidateId}`
//             ),
//           ],
//         ]);

//         await deliver(
//           ctx,
//           {
//             text: "⏰ С какого времени стажировка? Укажите время в формате ЧЧ:ММ (например, 11:00).",
//             extra: { ...keyboard },
//           },
//           { edit: false }
//         );
//         return;
//       }

//       // 2. время "с"
//       if (state.step === "internship_time_from") {
//         const time = parseTimeHHMM(text);
//         if (!time) {
//           await ctx.reply(
//             "Не понял время. Используй формат ЧЧ:ММ, например 11:00."
//           );
//           return;
//         }
//         state.timeFrom = time;
//         state.step = "internship_time_to";
//         internshipStateByTgId.set(tgId, state);

//         const keyboard = Markup.inlineKeyboard([
//           [
//             Markup.button.callback(
//               "⬅️ Назад к кандидату",
//               `lk_cand_back_${candidateId}`
//             ),
//           ],
//         ]);

//         await deliver(
//           ctx,
//           {
//             text: "⏰ До какого времени стажировка? Укажите время в формате ЧЧ:ММ (например, 16:00).",
//             extra: { ...keyboard },
//           },
//           { edit: false }
//         );
//         return;
//       }

//       // 3. время "до"
//       if (state.step === "internship_time_to") {
//         const time = parseTimeHHMM(text);
//         if (!time) {
//           await ctx.reply(
//             "Не понял время. Используй формат ЧЧ:ММ, например 16:00."
//           );
//           return;
//         }
//         state.timeTo = time;
//         state.step = "internship_point";
//         internshipStateByTgId.set(tgId, state);

//         // точки
//         const tpRes = await pool.query(
//           "SELECT id, title FROM trade_points ORDER BY title"
//         );
//         const rows = tpRes.rows.map((tp) => [
//           Markup.button.callback(
//             tp.title,
//             `lk_cand_intern_point_${candidateId}_${tp.id}`
//           ),
//         ]);
//         rows.push([
//           Markup.button.callback(
//             "⬅️ Назад к кандидату",
//             `lk_cand_back_${candidateId}`
//           ),
//         ]);

//         await deliver(
//           ctx,
//           {
//             text: "📍 Выберите место стажировки:",
//             extra: { ...Markup.inlineKeyboard(rows) },
//           },
//           { edit: false }
//         );
//         return;
//       }

//       // остальные шаги (linking) не используют text — пропускаем дальше
//       return next();
//     } catch (err) {
//       logError(err, "bot.on(text) internship");
//       return next();
//     }
//   });

//   // выбор точки стажировки
//   bot.action(/^lk_cand_intern_point_(\d+)_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const candidateId = Number(ctx.match[1]);
//       const pointId = Number(ctx.match[2]);
//       const state = internshipStateByTgId.get(ctx.from.id);
//       if (!state || state.candidateId !== candidateId) return;

//       state.pointId = pointId;
//       state.step = "internship_admin";
//       internshipStateByTgId.set(ctx.from.id, state);

//       const res = await pool.query(
//         "SELECT id, full_name FROM users WHERE role IN ('admin', 'super_admin') ORDER BY full_name"
//       );

//       const rows = res.rows.map((u) => [
//         Markup.button.callback(
//           u.full_name,
//           `lk_cand_intern_admin_${candidateId}_${u.id}`
//         ),
//       ]);
//       rows.push([
//         Markup.button.callback(
//           "назначу позже",
//           `lk_cand_intern_admin_later_${candidateId}`
//         ),
//       ]);
//       rows.push([
//         Markup.button.callback(
//           "⬅️ Назад к кандидату",
//           `lk_cand_back_${candidateId}`
//         ),
//       ]);

//       await deliver(
//         ctx,
//         {
//           text:
//             "👤 Выберите ответственного по стажировке.\n" +
//             "Если пока не знаете — нажмите «назначу позже».",
//           extra: { ...Markup.inlineKeyboard(rows) },
//         },
//         { edit: true }
//       );
//     } catch (err) {
//       logError(err, "lk_cand_intern_point_");
//     }
//   });

//   // выбор ответственного — далее шаг "Создать стажёра"
//   bot.action(/^lk_cand_intern_admin_(\d+)_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const candidateId = Number(ctx.match[1]);
//       const adminId = Number(ctx.match[2]);
//       const state = internshipStateByTgId.get(ctx.from.id);
//       if (!state || state.candidateId !== candidateId) return;

//       state.adminId = adminId;
//       state.step = "link_method";
//       internshipStateByTgId.set(ctx.from.id, state);

//       await askCreateIntern(ctx, state);
//     } catch (err) {
//       logError(err, "lk_cand_intern_admin_");
//     }
//   });

//   bot.action(/^lk_cand_intern_admin_later_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const candidateId = Number(ctx.match[1]);
//       const state = internshipStateByTgId.get(ctx.from.id);
//       if (!state || state.candidateId !== candidateId) return;

//       state.adminId = null;
//       state.step = "link_method";
//       internshipStateByTgId.set(ctx.from.id, state);

//       await askCreateIntern(ctx, state);
//     } catch (err) {
//       logError(err, "lk_cand_intern_admin_later_");
//     }
//   });

//   // экран "Создать стажёра" (обязательный шаг перед статусом internship_invited)
//   async function askCreateIntern(ctx, state) {
//     const candidateId = state.candidateId;

//     const keyboard = Markup.inlineKeyboard([
//       [
//         Markup.button.callback(
//           "🔗 Привязать существующего пользователя",
//           `lk_cand_intern_link_existing_${candidateId}`
//         ),
//       ],
//       [
//         Markup.button.callback(
//           "📨 Прислать Телеграм кандидата",
//           `lk_cand_intern_link_later_${candidateId}`
//         ),
//       ],
//       [
//         Markup.button.callback(
//           "⬅️ Назад к кандидату",
//           `lk_cand_back_${candidateId}`
//         ),
//       ],
//     ]);

//     await deliver(
//       ctx,
//       {
//         text:
//           "Теперь нужно создать стажёра для Личного кабинета.\n\n" +
//           "Выберите, как привязать кандидата к пользователю:\n" +
//           "• *Привязать существующего пользователя* — из тех, кто уже заходил в ЛК.\n" +
//           "• *Прислать Телеграм кандидата* — переслать сообщение или отправить его ID (доделаем логику позже).",
//         extra: { ...keyboard },
//       },
//       { edit: true }
//     );
//   }

//   bot.action(/^lk_cand_internship_start_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const candidateId = Number(ctx.match[1]);

//       // пока просто заглушка
//       await ctx.reply(
//         "Запуск стажировки пока в разработке. Статус кандидата уже: «приглашён на стажировку»."
//       );

//       await showCandidateCardLk(ctx, candidateId, { edit: false });
//     } catch (err) {
//       logError(err, "lk_cand_internship_start_");
//     }
//   });

//   // пока оба варианта линковки работают как заглушка — просто завершают приглашение
//   bot.action(/^lk_cand_intern_link_existing_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const candidateId = Number(ctx.match[1]);
//       const state = internshipStateByTgId.get(ctx.from.id);
//       if (!state || state.candidateId !== candidateId) return;

//       state.linkMethod = "existing";
//       // TODO: здесь позже показать список пользователей без карточки и записать связь
//       await finishInternshipInvite(ctx, state);
//     } catch (err) {
//       logError(err, "lk_cand_intern_link_existing_");
//     }
//   });

//   bot.action(/^lk_cand_intern_link_later_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const candidateId = Number(ctx.match[1]);
//       const state = internshipStateByTgId.get(ctx.from.id);
//       if (!state || state.candidateId !== candidateId) return;

//       state.linkMethod = "telegram";
//       // TODO: здесь позже примем пересланное сообщение / ID и создадим/привяжем пользователя
//       await finishInternshipInvite(ctx, state);
//     } catch (err) {
//       logError(err, "lk_cand_intern_link_later_");
//     }
//   });

//   // финал: только здесь ставим статус internship_invited и показываем карточку
//   async function finishInternshipInvite(ctx, state) {
//     const { candidateId, dateIso, timeFrom, timeTo, pointId, adminId } = state;

//     await pool.query(
//       `
//       UPDATE candidates
//       SET status = 'internship_invited',
//           internship_date = $2,
//           internship_time_from = $3,
//           internship_time_to = $4,
//           internship_point_id = $5,
//           internship_admin_id = $6
//       WHERE id = $1
//     `,
//       [candidateId, dateIso, timeFrom, timeTo, pointId, adminId]
//     );

//     internshipStateByTgId.delete(ctx.from.id);

//     await showCandidateCardLk(ctx, candidateId, { edit: true });
//   }

//   // вспомогательные парсеры
//   function parseShortDateToIso(text) {
//     const m = text.trim().match(/^(\d{1,2})\.(\d{1,2})$/);
//     if (!m) return null;
//     const day = Number(m[1]);
//     const month = Number(m[2]);
//     const now = new Date();
//     const year = now.getFullYear();
//     const d = new Date(year, month - 1, day);
//     if (
//       d.getFullYear() !== year ||
//       d.getMonth() !== month - 1 ||
//       d.getDate() !== day
//     ) {
//       return null;
//     }
//     return d.toISOString().slice(0, 10);
//   }

//   function parseTimeHHMM(text) {
//     const m = text.trim().match(/^(\d{1,2}):(\d{2})$/);
//     if (!m) return null;
//     const h = Number(m[1]);
//     const min = Number(m[2]);
//     if (h < 0 || h > 23 || min < 0 || min > 59) return null;
//     return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}:00`;
//   }

//   // выбор сегодня / завтра
//   bot.action(/^lk_cand_intern_date_(today|tomorrow)_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const [, which, idStr] = ctx.match;
//       const candidateId = Number(idStr);
//       const state = internshipStateByTgId.get(ctx.from.id);
//       if (!state || state.candidateId !== candidateId) return;

//       state.dateIso = which === "today" ? state.todayIso : state.tomorrowIso;
//       state.step = "internship_time_from";
//       internshipStateByTgId.set(ctx.from.id, state);

//       const keyboard = Markup.inlineKeyboard([
//         [
//           Markup.button.callback(
//             "⬅️ Назад к кандидату",
//             `lk_cand_back_${candidateId}`
//           ),
//         ],
//       ]);

//       await deliver(
//         ctx,
//         {
//           text: "⏰ С какого времени стажировка? Укажите время в формате ЧЧ:ММ (например, 11:00).",
//           extra: { ...keyboard },
//         },
//         { edit: true }
//       );
//     } catch (err) {
//       logError(err, "lk_cand_intern_date_(today|tomorrow)");
//     }
//   });

//   // обработка текстов стажировки (дата руками, время от/до и т.п.)
//   bot.on("text", async (ctx, next) => {
//     try {
//       const tgId = ctx.from?.id;
//       if (!tgId) return next();

//       const state = internshipStateByTgId.get(tgId);
//       const text = (ctx.message.text || "").trim();

//       if (state) {
//         const candidateId = state.candidateId;

//         if (state.step === "internship_date") {
//           const parsed = parseShortDateToIso(text);
//           if (!parsed) {
//             await ctx.reply(
//               "Не понял дату. Используй формат ДД.MM, например 07.12."
//             );
//             return;
//           }
//           state.dateIso = parsed;
//           state.step = "internship_time_from";
//           internshipStateByTgId.set(tgId, state);

//           const keyboard = Markup.inlineKeyboard([
//             [
//               Markup.button.callback(
//                 "⬅️ Назад к кандидату",
//                 `lk_cand_back_${candidateId}`
//               ),
//             ],
//           ]);

//           await deliver(
//             ctx,
//             {
//               text: "⏰ С какого времени стажировка? Укажите время в формате ЧЧ:ММ (например, 11:00).",
//               extra: { ...keyboard },
//             },
//             { edit: false }
//           );
//           return;
//         }

//         if (state.step === "internship_time_from") {
//           const time = parseTimeHHMM(text);
//           if (!time) {
//             await ctx.reply(
//               "Не понял время. Используй формат ЧЧ:ММ, например 11:00."
//             );
//             return;
//           }
//           state.timeFrom = time;
//           state.step = "internship_time_to";
//           internshipStateByTgId.set(tgId, state);

//           const keyboard = Markup.inlineKeyboard([
//             [
//               Markup.button.callback(
//                 "⬅️ Назад к кандидату",
//                 `lk_cand_back_${candidateId}`
//               ),
//             ],
//           ]);

//           await deliver(
//             ctx,
//             {
//               text: "⏰ До какого времени стажировка? Укажите время в формате ЧЧ:ММ (например, 16:00).",
//               extra: { ...keyboard },
//             },
//             { edit: false }
//           );
//           return;
//         }

//         if (state.step === "internship_time_to") {
//           const time = parseTimeHHMM(text);
//           if (!time) {
//             await ctx.reply(
//               "Не понял время. Используй формат ЧЧ:ММ, например 16:00."
//             );
//             return;
//           }
//           state.timeTo = time;
//           state.step = "internship_point";
//           internshipStateByTgId.set(tgId, state);

//           // показываем точки
//           const tpRes = await pool.query(
//             "SELECT id, title FROM trade_points ORDER BY title"
//           );
//           const rows = tpRes.rows.map((tp) => [
//             Markup.button.callback(
//               tp.title,
//               `lk_cand_intern_point_${candidateId}_${tp.id}`
//             ),
//           ]);
//           rows.push([
//             Markup.button.callback(
//               "⬅️ Назад к кандидату",
//               `lk_cand_back_${candidateId}`
//             ),
//           ]);

//           await deliver(
//             ctx,
//             {
//               text: "📍 Выберите место стажировки:",
//               extra: { ...Markup.inlineKeyboard(rows) },
//             },
//             { edit: false }
//           );
//           return;
//         }

//         // если шаги стажировки не обработали — падаем в next()
//       }

//       return next();
//     } catch (err) {
//       logError(err, "bot.on(text) internshipState");
//       return next();
//     }
//   });

//   // выбор точки
//   bot.action(/^lk_cand_intern_point_(\d+)_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const candidateId = Number(ctx.match[1]);
//       const pointId = Number(ctx.match[2]);

//       const state = internshipStateByTgId.get(ctx.from.id);
//       if (!state || state.candidateId !== candidateId) return;

//       state.pointId = pointId;
//       state.step = "internship_admin";
//       internshipStateByTgId.set(ctx.from.id, state);

//       const res = await pool.query(
//         "SELECT id, full_name, role FROM users WHERE role IN ('admin','super_admin') ORDER BY full_name"
//       );

//       const rows = res.rows.map((u) => [
//         Markup.button.callback(
//           `${u.full_name}`,
//           `lk_cand_intern_admin_${candidateId}_${u.id}`
//         ),
//       ]);
//       rows.push([
//         Markup.button.callback(
//           "назначу позже",
//           `lk_cand_intern_admin_later_${candidateId}`
//         ),
//       ]);
//       rows.push([
//         Markup.button.callback(
//           "⬅️ Назад к кандидату",
//           `lk_cand_back_${candidateId}`
//         ),
//       ]);

//       await deliver(
//         ctx,
//         {
//           text:
//             "👤 Выберите ответственного по стажировке.\n" +
//             "Если пока не знаете — нажмите «назначу позже».",
//           extra: { ...Markup.inlineKeyboard(rows) },
//         },
//         { edit: true }
//       );
//     } catch (err) {
//       logError(err, "lk_cand_intern_point_");
//     }
//   });

//   // выбор ответственного
//   bot.action(/^lk_cand_intern_admin_(\d+)_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const candidateId = Number(ctx.match[1]);
//       const adminId = Number(ctx.match[2]);
//       const state = internshipStateByTgId.get(ctx.from.id);
//       if (!state || state.candidateId !== candidateId) return;

//       state.adminId = adminId;
//       await finishInternshipInvite(ctx, state);
//     } catch (err) {
//       logError(err, "lk_cand_intern_admin_");
//     }
//   });

//   bot.action(/^lk_cand_intern_admin_later_(\d+)$/, async (ctx) => {
//     try {
//       await ctx.answerCbQuery().catch(() => {});
//       const candidateId = Number(ctx.match[1]);
//       const state = internshipStateByTgId.get(ctx.from.id);
//       if (!state || state.candidateId !== candidateId) return;

//       state.adminId = null;
//       await finishInternshipInvite(ctx, state);
//     } catch (err) {
//       logError(err, "lk_cand_intern_admin_later_");
//     }
//   });

//   async function finishInternshipInvite(ctx, state) {
//     const { candidateId, dateIso, timeFrom, timeTo, pointId, adminId } = state;

//     await pool.query(
//       `
//       UPDATE candidates
//       SET status = 'internship_invited',
//           internship_date = $2,
//           internship_time_from = $3,
//           internship_time_to = $4,
//           internship_point_id = $5,
//           internship_admin_id = $6
//       WHERE id = $1
//     `,
//       [candidateId, dateIso, timeFrom, timeTo, pointId, adminId]
//     );

//     internshipStateByTgId.delete(ctx.from.id);

//     await showCandidateCardLk(ctx, candidateId, { edit: true });
//   }

//   // Вспомогательные парсеры
//   function parseShortDateToIso(text) {
//     const m = text.trim().match(/^(\d{1,2})\.(\d{1,2})$/);
//     if (!m) return null;
//     const day = Number(m[1]);
//     const month = Number(m[2]);
//     const now = new Date();
//     const year = now.getFullYear();
//     const d = new Date(year, month - 1, day);
//     if (
//       d.getFullYear() !== year ||
//       d.getMonth() !== month - 1 ||
//       d.getDate() !== day
//     ) {
//       return null;
//     }
//     return d.toISOString().slice(0, 10);
//   }

//   function parseTimeHHMM(text) {
//     const m = text.trim().match(/^(\d{1,2}):(\d{2})$/);
//     if (!m) return null;
//     const h = Number(m[1]);
//     const min = Number(m[2]);
//     if (h < 0 || h > 23 || min < 0 || min > 59) return null;
//     // формат TIME 'HH:MM:00'
//     return `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}:00`;
//   }

//   // обработка текстовых ответов для опоздания / замечаний
//   bot.on("text", async (ctx, next) => {
//     try {
//       const tgId = ctx.from?.id;
//       if (!tgId) return next();

//       const interviewState = interviewResultByTgId.get(tgId);
//       if (interviewState) {
//         const text = (ctx.message.text || "").trim();
//         const candidateId = interviewState.candidateId;

//         if (interviewState.step === "late_minutes") {
//           const minutes = Number.parseInt(text, 10);
//           if (!Number.isFinite(minutes) || minutes < 0 || minutes > 600) {
//             await ctx.reply(
//               "Пожалуйста, укажите количество минут числом от 0 до 600."
//             );
//             return;
//           }

//           interviewState.lateMinutes = minutes;
//           interviewState.step = "issues";

//           const keyboard = Markup.inlineKeyboard([
//             [
//               Markup.button.callback(
//                 "ℹ замечаний нет",
//                 `lk_cand_passed_issues_none_${candidateId}`
//               ),
//             ],
//             [
//               Markup.button.callback(
//                 "⬅️ Назад к кандидату",
//                 `lk_cand_back_${candidateId}`
//               ),
//             ],
//           ]);

//           await deliver(
//             ctx,
//             {
//               text:
//                 "Оставьте замечания по собеседованию одним сообщением.\n" +
//                 "Если замечаний нет — нажмите «ℹ замечаний нет».",
//               extra: { ...keyboard },
//             },
//             { edit: false }
//           );

//           return;
//         }

//         if (interviewState.step === "issues") {
//           interviewState.issues = text || "замечаний нет";
//           await finishInterviewResult(ctx, interviewState);
//           return;
//         }
//       }

//       // если не наш кейс — пропускаем дальше
//       return next();
//     } catch (err) {
//       logError(err, "bot.on(text) interviewResult");
//       return next();
//     }
//   });

//   async function finishInterviewResult(ctx, state) {
//     const { candidateId, wasLate, lateMinutes, issues } = state;

//     const wasOnTime = wasLate ? false : true;
//     const late = wasLate ? lateMinutes || 0 : null;

//     await pool.query(
//       `
//       UPDATE candidates
//       SET status = 'interviewed',
//           was_on_time = $2,
//           late_minutes = $3,
//           interview_comment = $4
//       WHERE id = $1
//     `,
//       [candidateId, wasOnTime, late, issues || null]
//     );

//     interviewResultByTgId.delete(ctx.from.id);

//     await showCandidateCardLk(ctx, candidateId, { edit: true });
//   }

//   // --- текстовые шаги опроса "итоги собеседования" ---
//   bot.on("text", async (ctx, next) => {
//     try {
//       const tgId = ctx.from.id;
//       const state = getInterviewState(tgId);
//       if (!state) return next();

//       const user = await ensureUser(ctx);
//       if (!user || (user.role !== "admin" && user.role !== "super_admin")) {
//         clearInterviewState(tgId);
//         return next();
//       }

//       const text = (ctx.message.text || "").trim();

//       // шаг: ввод минут опоздания
//       if (state.step === "late_minutes") {
//         const minutes = Number.parseInt(text, 10);
//         if (!Number.isFinite(minutes) || minutes < 0) {
//           await ctx.reply(
//             "Введите количество минут опоздания числом, например: 5"
//           );
//           return;
//         }

//         setInterviewState(tgId, {
//           lateMinutes: minutes,
//           step: "remarks",
//         });

//         await askInterviewRemarks(ctx, state.candidateId);
//         return;
//       }

//       // шаг: ввод текста замечаний
//       if (state.step === "remarks") {
//         setInterviewState(tgId, { remarks: text });
//         await saveInterviewResultAndShowCard(ctx, getInterviewState(tgId));
//         return;
//       }

//       return next();
//     } catch (err) {
//       logError("lk_cand_interview_text", err);
//       return next();
//     }
//   });
// }

// module.exports = {
//   registerAdminUsers,
//   showCandidatesListLk,
//   showCandidateCardLk,
// };
    