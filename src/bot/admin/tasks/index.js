// src/bot/admin/tasks/index.js
const { registerAdminTaskCreate } = require("./create");

function registerAdminTasks(bot, ensureUser, logError) {
  registerAdminTaskCreate(bot, ensureUser, logError);
}

module.exports = { registerAdminTasks };
