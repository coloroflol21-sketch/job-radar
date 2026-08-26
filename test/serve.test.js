/**
 * Проверка режима живого бота: цикл должен отвечать на команды,
 * искать вакансии по таймеру и корректно останавливаться по сигналу.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { serve } from '../src/serve.js';

/**
 * Фейковый Telegram + источник вакансий на одном порту.
 * Источник отдаёт пустой список: поиск здесь не проверяем, только цикл.
 */
async function fakeApis({ updates = [] } = {}) {
  const sentMessages = [];
  const pending = [...updates];
  let getUpdatesCalls = 0;

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const json = (payload) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(payload));
    };

    if (url.pathname.endsWith('/getUpdates')) {
      getUpdatesCalls += 1;
      const offset = Number(url.searchParams.get('offset') ?? 0);
      const batch = pending.filter((update) => update.update_id >= offset);
      // Отдаём каждое сообщение один раз, дальше пусто — иначе цикл зациклится.
      pending.length = 0;
      return json({ ok: true, result: batch });
    }

    if (url.pathname.endsWith('/sendMessage')) {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        sentMessages.push(JSON.parse(body));
        json({ ok: true, result: { message_id: sentMessages.length } });
      });
      return;
    }

    json({ ok: false, description: 'not found' });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    sentMessages,
    get getUpdatesCalls() { return getUpdatesCalls; },
    close: () => new Promise((resolve) => server.close(resolve)),
    port,
  };
}

function message(id, text) {
  return { update_id: id, message: { chat: { id: 555 }, text, from: { username: 'me' } } };
}

async function tempStatePath() {
  return join(await mkdtemp(join(tmpdir(), 'job-radar-serve-')), 'state.json');
}

function baseState() {
  return {
    sentIds: [],
    lastRunAt: new Date().toISOString(),
    totalSent: 0,
    lastUpdateId: 0,
    sentLog: [],
    catalog: {
      A1: {
        id: 'vac-a',
        title: 'Python разработчик',
        company: 'ООО Тест',
        email: 'hr@example.com',
        url: 'https://trudvsem.ru/vacancy/a',
        addedAt: new Date().toISOString(),
      },
    },
  };
}

const emptyConfig = { queries: [], filters: {}, limits: {} };

/** Подменяет адрес Telegram на локальный сервер. */
function localFetch(port) {
  return (url, options) =>
    fetch(String(url).replace('https://api.telegram.org', `http://127.0.0.1:${port}`), options);
}

/** Поиск подменяется заглушкой: в этих тестах проверяется цикл, а не источник. */
function stubScan(log = () => {}) {
  const calls = [];
  const scan = async (state, statePath, config, options) => {
    calls.push(Date.now());
    options.log('Окно поиска: с (заглушка)');
    return [];
  };
  scan.calls = calls;
  return scan;
}

function runServe(state, statePath, apis, { stopSignal, logs, scanIntervalMinutes = 60, scan }) {
  return serve(state, statePath, emptyConfig, {
    credentials: { token: 'T', chatId: '555' },
    stopSignal,
    scanIntervalMinutes,
    log: (line) => logs.push(line),
    fetchImpl: localFetch(apis.port),
    scan: scan ?? stubScan(),
  });
}

test('цикл останавливается по сигналу и сообщает об этом', async () => {
  const apis = await fakeApis();
  const controller = new AbortController();
  const logs = [];

  try {
    // Останавливаем почти сразу: цикл должен выйти, а не висеть.
    setTimeout(() => controller.abort(), 150);

    await runServe(baseState(), await tempStatePath(), apis, { stopSignal: controller.signal, logs, scanIntervalMinutes: 60 });

    assert.ok(logs.some((line) => /Бот остановлен/.test(line)), 'должно быть сообщение об остановке');
  } finally {
    await apis.close();
  }
});

test('уже прерванный сигнал не запускает ни одного запроса', async () => {
  const apis = await fakeApis();
  const controller = new AbortController();
  controller.abort();

  try {
    await runServe(baseState(), await tempStatePath(), apis, { stopSignal: controller.signal, logs: [] });

    assert.equal(apis.getUpdatesCalls, 0, 'опрос не должен начинаться');
  } finally {
    await apis.close();
  }
});

test('поиск вакансий запускается сразу при старте', async () => {
  const apis = await fakeApis();
  const controller = new AbortController();
  const logs = [];

  try {
    setTimeout(() => controller.abort(), 200);

    await runServe(baseState(), await tempStatePath(), apis, { stopSignal: controller.signal, logs, scanIntervalMinutes: 60 });

    assert.ok(
      logs.some((line) => /Окно поиска/.test(line)),
      'при старте должен пройти первый поиск, не дожидаясь таймера',
    );
  } finally {
    await apis.close();
  }
});

test('бот отвечает на команду, пришедшую в живом цикле', async () => {
  const apis = await fakeApis({ updates: [message(1, '/list')] });
  const controller = new AbortController();
  const logs = [];

  try {
    setTimeout(() => controller.abort(), 400);

    await runServe(baseState(), await tempStatePath(), apis, { stopSignal: controller.signal, logs });

    const replies = apis.sentMessages.filter((m) => /A1|Python/.test(m.text));
    assert.ok(replies.length > 0, `ожидался ответ на /list, отправлено: ${JSON.stringify(apis.sentMessages)}`);
    assert.ok(logs.some((line) => /Ответов на команды/.test(line)));
  } finally {
    await apis.close();
  }
});

test('поиск не повторяется, пока не вышел интервал', async () => {
  const apis = await fakeApis();
  const controller = new AbortController();
  const scan = stubScan();

  try {
    // Интервал час, цикл живёт полсекунды — поиск должен пройти ровно один раз.
    setTimeout(() => controller.abort(), 500);

    await runServe(baseState(), await tempStatePath(), apis, {
      stopSignal: controller.signal,
      logs: [],
      scanIntervalMinutes: 60,
      scan,
    });

    assert.equal(scan.calls.length, 1, 'повторный поиск раньше времени не нужен');
  } finally {
    await apis.close();
  }
});

test('сбой поиска не останавливает бота', async () => {
  const apis = await fakeApis();
  const controller = new AbortController();
  const logs = [];
  const failing = async () => { throw new Error('источник недоступен'); };

  try {
    setTimeout(() => controller.abort(), 300);

    await runServe(baseState(), await tempStatePath(), apis, {
      stopSignal: controller.signal,
      logs,
      scan: failing,
    });

    assert.ok(logs.some((line) => /Поиск не удался: источник недоступен/.test(line)));
    assert.ok(logs.some((line) => /Бот остановлен/.test(line)), 'цикл всё равно завершился нормально');
  } finally {
    await apis.close();
  }
});

test('в логе видны подсказки по командам и способ остановки', async () => {
  const apis = await fakeApis();
  const controller = new AbortController();
  const logs = [];

  try {
    setTimeout(() => controller.abort(), 120);

    await runServe(baseState(), await tempStatePath(), apis, { stopSignal: controller.signal, logs, scanIntervalMinutes: 45 });

    const text = logs.join('\n');
    assert.match(text, /\/help/);
    assert.match(text, /Ctrl\+C/);
    assert.match(text, /45 мин/, 'интервал поиска должен быть виден');
  } finally {
    await apis.close();
  }
});
