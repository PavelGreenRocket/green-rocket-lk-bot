// src/bot/admin/users/candidateFilters.js

// Храним фильтры по tg_id администратора
const candidateFiltersByTgId = new Map();

function getDefaultFilters() {
  return {
    cancelled: false,
    arrived: true,
    internshipInvited: true,
    waiting: true,
    scope: "personal", // "personal" | "all"
    filtersExpanded: false, // раскрыт ли блок фильтров
    historyExpanded: false, // пока почти не используем, но оставим
  };
}

// Получить фильтры для данного tg_id
function getCandidateFilters(tgId) {
  const existing = candidateFiltersByTgId.get(tgId);
  if (!existing) {
    const def = getDefaultFilters();
    candidateFiltersByTgId.set(tgId, def);
    return def;
  }
  // всегда возвращаем копию, чтобы случайно не мутировать извне
  return { ...existing };
}

// Частично обновить фильтры
function setCandidateFilters(tgId, patch) {
  const current = getCandidateFilters(tgId);
  const next = { ...current, ...patch };
  candidateFiltersByTgId.set(tgId, next);
}

// Сбросить фильтры к дефолтным
function resetCandidateFilters(tgId) {
  const def = getDefaultFilters();
  candidateFiltersByTgId.set(tgId, def);
}

// Текстовое описание текущих фильтров (для низа списка)
function describeCandidateFilters(filters) {
  let text = "";

  // Область (личные / все)
  if (filters.scope === "personal") {
    text += "Показаны только ваши кандидаты.\n";
  } else {
    text += "Показаны все кандидаты.\n";
  }

  // Статусы
  const statuses = [];
  if (filters.waiting) statuses.push("ожидают собеседование");
  if (filters.arrived) statuses.push("собеседование проведено");
  if (filters.internshipInvited) statuses.push("приглашены на стажировку");
  if (filters.cancelled) statuses.push("отменённые");

  if (statuses.length) {
    text += "Фильтр по статусам: " + statuses.join(", ") + ".\n";
  } else {
    text += "Фильтр по статусам: все (ограничений нет).\n";
  }

  text += "\n";
  return text;
}

module.exports = {
  getCandidateFilters,
  setCandidateFilters,
  resetCandidateFilters,
  describeCandidateFilters,
};
