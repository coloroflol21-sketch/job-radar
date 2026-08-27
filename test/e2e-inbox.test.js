/**
 * Сквозная проверка обработки команд: локальный фейковый Telegram API
 * вместо настоящего, поддельный SMTP вместо почты. Проверяет связку
 * getUpdates → разбор → отправка → ответ → сохранение состояния.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { processInbox } from '../src/inbox.js';
import { loadState } from '../src/state.js';

/** Фейковый Telegram: отдаёт заданные апдейты и записывает отправленное. */
async function fakeTelegram(updates) {
  const sentMessages = [];
  const edited = [];
  const offsets = [];

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');

    if (url.pathname.endsWith('/getUpdates')) {
      const offset = Number(url.searchParams.get('offset') ?? 0);
      offsets.push(offset);
      const pending = updates.filter((u) => u.update_id >= offset);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: true, result: pending }));
      return;
    }

    if (url.pathname.endsWith('/sendMessage')) {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        sentMessages.push(JSON.parse(body));
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, result: { message_id: sentMessages.length } }));
      });
      return;
    }

    // Нажатие кнопки правит существующее сообщение и гасит «часики».
    if (url.pathname.endsWith('/editMessageText')) {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        edited.push(JSON.parse(body));
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, result: { message_id: 5 } }));
      });
      return;
    }

    if (url.pathname.endsWith('/answerCallbackQuery')) {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ ok: true, result: true }));
      });
      return;
    }

    res.statusCode = 404;
    res.end('{"ok":false,"description":"not found"}');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  return {
    sentMessages,
    edited,
    offsets,
    close: () => new Promise((resolve) => server.close(resolve)),
    /** fetch, подменяющий адрес Telegram на локальный сервер. */
    fetchImpl: (url, options) =>
      fetch(String(url).replace('https://api.telegram.org', `http://127.0.0.1:${port}`), options),
  };
}

function message(id, text, chatId = 555) {
  return { update_id: id, message: { chat: { id: chatId }, text, from: { username: 'me' } } };
}

function stateWithCatalog() {
  return {
    sentIds: [],
    lastRunAt: null,
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
        contactPerson: 'Иванова Мария',
        addedAt: new Date().toISOString(),
      },
    },
  };
}

/** Вызывает настоящий processInbox, подменяя только сеть и почтовый транспорт. */
function run(state, statePath, telegram, transport) {
  return processInbox(
    state,
    statePath,
    { token: 'T', chatId: '555' },
    {
      createTransport: () => {
        if (!transport) throw new Error('Не заданы SMTP_USER или SMTP_PASSWORD');
        return transport;
      },
      mail: { from: 'me@example.com', replyTo: 'me@example.com' },
      fetchImpl: telegram.fetchImpl,
    },
  );
}

async function tempStatePath() {
  return join(await mkdtemp(join(tmpdir(), 'job-radar-e2e-')), 'state.json');
}

test('сквозной цикл: /apply отправляет письмо и подтверждает в чат', async () => {
  const telegram = await fakeTelegram([
    message(10, '/apply A1\nЗдравствуйте! Заинтересовала ваша вакансия, готов обсудить детали.'),
  ]);
  const mailed = [];
  const transport = { sendMail: async (m) => { mailed.push(m); return { messageId: '<x>', accepted: [m.to] }; } };
  const statePath = await tempStatePath();
  const state = stateWithCatalog();

  try {
    await run(state, statePath, telegram, transport);

    // Письмо необратимо, поэтому сначала только показ и кнопки.
    assert.equal(mailed.length, 0, 'без подтверждения письмо не уходит');
    assert.equal(telegram.sentMessages.length, 1);
    assert.match(telegram.sentMessages[0].text, /Проверьте письмо перед отправкой/);
    assert.match(telegram.sentMessages[0].text, /hr@example\.com/);
    assert.ok(telegram.sentMessages[0].reply_markup, 'должны быть кнопки');

    const saved = await loadState(statePath);
    assert.equal(saved.pendingApply.code, 'A1', 'отклик ждёт подтверждения');
    assert.equal(saved.sentLog.length, 0);
    assert.equal(saved.lastUpdateId, 10, 'апдейт подтверждён');
  } finally {
    await telegram.close();
  }
});

