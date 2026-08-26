/** Реестр источников вакансий: имя из config.json → функция загрузки. */

import { fetchVacancies as fetchTrudvsem } from './trudvsem.js';
import { fetchVacancies as fetchHabr } from './habr.js';

export const SOURCES = {
  trudvsem: {
    label: 'Работа в России',
    fetch: fetchTrudvsem,
    // Адрес работодателя есть у 76% вакансий — отклик уходит письмом из бота.
    supportsEmail: true,
  },
  habr: {
    label: 'Хабр Карьера',
    fetch: fetchHabr,
    // В RSS нет контактов: откликаться можно только на сайте.
    supportsEmail: false,
  },
};

export function sourceNames() {
  return Object.keys(SOURCES);
}

export function sourceLabel(name) {
  return SOURCES[name]?.label ?? name;
}

/**
 * Раскрывает запросы в задачи «источник + запрос».
 * У запроса может быть своё поле sources; иначе берутся общие из настроек.
 */
export function planQueries(queries = [], enabledSources = ['trudvsem']) {
  const tasks = [];

  for (const query of queries) {
    const names = (query.sources ?? enabledSources).filter((name) => SOURCES[name]);
    for (const name of names) {
      tasks.push({ source: name, query });
    }
  }

  return tasks;
}
