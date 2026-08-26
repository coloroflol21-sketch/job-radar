/**
 * Проверка цикла поиска: главное — вакансии, отложенные лимитом,
 * должны приходить следующим запуском, а не теряться.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scanVacancies } from '../src/scan.js';
import { loadState } from '../src/state.js';

/** Фейковый Telegram: считает отправленные сообщения. */
async function fakeTelegram() {
  const sent = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      if (body) sent.push(JSON.parse(body));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, result: { message_id: sent.length } }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return {
    sent,
    close: () => new Promise((r) => server.close(r)),
    credentials: {
      token: 'T',
      chatId: '555',
      fetchImpl: (url, options) =>
        fetch(String(url).replace('https://api.telegram.org', `http://127.0.0.1:${port}`), options),
    },
  };
}

function freshState() {
  return { sentIds: [], lastRunAt: null, totalSent: 0, catalog: {}, sentLog: [], lastUpdateId: 0 };
}

async function tempStatePath() {
  return join(await mkdtemp(join(tmpdir(), 'job-radar-scan-')), 'state.json');
}

const config = {
  sources: ['trudvsem'],
  queries: [{ text: 'python', region: '7700000000' }],
  filters: { minSalary: 0, maxAgeDays: 30 },
  limits: { perQuery: 100, maxNotificationsPerRun: 3 },
};

/** Подменяет реестр источников: единственный источник отдаёт заданный набор. */
function stubSources(vacancies) {
  return {
    trudvsem: { label: 'Работа в России', supportsEmail: true, fetch: async () => vacancies },
  };
}

/** Готовит вакансии в общем формате, который отдают источники. */
function makeVacancies(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: `vac-${i}`,
    title: `Разработчик ${i}`,
    company: 'ООО Тест',
    region: 'Москва',
    url: `https://example.com/${i}`,
    salaryMin: 150000,
    salaryMax: 0,
    email: 'hr@example.com',
    contactPerson: '',
    schedule: 'Полный день',
    experienceYears: 1,
    description: '',
    createdAt: new Date().toISOString(),
    modifiedAt: new Date(Date.now() - i * 60_000).toISOString(),
  }));
}

test('лимит отправки не двигает окно поиска, пока есть отложенные', async () => {
  const telegram = await fakeTelegram();
  const statePath = await tempStatePath();
  const state = freshState();
  const logs = [];

  try {
    // 10 подходящих вакансий при лимите 3.
    const sent = await scanVacancies(state, statePath, config, {
      credentials: telegram.credentials,
      log: (line) => logs.push(line),
      sources: stubSources(makeVacancies(10)),
    });

    assert.equal(sent.length, 3, 'отправлено ровно по лимиту');
    assert.equal(
      state.lastRunAt,
      null,
      'окно НЕ сдвинуто: иначе отложенные 7 выпали бы из следующего поиска',
    );
    assert.ok(
      logs.some((line) => /остальные 7/.test(line)),
      'в логе должно быть видно, сколько отложено',
    );
  } finally {
    await telegram.close();
  }
});

test('когда отправлено всё найденное, окно сдвигается', async () => {
  const telegram = await fakeTelegram();
  const statePath = await tempStatePath();
  const state = freshState();

  try {
    const sent = await scanVacancies(state, statePath, config, {
      credentials: telegram.credentials,
      log: () => {},
      sources: stubSources(makeVacancies(2)),
    });

    assert.equal(sent.length, 2);
    assert.ok(state.lastRunAt, 'окно сдвинуто: ничего не осталось');
  } finally {
    await telegram.close();
  }
});

test('отложенные вакансии приходят следующим запуском', async () => {
  const telegram = await fakeTelegram();
  const statePath = await tempStatePath();
  const state = freshState();
  const pool = makeVacancies(7);

  try {
    const first = await scanVacancies(state, statePath, config, {
      credentials: telegram.credentials,
      log: () => {},
      sources: stubSources(pool),
    });
    const second = await scanVacancies(state, statePath, config, {
      credentials: telegram.credentials,
      log: () => {},
      sources: stubSources(pool),
    });
    const third = await scanVacancies(state, statePath, config, {
      credentials: telegram.credentials,
      log: () => {},
      sources: stubSources(pool),
    });

    const ids = [...first, ...second, ...third].map((v) => v.id);
    assert.equal(ids.length, 7, 'за три запуска пришли все семь');
    assert.equal(new Set(ids).size, 7, 'без повторов');
    assert.ok(state.lastRunAt, 'после исчерпания очереди окно сдвинулось');
  } finally {
    await telegram.close();
  }
});

