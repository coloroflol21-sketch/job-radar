import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getUpdates, confirmUpdates, extractCommands, lastUpdateId } from '../src/telegram.js';

function update(id, { chatId = 100, text = '/list' } = {}) {
  return { update_id: id, message: { chat: { id: chatId }, text, from: { username: 'me' } } };
}

test('getUpdates запрашивает только сообщения и передаёт offset', async () => {
  let requested;
  const fetchImpl = async (url) => {
    requested = url;
    return { json: async () => ({ ok: true, result: [update(1)] }) };
  };

  const updates = await getUpdates({ token: 'T', offset: 5, fetchImpl });

  assert.equal(updates.length, 1);
  assert.match(requested, /\/botT\/getUpdates\?/);
  assert.match(requested, /offset=5/);
  assert.match(requested, /allowed_updates=%5B%22message%22%5D/);
});

test('getUpdates сообщает об ошибке Telegram', async () => {
  const fetchImpl = async () => ({ json: async () => ({ ok: false, description: 'Unauthorized' }) });
  await assert.rejects(() => getUpdates({ token: 'bad', fetchImpl }), /Unauthorized/);
});

test('getUpdates требует токен', async () => {
  await assert.rejects(() => getUpdates({}), /TELEGRAM_BOT_TOKEN/);
});

test('пустая выдача не ломается', async () => {
  const fetchImpl = async () => ({ json: async () => ({ ok: true }) });
  assert.deepEqual(await getUpdates({ token: 'T', fetchImpl }), []);
});

test('берёт сообщения только из своего чата', async () => {
  const updates = [
    update(1, { chatId: 100, text: '/list' }),
    update(2, { chatId: 999, text: '/apply A1\nвредный текст' }),
  ];
  const commands = extractCommands(updates, 100);

  assert.equal(commands.length, 1, 'чужое сообщение отброшено');
  assert.equal(commands[0].text, '/list');
});

test('chat_id сравнивается как строка: Telegram отдаёт число, секрет приходит текстом', () => {
  const commands = extractCommands([update(1, { chatId: 100 })], '100');
  assert.equal(commands.length, 1);
});

test('сообщения без текста игнорируются', () => {
  const updates = [
    { update_id: 1, message: { chat: { id: 100 }, photo: [{}] } },
    { update_id: 2, edited_message: { chat: { id: 100 }, text: '/list' } },
  ];
  assert.deepEqual(extractCommands(updates, 100), []);
});

test('lastUpdateId находит максимальный номер', () => {
  assert.equal(lastUpdateId([update(5), update(12), update(7)]), 12);
  assert.equal(lastUpdateId([]), 0);
});

test('confirmUpdates подтверждает обработку смещением выше последнего id', async () => {
  let requested;
  const fetchImpl = async (url) => {
    requested = url;
    return { json: async () => ({ ok: true, result: [] }) };
  };

  await confirmUpdates({ token: 'T', lastUpdateId: 42, fetchImpl });
  assert.match(requested, /offset=43/);
});

test('confirmUpdates без апдейтов не делает запросов', async () => {
  let called = false;
  const fetchImpl = async () => {
    called = true;
    return { json: async () => ({ ok: true, result: [] }) };
  };

  await confirmUpdates({ token: 'T', lastUpdateId: 0, fetchImpl });
  assert.equal(called, false);
});
