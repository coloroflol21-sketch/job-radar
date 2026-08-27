/** Поиск новых вакансий и отправка дайджеста. */

import { SOURCES, planQueries, sourceLabel } from './sources/index.js';
import { selectNew } from './filter.js';
import { windowStart, saveState } from './state.js';
import { sendVacancyCards, formatVacancy } from './telegram.js';
import { registerVacancies, pruneCatalog } from './catalog.js';

/**
 * Один цикл поиска: опрашивает источники, отбирает новое, отправляет дайджест.
 * Возвращает отправленные вакансии — вызывающий сам решает, что о них сказать.
 *
 * dryRun печатает найденное в консоль и не меняет состояние: так можно
 * проверить настройки фильтров, ничего не отправляя.
 */
export async function scanVacancies(state, statePath, config, { credentials, dryRun = false, log = console.log, sources = SOURCES, sleep } = {}) {
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

  // Источник, который ответил 200, но не дал ни одной вакансии там, где обычно
  // даёт сотни, — сломался. Молча пустая выдача выглядела бы как «нет вакансий».
  state.sourceHealth ??= {};
  const queryKey = JSON.stringify((config.queries ?? []).map((query) => query.text));
  const broken = [];

  results.forEach((result, i) => {
    if (result.status !== 'fulfilled') return;
    const { source } = tasks[i];
    const count = result.value.length;
    const health = state.sourceHealth[source] ?? { best: 0, queryKey };

    // Планка привязана к запросам: после их смены источник законно отдаёт
    // другое количество, и старая планка вызывала ложные тревоги.
    if (health.queryKey !== queryKey) {
      health.best = 0;
      health.queryKey = queryKey;
    }

    // Планка забывается со временем: выдача источника меняется сама по себе.
    health.best = Math.max(count, Math.round((health.best ?? 0) * 0.5));

    if (count === 0 && health.best >= 10) {
      // Сообщаем один раз: при поиске каждые пять минут повторы превратились бы
      // в поток одинаковых предупреждений, и на них перестали бы реагировать.
      if (!health.reportedEmpty) {
        broken.push(sourceLabel(source));
        health.reportedEmpty = true;
      }
    } else if (count > 0) {
      health.reportedEmpty = false;
    }

    state.sourceHealth[source] = health;
  });

  if (broken.length > 0) {
    const unique = [...new Set(broken)];
    log(`  внимание: ${unique.join(', ')} ответили без ошибки, но не дали вакансий`);
    failures.push({
      label: unique.join(', '),
      reason: 'ответил без ошибки, но не вернул ни одной вакансии — возможно, изменился формат',
    });
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
  const keepCodes = [...(state.saved ?? []), ...(state.sentLog ?? []).map((record) => record.code)];
  pruneCatalog(state.catalog, new Date(), { keepCodes });
  // state передаётся как счётчик: nextCodeIndex только растёт, поэтому код
  // никогда не достанется другой вакансии.
  const coded = registerVacancies(state.catalog, fresh, new Date(), state);

  if (dryRun) {
    const withEmail = coded.filter((vacancy) => vacancy.email).length;
    log(`\n--- dry-run, сообщения не отправляются (с email: ${withEmail} из ${coded.length}) ---`);
    coded.forEach((vacancy, i) => log(`\n${formatVacancy(vacancy, i + 1)}`));
    return { sent: coded, collected: collected.length, matching: matching.length, deferred, failures };
  }

  // Карточками, а не одним дайджестом: кнопки привязаны к сообщению,
  // поэтому у каждой вакансии должно быть своё.
  const { delivered, error } = await sendVacancyCards(coded, credentials, sleep ? { sleep } : {});

  // Отправленными считаем только дошедшие: иначе оборванная на середине
  // рассылка навсегда спрятала бы оставшиеся вакансии.
  state.sentIds = [...state.sentIds, ...delivered.map((vacancy) => vacancy.id)];
  // Окно сдвигаем только когда отправили всё найденное. Иначе отложенные лимитом
  // вакансии выпали бы из следующего окна поиска и не пришли бы уже никогда.
  if (deferred === 0 && !error) state.lastRunAt = new Date().toISOString();
  state.totalSent = (state.totalSent ?? 0) + delivered.length;
  await saveState(statePath, state);

  if (error) {
    log(`Доставлено ${delivered.length} из ${coded.length}, дальше сбой: ${error.message}`);
  }

  return {
    sent: delivered,
    collected: collected.length,
    matching: matching.length,
    deferred: deferred + (coded.length - delivered.length),
    failures,
  };
}
