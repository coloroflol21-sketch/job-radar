/**
 * Ответы работодателей связываются с откликом по заголовку In-Reply-To,
 * который ссылается на messageId нашего письма из журнала.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fetchReplies, formatReply, createClient } from '../src/mailbox.js';

const sentLog = [
  { code: 'A5', id: 'v1', title: 'Специалист поддержки', company: 'ООО Тест', email: 'hr@example.com', messageId: '<our-1@local>' },
  { code: 'B2', id: 'v2', title: 'Инженер поддержки', company: 'ООО Два', email: 'hr2@example.com', messageId: '<our-2@local>' },
];

/** Фейковый IMAP: отдаёт заданные письма, не открывая соединений. */
function stubClient(messagesByFolder, { failFolders = [] } = {}) {
  const opened = [];
  return {
    opened,
    connect: async () => {},
    logout: async () => {},
    mailboxOpen: async (folder) => {
      if (failFolders.includes(folder)) throw new Error('нет такой папки');
      opened.push(folder);
      return { exists: (messagesByFolder[folder] ?? []).length };
    },
    fetch: async function* (range, options) {
      const folder = opened.at(-1);
      for (const message of messagesByFolder[folder] ?? []) yield message;
    },
  };
}

function letter({ inReplyTo = '<our-1@local>', references = '', messageId = '<their-1@corp>', subject = 'Re: Отклик', from = 'hr@example.com', name = 'Мария' } = {}) {
  const headers = [inReplyTo && `In-Reply-To: ${inReplyTo}`, references && `References: ${references}`]
    .filter(Boolean)
    .join('\r\n');
  return {
    seq: 1,
    headers: Buffer.from(headers),
    envelope: { messageId, subject, date: new Date('2026-08-27T10:00:00Z'), from: [{ address: from, name }] },
  };
}

test('ответ связывается с откликом по In-Reply-To', async () => {
  const client = stubClient({ INBOX: [letter()] });
  const replies = await fetchReplies(sentLog, { client });

  assert.equal(replies.length, 1);
  assert.equal(replies[0].code, 'A5', 'нашли нужную вакансию');
  assert.equal(replies[0].vacancyTitle, 'Специалист поддержки');
  assert.equal(replies[0].from, 'hr@example.com');
});

test('ответ находится и через заголовок References', async () => {
  // Некоторые клиенты не ставят In-Reply-To, но цепочку в References сохраняют.
  const client = stubClient({ INBOX: [letter({ inReplyTo: '', references: '<x@y> <our-2@local>' })] });
  const replies = await fetchReplies(sentLog, { client });

  assert.equal(replies.length, 1);
  assert.equal(replies[0].code, 'B2');
});

test('чужие письма игнорируются', async () => {
  const client = stubClient({ INBOX: [letter({ inReplyTo: '<кто-то-другой@mail>' })] });
  assert.deepEqual(await fetchReplies(sentLog, { client }), []);
});

test('письмо без заголовков ответа игнорируется', async () => {
  const client = stubClient({ INBOX: [letter({ inReplyTo: '', references: '' })] });
  assert.deepEqual(await fetchReplies(sentLog, { client }), []);
});

test('уже показанный ответ не присылается повторно', async () => {
  const client = stubClient({ INBOX: [letter({ messageId: '<their-1@corp>' })] });
  const replies = await fetchReplies(sentLog, { client, seenIds: ['<their-1@corp>'] });
  assert.deepEqual(replies, [], 'иначе одно письмо приходило бы каждый прогон');
});

test('спам проверяется тоже и помечается', async () => {
  const client = stubClient({ INBOX: [], '[Gmail]/Spam': [letter()] });
  const replies = await fetchReplies(sentLog, { client });

  assert.equal(replies.length, 1);
  assert.equal(replies[0].folder, '[Gmail]/Spam');
  assert.match(formatReply(replies[0]), /лежит в спаме/);
});

test('отсутствие папки спама не ошибка', async () => {
  const client = stubClient({ INBOX: [letter()] }, { failFolders: ['[Gmail]/Spam'] });
  const replies = await fetchReplies(sentLog, { client });
  assert.equal(replies.length, 1, 'INBOX обработан, спам просто пропущен');
});

test('без откликов почта не читается', async () => {
  let connected = false;
  const client = { connect: async () => { connected = true; }, logout: async () => {} };
  assert.deepEqual(await fetchReplies([], { client }), []);
  assert.equal(connected, false, 'отвечать некому — соединение незачем');
});

test('отклик без messageId не мешает поиску', async () => {
  const broken = [{ code: 'C1', title: 'Без id', company: 'X', messageId: undefined }, ...sentLog];
  const client = stubClient({ INBOX: [letter()] });
  const replies = await fetchReplies(broken, { client });
  assert.equal(replies.length, 1);
});

test('сообщение в чат содержит вакансию, отправителя и тему', () => {
  const text = formatReply({
    id: '<x>', code: 'A5', vacancyTitle: 'Специалист поддержки', company: 'ООО Тест',
    from: 'hr@example.com', fromName: 'Мария', subject: 'Re: Отклик', date: new Date().toISOString(), folder: 'INBOX',
  });
  assert.match(text, /Ответ на ваш отклик/);
  assert.match(text, /Специалист поддержки/);
  assert.match(text, /A5/);
  assert.match(text, /Мария/);
  assert.doesNotMatch(text, /лежит в спаме/);
});

test('HTML в письме экранируется', () => {
  const text = formatReply({
    id: '<x>', code: 'A5', vacancyTitle: 'Тест', company: 'X',
    from: 'a@b', fromName: 'ООО <b>Х</b>', subject: '<script>', date: new Date().toISOString(), folder: 'INBOX',
  });
  assert.match(text, /&lt;b&gt;/);
  assert.match(text, /&lt;script&gt;/);
});

test('createClient требует те же настройки, что и отправка', () => {
  assert.throws(() => createClient({}), /SMTP_USER/);
  const client = createClient({ SMTP_USER: 'a@b', SMTP_PASSWORD: 'x' }, {
    ClientImpl: class { constructor(options) { this.options = options; } },
  });
  assert.equal(client.options.host, 'imap.gmail.com');
  assert.equal(client.options.port, 993);
});