test('нажатие «Отправить» отправляет письмо и правит сообщение', async () => {
  const prepare = await fakeTelegram([message(11, '/apply A1\nЗдравствуйте! Заинтересовала ваша вакансия, готов обсудить детали.')]);
  const mailed = [];
  const transport = { sendMail: async (m) => { mailed.push(m); return { messageId: '<x>', accepted: [m.to] }; } };
  const statePath = await tempStatePath();
  const state = stateWithCatalog();

  try {
    await run(state, statePath, prepare, transport);
  } finally {
    await prepare.close();
  }

  const confirm = await fakeTelegram([
    { update_id: 12, callback_query: { id: 'cb-12', data: 'apply:yes:A1', message: { message_id: 5, chat: { id: 555 } } } },
  ]);

  try {
    await run(await loadState(statePath), statePath, confirm, transport);

    assert.equal(mailed.length, 1, 'после подтверждения письмо ушло');
    assert.equal(mailed[0].to, 'hr@example.com');
    assert.match(mailed[0].text, /Иванова Мария, здравствуйте!/);

    const saved = await loadState(statePath);
    assert.equal(saved.sentLog.length, 1, 'записано в журнал');
    assert.equal(saved.pendingApply, null, 'подтверждение одноразовое');
  } finally {
    await confirm.close();
  }
});

test('нажатие «Отменить» не отправляет письмо', async () => {
  const prepare = await fakeTelegram([message(20, '/apply A1\nЗдравствуйте! Заинтересовала ваша вакансия, готов обсудить детали.')]);
  const mailed = [];
  const transport = { sendMail: async (m) => { mailed.push(m); return { messageId: '<x>' }; } };
  const statePath = await tempStatePath();

  try {
    await run(stateWithCatalog(), statePath, prepare, transport);
  } finally {
    await prepare.close();
  }

  const cancel = await fakeTelegram([
    { update_id: 21, callback_query: { id: 'cb-21', data: 'apply:no:0', message: { message_id: 5, chat: { id: 555 } } } },
  ]);

  try {
    await run(await loadState(statePath), statePath, cancel, transport);

    assert.equal(mailed.length, 0, 'письмо не ушло');
    const saved = await loadState(statePath);
    assert.equal(saved.pendingApply, null, 'ожидание снято');
    assert.equal(saved.sentLog.length, 0);
  } finally {
    await cancel.close();
  }
});

test('апдейты подтверждаются до выполнения, поэтому команда не повторится', async () => {
  const telegram = await fakeTelegram([message(20, '/list')]);
  const statePath = await tempStatePath();
  const state = stateWithCatalog();

  try {
    await run(state, statePath, telegram, null);
    // Смещение выше последнего update_id — Telegram больше не отдаст это сообщение.
    assert.ok(telegram.offsets.includes(21), `ожидался offset 21, были: ${telegram.offsets}`);

    const saved = await loadState(statePath);
    const second = await run(saved, statePath, telegram, null);
    assert.deepEqual(second, [], 'повторной обработки нет');
  } finally {
    await telegram.close();
  }
});

test('сообщение из чужого чата не выполняется, но подтверждается', async () => {
  const telegram = await fakeTelegram([
    message(30, '/apply A1\nПопытка отправить отклик от чужого имени в обход владельца.', 999),
  ]);
  const mailed = [];
  const transport = { sendMail: async (m) => { mailed.push(m); return { messageId: '<x>' }; } };
  const statePath = await tempStatePath();
  const state = stateWithCatalog();

  try {
    await run(state, statePath, telegram, transport);

    assert.equal(mailed.length, 0, 'письмо не отправлено');
    assert.equal(telegram.sentMessages.length, 0, 'ответа чужому нет');
    const saved = await loadState(statePath);
    assert.equal(saved.lastUpdateId, 30, 'апдейт подтверждён, чтобы не читать его снова');
  } finally {
    await telegram.close();
  }
});

test('несколько команд в одном запуске выполняются по порядку', async () => {
  const telegram = await fakeTelegram([
    message(40, '/list'),
    message(41, '/apply A1\nЗдравствуйте! Готов обсудить вашу вакансию подробнее.'),
    message(42, '/sent'),
  ]);
  const transport = { sendMail: async (m) => ({ messageId: '<x>', accepted: [m.to] }) };
  const statePath = await tempStatePath();

  try {
    const replies = await run(stateWithCatalog(), statePath, telegram, transport);
    assert.equal(replies.length, 3);
    assert.equal(telegram.sentMessages.length, 3);
    // Отклик показывается для подтверждения, а не отправляется сразу.
    assert.match(telegram.sentMessages[1].text, /Проверьте письмо перед отправкой/);
    // Журнал пуст: письмо ещё не подтверждено.
    assert.match(telegram.sentMessages[2].text, /не было/);
  } finally {
    await telegram.close();
  }
});

test('пустой ящик не приводит к отправке сообщений', async () => {
  const telegram = await fakeTelegram([]);
  const statePath = await tempStatePath();
  try {
    const replies = await run(stateWithCatalog(), statePath, telegram, null);
    assert.deepEqual(replies, []);
    assert.equal(telegram.sentMessages.length, 0);
  } finally {
    await telegram.close();
  }
});

