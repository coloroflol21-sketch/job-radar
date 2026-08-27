/**
 * Ограничение частоты Telegram. Дайджест карточками — 13 сообщений подряд,
 * а в один чат проходит примерно одно в секунду. Без повторов часть вакансий
 * не доходила бы, а помечалась отправленной.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { sendMessage, sendVacancyCards } from '../src/telegram.js';

function vacancy(code) {
  return {
    code,
    title: `Вакансия ${code}`,
    company: 'ООО Тест',
    email: 'hr@example.com',
    url: 'https://example.com/1',
    salaryMin: 100000,
    salaryMax: 0,
  };
}

/** Считает вызовы и умеет отвечать 429 заданное число раз. */
function stubTelegram({ rateLimitTimes = 0, failAfter = Infinity } = {}) {
  const calls = [];
  let limited = 0;
  return {
    calls,
    fetchImpl: async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push(body);
      if (limited < rateLimitTimes) {
        limited += 1;
        return { json: async () => ({ ok: false, description: 'Too Many Requests', parameters: { retry_after: 2 } }) };
      }
      if (calls.length > failAfter) {
        return { json: async () => ({ ok: false, description: 'Bad Request: chat not found' }) };
      }
      return { json: async () => ({ ok: true, result: { message_id: calls.length } }) };
    },
  };
}

test('после 429 сообщение отправляется повторно', async () => {
  const telegram = stubTelegram({ rateLimitTimes: 1 });
  const waited = [];

  const result = await sendMessage('привет', {
    token: 'T',
    chatId: '1',
    fetchImpl: telegram.fetchImpl,
    sleep: async (ms) => waited.push(ms),
  });

  assert.equal(result.ok, true);
  assert.equal(telegram.calls.length, 2, 'была вторая попытка');
  assert.deepEqual(waited, [3000], 'ждём retry_after + 1 секунда');
});

test('повторы не бесконечны', async () => {
  const telegram = stubTelegram({ rateLimitTimes: 99 });
  await assert.rejects(
    () => sendMessage('привет', { token: 'T', chatId: '1', fetchImpl: telegram.fetchImpl, sleep: async () => {} }),
    /Too Many Requests/,
  );
  assert.ok(telegram.calls.length <= 4, `попыток ${telegram.calls.length}, ожидалось не больше 4`);
});

test('обычная ошибка не повторяется: повтор её не исправит', async () => {
  const telegram = stubTelegram({ failAfter: 0 });
  await assert.rejects(
    () => sendMessage('привет', { token: 'T', chatId: 'bad', fetchImpl: telegram.fetchImpl, sleep: async () => {} }),
    /chat not found/,
  );
  assert.equal(telegram.calls.length, 1);
});

test('карточки отправляются с паузами между сообщениями', async () => {
  const telegram = stubTelegram();
  const waited = [];
  const vacancies = [vacancy('A1'), vacancy('A2'), vacancy('A3')];

  const { delivered, error } = await sendVacancyCards(vacancies, {
    token: 'T',
    chatId: '1',
    fetchImpl: telegram.fetchImpl,
  }, { sleep: async (ms) => waited.push(ms) });

  assert.equal(delivered.length, 3);
  assert.equal(error, null);
  assert.equal(telegram.calls.length, 4, 'заголовок плюс три карточки');
  // Паузы между карточками, но не после последней.
  assert.equal(waited.length, 2, `пауз ${waited.length}`);
  assert.ok(waited.every((ms) => ms >= 1000), 'пауза не меньше секунды');
});

test('у каждой карточки свои кнопки', async () => {
  const telegram = stubTelegram();
  await sendVacancyCards([vacancy('A1'), vacancy('A2')], {
    token: 'T',
    chatId: '1',
    fetchImpl: telegram.fetchImpl,
  }, { sleep: async () => {} });

  const cards = telegram.calls.slice(1);
  assert.match(JSON.stringify(cards[0].reply_markup), /act:apply:A1/);
  assert.match(JSON.stringify(cards[1].reply_markup), /act:apply:A2/);
});

test('обрыв на середине возвращает только дошедшие', async () => {
  // Третий вызов (вторая карточка) падает неисправимой ошибкой.
  const telegram = stubTelegram({ failAfter: 2 });
  const vacancies = [vacancy('A1'), vacancy('A2'), vacancy('A3')];

  const { delivered, error } = await sendVacancyCards(vacancies, {
    token: 'T',
    chatId: '1',
    fetchImpl: telegram.fetchImpl,
  }, { sleep: async () => {} });

  assert.equal(delivered.length, 1, 'дошла только первая карточка');
  assert.equal(delivered[0].code, 'A1');
  assert.ok(error, 'сбой возвращается вызывающему');
});
