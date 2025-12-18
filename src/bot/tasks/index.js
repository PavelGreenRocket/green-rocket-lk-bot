// src/bot/tasks/index.js
const { registerTodayTasks } = require("./today");

function registerTasks(bot, ensureUser, logError) {
  registerTodayTasks(bot, ensureUser, logError);
}

module.exports = { registerTasks };
