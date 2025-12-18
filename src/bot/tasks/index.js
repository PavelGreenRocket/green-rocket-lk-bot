// src/bot/tasks/index.js
const { registerShiftDailyTasks } = require("./shiftDaily");

function registerTasks(bot, ensureUser, logError) {
  registerShiftDailyTasks(bot, ensureUser, logError);
}

module.exports = { registerTasks };
