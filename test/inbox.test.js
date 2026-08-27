import { test } from 'node:test';
import assert from 'node:assert/strict';

import { getUpdates, confirmUpdates, extractCommands, extractCallbacks, lastUpdateId } from '../src/telegram.js';

function update(id, { chatId = 100, text = '/list' } = {}) {
  return { update_id: id, message: { chat: { id: chatId }, text, from: { username: 'me' } } };
}

test('getUpdates подписан на сообщения и нажатия кнопок, передаёт offset', async () => {
  let requested;
  const fetchImpl = async (url) => {
    requested = url;
    return { json: async () => ({ ok: true, result: [update(1)] }) };
  };

  const updates = await getUpdates({ token: 'T', offset: 5, fetchImpl });

  assert.equal(updates.length, 1);
  assert.match(requested, /\/botT\/getUpdates\?/);
  assert.match(requested, /offset=5/);
  // Без callback_query нажатия кнопок меню не дошли бы до бота.
  assert.match(requested, /message/);
  assert.match(requested, /callback_query/);
});

test('длинный опрос передаёт таймаут', async () => {
  let requested;
  const fetchImpl = async (url) => {
    requested = url;
    return { json: async () => ({ ok: true, result: [] }) };
  };

  await getUpdates({ token: 'T', timeout: 30, fetchImpl });
  assert.match(requested, /timeout=30/);
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

function callbackUpdate(id, { chatId = 100, data = 'open:main', messageId = 7 } = {}) {
  return {
    update_id: id,
    callback_query: { id: `cb-${id}`, data, message: { message_id: messageId, chat: { id: chatId } } },
  };
}

test('нажатия кнопок извлекаются с id сообщения для перерисовки', () => {
  const callbacks = extractCallbacks([callbackUpdate(1, { data: 'set:salary:2' })], 100);
  assert.equal(callbacks.length, 1);
  assert.equal(callbacks[0].data, 'set:salary:2');
  assert.equal(callbacks[0].messageId, 7);
  assert.equal(callbacks[0].id, 'cb-1');
});

test('нажатие из чужого чата отбрасывается', () => {
  // Сообщение с кнопками можно переслать: нажать сможет посторонний.
  const callbacks = extractCallbacks([callbackUpdate(1, { chatId: 999 })], 100);
  assert.deepEqual(callbacks, []);
});

test('нажатия и команды разбираются из одной выдачи независимо', () => {
  const updates = [update(1, { text: '/list' }), callbackUpdate(2, { data: 'open:salary' })];
  assert.equal(extractCommands(updates, 100).length, 1);
  assert.equal(extractCallbacks(updates, 100).length, 1);
});

test('callback без данных игнорируется', () => {
  const broken = { update_id: 1, callback_query: { id: 'x', message: { message_id: 1, chat: { id: 100 } } } };
  assert.deepEqual(extractCallbacks([broken], 100), []);
});

test('lastUpdateId учитывает и нажатия', () => {
  assert.equal(lastUpdateId([update(3), callbackUpdate(9)]), 9);
});