test('повторный запуск не присылает те же вакансии заново', async () => {
  const telegram = await fakeTelegram();
  const statePath = await tempStatePath();
  const state = freshState();
  const pool = makeVacancies(2);

  try {
    await scanVacancies(state, statePath, config, {
      credentials: telegram.credentials,
      log: () => {},
      sources: stubSources(pool),
    });
    const again = await scanVacancies(state, statePath, config, {
      credentials: telegram.credentials,
      log: () => {},
      sources: stubSources(pool),
    });

    assert.deepEqual(again, [], 'дубликатов нет');
  } finally {
    await telegram.close();
  }
});

test('состояние с отправленными id сохраняется на диск', async () => {
  const telegram = await fakeTelegram();
  const statePath = await tempStatePath();
  const state = freshState();

  try {
    await scanVacancies(state, statePath, config, {
      credentials: telegram.credentials,
      log: () => {},
      sources: stubSources(makeVacancies(2)),
    });

    const saved = await loadState(statePath);
    assert.equal(saved.sentIds.length, 2);
    assert.equal(saved.totalSent, 2);
    assert.equal(Object.keys(saved.catalog).length, 2, 'коды для откликов записаны');
  } finally {
    await telegram.close();
  }
});

test('dry-run ничего не отправляет и не меняет состояние', async () => {
  const telegram = await fakeTelegram();
  const statePath = await tempStatePath();
  const state = freshState();

  try {
    await scanVacancies(state, statePath, config, {
      credentials: telegram.credentials,
      dryRun: true,
      log: () => {},
      sources: stubSources(makeVacancies(5)),
    });

    assert.equal(telegram.sent.length, 0, 'сообщений не было');
    assert.deepEqual(state.sentIds, [], 'состояние не тронуто');
    assert.equal(state.lastRunAt, null);
  } finally {
    await telegram.close();
  }
});

test('вакансии собираются из всех включённых источников', async () => {
  const telegram = await fakeTelegram();
  const statePath = await tempStatePath();
  const logs = [];

  const sources = {
    trudvsem: {
      label: 'Работа в России',
      supportsEmail: true,
      fetch: async () => [{ ...makeVacancies(1)[0], id: 'tv-1', title: 'Из Работы в России' }],
    },
    habr: {
      label: 'Хабр Карьера',
      supportsEmail: false,
      fetch: async () => [{ ...makeVacancies(1)[0], id: 'habr-1', title: 'Из Хабра', email: '' }],
    },
  };

  try {
    const sent = await scanVacancies(
      freshState(),
      statePath,
      { ...config, sources: ['trudvsem', 'habr'] },
      { credentials: telegram.credentials, log: (l) => logs.push(l), sources },
    );

    assert.equal(sent.length, 2, 'вакансии из двух источников объединены');
    assert.ok(logs.some((l) => /Работа в России/.test(l)));
    assert.ok(logs.some((l) => /Хабр Карьера/.test(l)));
  } finally {
    await telegram.close();
  }
});

test('падение одного источника не отменяет второй', async () => {
  const telegram = await fakeTelegram();
  const statePath = await tempStatePath();
  const logs = [];

  const sources = {
    trudvsem: { label: 'Работа в России', supportsEmail: true, fetch: async () => { throw new Error('таймаут'); } },
    habr: { label: 'Хабр Карьера', supportsEmail: false, fetch: async () => makeVacancies(2) },
  };

  try {
    const sent = await scanVacancies(
      freshState(),
      statePath,
      { ...config, sources: ['trudvsem', 'habr'] },
      { credentials: telegram.credentials, log: (l) => logs.push(l), sources },
    );

    assert.equal(sent.length, 2, 'рабочий источник отработал');
    assert.ok(logs.some((l) => /Работа в России.*таймаут/.test(l)), 'ошибка видна в логе');
  } finally {
    await telegram.close();
  }
});

test('когда все источники упали — это ошибка, а не «нет вакансий»', async () => {
  const telegram = await fakeTelegram();
  const statePath = await tempStatePath();
  const failing = {
    trudvsem: { label: 'Работа в России', supportsEmail: true, fetch: async () => { throw new Error('нет сети'); } },
  };

  try {
    await assert.rejects(
      () => scanVacancies(freshState(), statePath, config, {
        credentials: telegram.credentials,
        log: () => {},
        sources: failing,
      }),
      /Ни один источник не ответил/,
    );
  } finally {
    await telegram.close();
  }
});

test('пустой список источников — понятная ошибка', async () => {
  const telegram = await fakeTelegram();
  const statePath = await tempStatePath();
  try {
    await assert.rejects(
      () => scanVacancies(freshState(), statePath, { ...config, sources: [] }, {
        credentials: telegram.credentials,
        log: () => {},
        sources: stubSources(makeVacancies(1)),
      }),
      /Не выбран ни один источник/,
    );
  } finally {
    await telegram.close();
  }
});
