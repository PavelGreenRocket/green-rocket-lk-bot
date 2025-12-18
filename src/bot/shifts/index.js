// src/bot/shifts/index.js
const { registerShiftFlow } = require("./flow");
const { registerShiftClose } = require("./close");

function registerShifts(bot, ensureUser, logError) {
  registerShiftClose(bot, ensureUser, logError); 
  registerShiftFlow(bot, ensureUser, logError); 
}

module.exports = { registerShifts };
