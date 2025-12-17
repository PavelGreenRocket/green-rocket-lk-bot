// src/bot/adminUsers/state.js

// Константы, которые нужны в разных подмодулях
const SUPER_ADMIN_TELEGRAM_ID = "925270231"; // твой tg id
const ADMIN_THEORY_PASS_PERCENT = 90; // порог зачёта по теории, %

const AI_LOGS_PAGE_SIZE = 10; // размер страницы логов ИИ
const PAGE_SIZE = 10; // пользователей на странице

// --- Общие хелперы ---
function isAdmin(user) {
  return user && user.role === "admin";
}

// --- Состояния для создания пользователя админом ---
const userCreateStates = new Map(); // { step, tmpTelegramId? }
function setUserCreateState(adminId, state) {
  userCreateStates.set(adminId, state);
}
function getUserCreateState(adminId) {
  return userCreateStates.get(adminId) || null;
}
function clearUserCreateState(adminId) {
  userCreateStates.delete(adminId);
}

// --- Состояния поиска пользователя ---
const userSearchStates = new Map(); // { step: "await_query" }
function setUserSearchState(adminId, state) {
  userSearchStates.set(adminId, state);
}
function getUserSearchState(adminId) {
  return userSearchStates.get(adminId) || null;
}
function clearUserSearchState(adminId) {
  userSearchStates.delete(adminId);
}

// --- Состояния изменения имени пользователя ---
const userRenameStates = new Map(); // { userId }
function setUserRenameState(adminId, state) {
  userRenameStates.set(adminId, state);
}
function getUserRenameState(adminId) {
  return userRenameStates.get(adminId) || null;
}
function clearUserRenameState(adminId) {
  userRenameStates.delete(adminId);
}

// --- Состояния админских тестов по теории ---
const adminTheorySessions = new Map();
// { userId, itemId, type, topicId, topicTitle, sessionId, cards, index, showAnswer, correctCount }
function setAdminTheorySession(adminId, state) {
  adminTheorySessions.set(adminId, state);
}
function getAdminTheorySession(adminId) {
  return adminTheorySessions.get(adminId) || null;
}
function clearAdminTheorySession(adminId) {
  adminTheorySessions.delete(adminId);
}

// --- Состояние экрана "Обращения к ИИ" (фильтр + раскрытие) ---
const adminAiViewStates = new Map(); // { aiFilter: 'all' | 'offtopic', aiToolsExpanded?: boolean }
function getAdminAiViewState(adminTelegramId) {
  const st = adminAiViewStates.get(adminTelegramId);
  if (!st) return { aiFilter: "all", aiToolsExpanded: false };

  return {
    aiFilter: st.aiFilter || "all",
    aiToolsExpanded: !!st.aiToolsExpanded,
  };
}
function setAdminAiViewState(adminTelegramId, patch) {
  const current = getAdminAiViewState(adminTelegramId) || {};
  adminAiViewStates.set(adminTelegramId, { ...current, ...patch });
}

// --- Состояние списка пользователей (фильтры, раскрытие и т.п.) ---
const adminUsersViewStates = new Map();

function getAdminUsersViewState(adminId) {
  return adminUsersViewStates.get(adminId) || {};
}

function setAdminUsersViewState(adminId, patch) {
  const prev = adminUsersViewStates.get(adminId) || {};
  adminUsersViewStates.set(adminId, { ...prev, ...patch });
}

module.exports = {
  // константы
  SUPER_ADMIN_TELEGRAM_ID,
  ADMIN_THEORY_PASS_PERCENT,
  AI_LOGS_PAGE_SIZE,
  PAGE_SIZE,

  // хелперы
  isAdmin,

  // создание пользователя
  setUserCreateState,
  getUserCreateState,
  clearUserCreateState,

  // поиск пользователя
  setUserSearchState,
  getUserSearchState,
  clearUserSearchState,

  // изменение имени пользователя
  setUserRenameState,
  getUserRenameState,
  clearUserRenameState,

  // админские тесты по теории
  setAdminTheorySession,
  getAdminTheorySession,
  clearAdminTheorySession,

  // состояние экрана ИИ
  getAdminAiViewState,
  setAdminAiViewState,

  // состояние списка пользователей
  getAdminUsersViewState,
  setAdminUsersViewState,
};
