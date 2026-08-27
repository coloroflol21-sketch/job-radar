/**
 * Проверка здоровья источников не должна беспокоить зря: пустая выдача бывает
 * законной, если пользователь сузил запрос. Ложные тревоги обесценивают настоящие.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scanVacancies } from '../src/scan.js';

async function fakeTelegram() {
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, result: { message_id: 1 } }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    close: () => new Promise((resolve) => server.close(resolve)),
    credentials: {
      token: 'T',
      chatId: '1',
      fetchImpl: (url, options) =>
        fetch(String(url).replace('https://api.telegram.org', `http://127.0.0.1:${port}`), options),
    },
  };
}

function state() {
  return { sentIds: [], lastRunAt: null, totalSent: 0, catalog: {}, sentLog: [], saved: [], sourceHealth: {} };
}

function vacancies(count) {
  return Array.from({ length: count }, (_, i) => ({
    id: `v${i}`,
    title: `Вакансия ${i}`,
    company: 'ООО',
    email: '',
    url: 'u',
    salaryMin: 0,
    salaryMax: 0,
    description: '',
    createdAt: new Date().toISOString(),
    modifiedAt: new Date().toISOString(),
  }));
}

const config = (queries) => ({
  sources: ['trudvsem'],
  queries,
  filters: { maxAgeDays: 30 },
  limits: { maxNotificationsPerRun: 12 },
});

function source(count) {
  return { trudvsem: { label: 'Работа в России', supportsEmail: true, fetch: async () => vacancies(count) } };
}

async function tempPath() {
  return join(await mkdtemp(join(tmpdir(), 'health-')), 's.json');
}

test('о пустой выдаче сообщается один раз, а не каждый прогон', async () => {
  const telegram = await fakeTelegram();
  const path = await tempPath();
  const shared = state();
  const queries = [{ text: 'поддержка' }];

  try {
    // Источник задаёт норму.
    await scanVacancies(shared, path, config(queries), {
      credentials: telegram.credentials, log: () => {}, sleep: async () => {}, sources: source(50),
    });

    const alarms = [];
    for (let run = 0; run < 6; run += 1) {
      const { failures } = await scanVacancies(shared, path, config(queries), {
        credentials: telegram.credentials, log: () => {}, sleep: async () => {}, sources: source(0),
      });
      if (failures.length > 0) alarms.push(run);
    }

    assert.equal(alarms.length, 1, `тревог ${alarms.length}, ожидалась одна`);
  } finally {
    await telegram.close();
  }
});

test('смена запроса сбрасывает планку: сужение это не поломка', async () => {
  const telegram = await fakeTelegram();
  const path = await tempPath();
  const shared = state();

  try {
    await scanVacancies(shared, path, config([{ text: 'поддержка' }]), {
      credentials: telegram.credentials, log: () => {}, sleep: async () => {}, sources: source(200),
    });

    // Пользователь сузил запрос — источник законно отдаёт ноль.
    const { failures } = await scanVacancies(shared, path, config([{ text: 'очень узкая фраза' }]), {
      credentials: telegram.credentials, log: () => {}, sleep: async () => {}, sources: source(0),
    });

    assert.deepEqual(failures, [], 'источник в порядке, виноват узкий запрос');
  } finally {
    await telegram.close();
  }
});

test('повторная поломка после восстановления снова замечается', async () => {
  const telegram = await fakeTelegram();
  const path = await tempPath();
  const shared = state();
  const queries = [{ text: 'поддержка' }];
  const run = (count) =>
    scanVacancies(shared, path, config(queries), {
      credentials: telegram.credentials, log: () => {}, sleep: async () => {}, sources: source(count),
    });

  try {
    await run(50);
    const first = await run(0);
    assert.equal(first.failures.length, 1, 'первая поломка замечена');

    await run(50); // источник ожил
    const second = await run(0);
    assert.equal(second.failures.length, 1, 'новая поломка замечена снова');
  } finally {
    await telegram.close();
  }
});

test('источник без истории пустой выдачей не тревожит', async () => {
  const telegram = await fakeTelegram();
  try {
    const { failures } = await scanVacancies(state(), await tempPath(), config([{ text: 'x' }]), {
      credentials: telegram.credentials, log: () => {}, sleep: async () => {}, sources: source(0),
    });
    assert.deepEqual(failures, []);
  } finally {
    await telegram.close();
  }
});
