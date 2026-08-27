/** Проверка почты не должна ломать поиск вакансий и спамить повторами. */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { checkReplies } from '../src/replies.js';
import { loadState } from '../src/state.js';

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
      chatId: '1',
      fetchImpl: (url, options) =>
        fetch(String(url).replace('https://api.telegram.org', `http://127.0.0.1:${port}`), options),
    },
  };
}

function stateWithApplication() {
  return {
    sentIds: [], catalog: {}, saved: [], seenReplies: [], sourceHealth: {},
    sentLog: [{ code: 'A5', title: 'Специалист поддержки', company: 'ООО Тест', email: 'hr@x.ru', messageId: '<our-1@local>' }],
  };
}

function clientWithReply() {
  let opened = null;
  return {
    connect: async () => {},
    logout: async () => {},
    mailboxOpen: async (folder) => {
      if (folder !== 'INBOX') throw new Error('нет папки');
      opened = folder;
      return { exists: 1 };
    },
    fetch: async function* () {
      yield {
        seq: 1,
        headers: Buffer.from('In-Reply-To: <our-1@local>'),
        envelope: { messageId: '<their@corp>', subject: 'Re: Отклик', date: new Date(), from: [{ address: 'hr@x.ru', name: 'Мария' }] },
      };
    },
  };
}

async function tempPath() {
  return join(await mkdtemp(join(tmpdir(), 'replies-')), 's.json');
}

test('найденный ответ приходит в чат и запоминается', async () => {
  const telegram = await fakeTelegram();
  const path = await tempPath();
  const state = stateWithApplication();

  try {
    const { found } = await checkReplies(state, path, telegram.credentials, {
      makeClient: clientWithReply, log: () => {},
    });

    assert.equal(found, 1);
    assert.match(telegram.sent[0].text, /Ответ на ваш отклик/);
    const saved = await loadState(path);
    assert.deepEqual(saved.seenReplies, ['<their@corp>']);
  } finally {
    await telegram.close();
  }
});

test('второй прогон не присылает тот же ответ снова', async () => {
  const telegram = await fakeTelegram();
  const path = await tempPath();
  const state = stateWithApplication();

  try {
    await checkReplies(state, path, telegram.credentials, { makeClient: clientWithReply, log: () => {} });
    const second = await checkReplies(await loadState(path), path, telegram.credentials, {
      makeClient: clientWithReply, log: () => {},
    });

    assert.equal(second.found, 0);
    assert.equal(telegram.sent.length, 1, 'одно письмо — одно уведомление');
  } finally {
    await telegram.close();
  }
});

test('сбой почты не роняет прогон', async () => {
  const telegram = await fakeTelegram();
  const failing = () => ({
    connect: async () => { throw new Error('IMAP недоступен'); },
    logout: async () => {},
  });

  try {
    const { found, error } = await checkReplies(stateWithApplication(), await tempPath(), telegram.credentials, {
      makeClient: failing, log: () => {},
    });
    assert.equal(found, 0);
    assert.ok(error, 'ошибка возвращается, а не выбрасывается');
  } finally {
    await telegram.close();
  }
});

test('без настроенной почты проверка молча пропускается', async () => {
  const telegram = await fakeTelegram();
  try {
    const { found, error } = await checkReplies(stateWithApplication(), await tempPath(), telegram.credentials, {
      makeClient: () => { throw new Error('Не заданы SMTP_USER или SMTP_PASSWORD'); },
      log: () => {},
    });
    assert.equal(found, 0);
    assert.equal(error, null, 'ненастроенная почта — не сбой');
    assert.equal(telegram.sent.length, 0);
  } finally {
    await telegram.close();
  }
});

test('без откликов почта не проверяется', async () => {
  const telegram = await fakeTelegram();
  let called = false;
  try {
    const { found } = await checkReplies(
      { sentLog: [], seenReplies: [] },
      await tempPath(),
      telegram.credentials,
      { makeClient: () => { called = true; return clientWithReply(); }, log: () => {} },
    );
    assert.equal(found, 0);
    assert.equal(called, false, 'соединение не открывалось');
  } finally {
    await telegram.close();
  }
});
