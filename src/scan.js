/** Поиск новых вакансий и отправка дайджеста. */

import { SOURCES, planQueries, sourceLabel } from './sources/index.js';
import { selectNew } from './filter.js';
import { windowStart, saveState } from './state.js';
import { sendDigest, formatVacancy } from './telegram.js';
import { registerVacancies, pruneCatalog } from './catalog.js';

/**
 * Один цикл поиска: опрашивает источники, отбирает новое, отправляет дайджест.
 * Возвращает отправленные вакансии — вызывающий сам решает, что о них сказать.
 *
 * dryRun печатает найденное в консоль и не меняет состояние: так можно
 * проверить настройки фильтров, ничего не отправляя.
 */
export async function scanVacancies(state, statePath, config, { credentials, dryRun = false, log = console.log, sources = SOURCES } = {}) {
  const modifiedFrom = windowStart(state.lastRunAt, { fallbackDays: config.filters?.maxAgeDays ?? 3 });
  log(`Окно поиска: с ${modifiedFrom}`);

  const tasks = planQueries(config.queries, config.sources ?? ['trudvsem']);
  if (tasks.length === 0) throw new Error('Не выбран ни один источник вакансий');

  const results = await Promise.allSettled(
    tasks.map(({ source, query }) =>
      sources[source].fetch(query, {
        perQuery: config.limits?.perQuery ?? 100,
        modifiedFrom,
        remoteOnly: config.filters?.remoteOnly ?? false,
      }),
    ),
  );

  const collected = [];
  const failures = [];
  results.forEach((result, i) => {
    const { source, query } = tasks[i];
    const label = `${sourceLabel(source)} / ${query.text}`;
    if (result.status === 'fulfilled') {
      log(`  ${label}: получено ${result.value.length}`);
      collected.push(...result.value);
    } else {
      const reason = result.reason?.message ?? String(result.reason);
      log(`  ${label}: ошибка — ${reason}`);
      failures.push({ label, reason });
    }
  });

  if (results.every((result) => result.status === 'rejected')) {
    throw new Error('Ни один источник не ответил');
  }

  const limit = config.limits?.maxNotificationsPerRun ?? 12;
  const matching = selectNew(collected, new Set(state.sentIds), config.filters ?? {});
  const fresh = matching.slice(0, limit);
  const deferred = matching.length - fresh.length;

  log(`Всего собрано ${collected.length}, после фильтров и дедупликации: ${matching.length}`);
  if (deferred > 0) {
    log(`Отправляю ${fresh.length}, остальные ${deferred} — в следующем запуске.`);
  }

  if (fresh.length === 0) {
    if (!dryRun) {
      state.lastRunAt = new Date().toISOString();
      await saveState(statePath, state);
    }
    return { sent: [], collected: collected.length, matching: 0, deferred: 0, failures };
  }

  state.catalog ??= {};
  pruneCatalog(state.catalog);
  const coded = registerVacancies(state.catalog, fresh);

  if (dryRun) {
    const withEmail = coded.filter((vacancy) => vacancy.email).length;
    log(`\n--- dry-run, сообщения не отправляются (с email: ${withEmail} из ${coded.length}) ---`);
    coded.forEach((vacancy, i) => log(`\n${formatVacancy(vacancy, i + 1)}`));
    return { sent: coded, collected: collected.length, matching: matching.length, deferred, failures };
  }

  await sendDigest(coded, credentials);

  state.sentIds = [...state.sentIds, ...coded.map((vacancy) => vacancy.id)];
  // Окно сдвигаем только когда отправили всё найденное. Иначе отложенные лимитом
  // вакансии выпали бы из следующего окна поиска и не пришли бы уже никогда.
  if (deferred === 0) state.lastRunAt = new Date().toISOString();
  state.totalSent = (state.totalSent ?? 0) + coded.length;
  await saveState(statePath, state);

  return { sent: coded, collected: collected.length, matching: matching.length, deferred, failures };
}