test('/apply без настроенного SMTP объясняет проблему и не роняет запуск', async () => {
  const telegram = await fakeTelegram([
    message(50, '/apply A1\nЗдравствуйте! Заинтересовала ваша вакансия, готов обсудить детали.'),
  ]);
  const statePath = await tempStatePath();
  const state = stateWithCatalog();

  try {
    const replies = await run(state, statePath, telegram, null);

    assert.equal(replies.length, 1);
    assert.match(replies[0], /Отправка почты не настроена/);
    assert.match(telegram.sentMessages[0].text, /SMTP_USER/);
    assert.equal(state.sentLog.length, 0, 'журнал пуст: письма не было');
  } finally {
    await telegram.close();
  }
});

test('/list работает без настроек почты', async () => {
  const telegram = await fakeTelegram([message(60, '/list')]);
  const statePath = await tempStatePath();

  try {
    const replies = await run(stateWithCatalog(), statePath, telegram, null);
    assert.equal(replies.length, 1);
    assert.match(replies[0], /A1/);
  } finally {
    await telegram.close();
  }
});

test('отклик целиком кликами: кнопка, текст письма, подтверждение', async () => {
  const statePath = await tempStatePath();
  const mailed = [];
  const transport = { sendMail: async (m) => { mailed.push(m); return { messageId: '<x>', accepted: [m.to] }; } };

  // 1. Нажали «Откликнуться» под вакансией — бот просит текст письма.
  const step1 = await fakeTelegram([
    { update_id: 30, callback_query: { id: 'cb-30', data: 'act:apply:A1', message: { message_id: 4, chat: { id: 555 } } } },
  ]);
  try {
    await run(stateWithCatalog(), statePath, step1, transport);
    assert.equal(step1.sentMessages.length, 1);
    assert.match(step1.sentMessages[0].text, /Напишите текст письма/);
    assert.equal(step1.sentMessages[0].reply_markup?.force_reply, true, 'поле ввода должно открыться само');
    assert.equal(mailed.length, 0);

    const afterAsk = await loadState(statePath);
    assert.equal(afterAsk.awaitingLetter.code, 'A1', 'бот помнит, на что ждёт ответ');
  } finally {
    await step1.close();
  }

  // 2. Написали текст без всякой команды — он становится письмом.
  const step2 = await fakeTelegram([
    message(31, 'Здравствуйте! Заинтересовала ваша вакансия, готов обсудить детали.'),
  ]);
  try {
    await run(await loadState(statePath), statePath, step2, transport);
    assert.match(step2.sentMessages[0].text, /Проверьте письмо перед отправкой/);
    assert.equal(mailed.length, 0, 'до подтверждения письмо не уходит');

    const ready = await loadState(statePath);
    assert.equal(ready.pendingApply.code, 'A1');
    assert.equal(ready.awaitingLetter, null, 'ожидание текста снято');
  } finally {
    await step2.close();
  }

  // 3. Нажали «Отправить».
  const step3 = await fakeTelegram([
    { update_id: 32, callback_query: { id: 'cb-32', data: 'apply:yes:A1', message: { message_id: 6, chat: { id: 555 } } } },
  ]);
  try {
    await run(await loadState(statePath), statePath, step3, transport);
    assert.equal(mailed.length, 1, 'письмо ушло без единой набранной команды');
    assert.equal(mailed[0].to, 'hr@example.com');

    const done = await loadState(statePath);
    assert.equal(done.sentLog.length, 1);
  } finally {
    await step3.close();
  }
});

test('кнопки разделов открывают их без набора команд', async () => {
  const statePath = await tempStatePath();
  const telegram = await fakeTelegram([
    { update_id: 40, callback_query: { id: 'cb-40', data: 'go:list', message: { message_id: 4, chat: { id: 555 } } } },
  ]);

  try {
    await run(stateWithCatalog(), statePath, telegram, null);
    assert.equal(telegram.sentMessages.length, 1);
    assert.match(telegram.sentMessages[0].text, /A1/, 'открылся список вакансий');
  } finally {
    await telegram.close();
  }
});

test('кнопка «В избранное» работает из-под вакансии', async () => {
  const statePath = await tempStatePath();
  const telegram = await fakeTelegram([
    { update_id: 41, callback_query: { id: 'cb-41', data: 'act:save:A1', message: { message_id: 4, chat: { id: 555 } } } },
  ]);

  try {
    await run(stateWithCatalog(), statePath, telegram, null);
    assert.match(telegram.sentMessages[0].text, /в избранном/);
    const saved = await loadState(statePath);
    assert.deepEqual(saved.saved, ['A1']);
  } finally {
    await telegram.close();
  }
});

test('обычный текст без ожидания письма не считается откликом', async () => {
  const statePath = await tempStatePath();
  const telegram = await fakeTelegram([message(42, 'просто привет')]);

  try {
    const replies = await run(stateWithCatalog(), statePath, telegram, null);
    assert.deepEqual(replies, [], 'болтовня игнорируется');
    assert.equal(telegram.sentMessages.length, 0);
  } finally {
    await telegram.close();
  }
});
