/**
 * Ожидания с ограниченным сроком. Без срока сообщение «спасибо, посмотрю позже»,
 * написанное через час после нажатия «Откликнуться», уходило работодателю письмом.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  takeAwaitingLetter,
  takePendingApply,
  expiredLetterText,
  expiredConfirmText,
  LETTER_TTL_MINUTES,
  CONFIRM_TTL_MINUTES,
} from '../src/pending.js';

const now = new Date('2026-08-27T12:00:00Z');
const minutesAgo = (n) => new Date(now.getTime() - n * 60_000).toISOString();

test('свежее ожидание письма принимается', () => {
  const state = { awaitingLetter: { code: 'A1', askedAt: minutesAgo(2) } };
  const result = takeAwaitingLetter(state, now);
  assert.equal(result.expired, false);
  assert.equal(result.code, 'A1');
});

test('просроченное ожидание НЕ становится письмом', () => {
  const state = { awaitingLetter: { code: 'A1', askedAt: minutesAgo(60) } };
  const result = takeAwaitingLetter(state, now);
  assert.equal(result.expired, true, 'иначе случайный текст ушёл бы работодателю');
  assert.equal(result.code, 'A1');
});

test('граница срока: на минуту раньше принимается, на минуту позже нет', () => {
  const fresh = { awaitingLetter: { code: 'A1', askedAt: minutesAgo(LETTER_TTL_MINUTES - 1) } };
  assert.equal(takeAwaitingLetter(fresh, now).expired, false);

  const stale = { awaitingLetter: { code: 'A1', askedAt: minutesAgo(LETTER_TTL_MINUTES + 1) } };
  assert.equal(takeAwaitingLetter(stale, now).expired, true);
});

test('ожидание снимается в любом случае — второй текст письмом не станет', () => {
  const state = { awaitingLetter: { code: 'A1', askedAt: minutesAgo(1) } };
  takeAwaitingLetter(state, now);
  assert.equal(state.awaitingLetter, null);
  assert.equal(takeAwaitingLetter(state, now), null);
});

test('битая дата считается просроченной', () => {
  const state = { awaitingLetter: { code: 'A1', askedAt: 'не дата' } };
  assert.equal(takeAwaitingLetter(state, now).expired, true, 'при сомнении не отправляем');
});

test('без ожидания возвращается null', () => {
  assert.equal(takeAwaitingLetter({}, now), null);
});

test('свежее подтверждение принимается', () => {
  const state = { pendingApply: { code: 'A1', body: 'текст', preparedAt: minutesAgo(1) } };
  const result = takePendingApply(state, 'A1', now);
  assert.equal(result.pending.body, 'текст');
});

test('устаревшее подтверждение не исполняется', () => {
  const state = { pendingApply: { code: 'A1', body: 'текст', preparedAt: minutesAgo(CONFIRM_TTL_MINUTES + 5) } };
  assert.equal(takePendingApply(state, 'A1', now).expired, true);
});

test('подтверждение чужого кода отклоняется', () => {
  const state = { pendingApply: { code: 'A1', body: 'текст', preparedAt: minutesAgo(1) } };
  assert.equal(takePendingApply(state, 'B2', now).missing, true);
});

test('подтверждение одноразовое', () => {
  const state = { pendingApply: { code: 'A1', body: 'текст', preparedAt: minutesAgo(1) } };
  takePendingApply(state, 'A1', now);
  assert.equal(takePendingApply(state, 'A1', now).missing, true);
});

test('сообщения об истечении объясняют, что делать', () => {
  const letter = expiredLetterText('A1');
  assert.match(letter, /Время на письмо истекло/);
  assert.match(letter, /\/apply A1/);
  assert.match(letter, new RegExp(String(LETTER_TTL_MINUTES)));

  const confirm = expiredConfirmText('A1');
  assert.match(confirm, /устарело/);
  assert.match(confirm, /\/apply A1/);
});
