/** Поиск новых вакансий и отправка дайджеста. */

import { fetchVacancies } from './sources/trudvsem.js';
import { selectNew } from './filter.js';
import { windowStart, saveState } from './state.js';
import { sendDigest, formatVacancy } from './telegram.js';
import { registerVacancies, pruneCatalog } from './catalog.js';

/**
 * Один цикл поиска: опрашивает источник, отбирает новое, отправляет дайджест.
 * Возвращает отправленные вакансии — вызывающий сам решает, что о них сказать.
 *
 * dryRun печатает найденное в консоль и не меняет состояние: так можно
 * проверить настройки фильтров, ничего не отправляя.
 */
export async function scanVacancies(state, statePath, config, { credentials, dryRun = false, log = console.log } = {}) {
  const modifiedFrom = windowStart(state.lastRunAt, { fallbackDays: config.filters?.maxAgeDays ?? 3 });
  log(`Окно поиска: с ${modifiedFrom}`);

  const results = await Promise.allSettled(
    config.queries.map((query) =>
      fetchVacancies(query, { perQuery: config.limits?.perQuery ?? 100, modifiedFrom }),
    ),
  );

  const collected = [];
  results.forEach((result, i) => {
    const query = config.queries[i];
    const label = `${query.text}@${query.region ?? 'все регионы'}`;
    if (result.status === 'fulfilled') {
      log(`  ${label}: получено ${result.value.length}`);
      collected.push(...result.value);
    } else {
      log(`  ${label}: ошибка — ${result.reason?.message ?? result.reason}`);
    }
  });

  if (results.every((result) => result.status === 'rejected')) {
    throw new Error('Ни один запрос не выполнился, источник недоступен');
  }

  const fresh = selectNew(
    collected,
    new Set(state.sentIds),
    config.filters ?? {},
    config.limits?.maxNotificationsPerRun ?? 12,
  );

  log(`Всего собрано ${collected.length}, после фильтров и дедупликации: ${fresh.length}`);

  if (fresh.length === 0) {
    if (!dryRun) {
      state.lastRunAt = new Date().toISOString();
      await saveState(statePath, state);
    }
    return [];
  }

  state.catalog ??= {};
  pruneCatalog(state.catalog);
  const coded = registerVacancies(state.catalog, fresh);

  if (dryRun) {
    const withEmail = coded.filter((vacancy) => vacancy.email).length;
    log(`\n--- dry-run, сообщения не отправляются (с email: ${withEmail} из ${coded.length}) ---`);
    coded.forEach((vacancy, i) => log(`\n${formatVacancy(vacancy, i + 1)}`));
    return coded;
  }

  await sendDigest(coded, credentials);

  state.sentIds = [...state.sentIds, ...coded.map((vacancy) => vacancy.id)];
  state.lastRunAt = new Date().toISOString();
  state.totalSent = (state.totalSent ?? 0) + coded.length;
  await saveState(statePath, state);

  return coded;
}
