import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseCommand, validateApply } from '../src/commands.js';

test('распознаёт простые команды', () => {
  assert.equal(parseCommand('/help')?.type, 'help');
  assert.equal(parseCommand('/start')?.type, 'help');
  assert.equal(parseCommand('/list')?.type, 'list');
  assert.equal(parseCommand('/sent')?.type, 'sent');
});

test('обычный текст без слеша командой не считается', () => {
  assert.equal(parseCommand('привет'), null);
  assert.equal(parseCommand(''), null);
  assert.equal(parseCommand(undefined), null);
});

test('распознаёт /preview с кодом', () => {
  const command = parseCommand('/preview a1');
  assert.equal(command.type, 'preview');
  assert.equal(command.code, 'A1');
});

test('/apply берёт код из первой строки, а письмо со второй', () => {
  const command = parseCommand('/apply B3\nЗдравствуйте!\n\nМеня заинтересовала вакансия.');
  assert.equal(command.type, 'apply');
  assert.equal(command.code, 'B3');
  assert.equal(command.body, 'Здравствуйте!\n\nМеня заинтересовала вакансия.');
});

test('/apply без письма даёт пустое тело', () => {
  const command = parseCommand('/apply B3');
  assert.equal(command.code, 'B3');
  assert.equal(command.body, '');
});

test('игнорирует приписку с именем бота', () => {
  assert.equal(parseCommand('/list@job_radar_bot')?.type, 'list');
});

test('неизвестная команда помечается как unknown', () => {
  const command = parseCommand('/qwerty');
  assert.equal(command.type, 'unknown');
  assert.equal(command.name, 'qwerty');
});

const entry = { id: 'a', title: 'Разработчик', email: 'hr@example.com', url: 'https://example.com' };
const goodBody = 'Здравствуйте! Заинтересовала ваша вакансия, готов обсудить детали.';

test('корректный отклик проходит проверку', () => {
  const result = validateApply({ code: 'A1', body: goodBody }, entry, []);
  assert.equal(result.ok, true);
});

test('отклик без кода отклоняется', () => {
  const result = validateApply({ code: '', body: goodBody }, null, []);
  assert.equal(result.ok, false);
  assert.match(result.reason, /Не указан код/);
});

test('отклик на несуществующий код отклоняется', () => {
  const result = validateApply({ code: 'Z9', body: goodBody }, null, []);
  assert.equal(result.ok, false);
  assert.match(result.reason, /не найдена/);
});

test('вакансия без email отклоняется со ссылкой на сайт', () => {
  const result = validateApply({ code: 'A1', body: goodBody }, { ...entry, email: '' }, []);
  assert.equal(result.ok, false);
  assert.match(result.reason, /не указан email/);
  assert.match(result.reason, /example\.com/);
});

test('пустое письмо отклоняется', () => {
  const result = validateApply({ code: 'A1', body: '' }, entry, []);
  assert.equal(result.ok, false);
  assert.match(result.reason, /пустое/);
});

test('слишком короткое письмо отклоняется как похожее на спам', () => {
  const result = validateApply({ code: 'A1', body: 'Хочу работать' }, entry, []);
  assert.equal(result.ok, false);
  assert.match(result.reason, /спам/);
});

test('повторный отклик на ту же вакансию отклоняется', () => {
  const sentLog = [{ code: 'A1', sentAt: new Date().toISOString() }];
  const result = validateApply({ code: 'A1', body: goodBody }, entry, sentLog);
  assert.equal(result.ok, false);
  assert.match(result.reason, /уже отправлен/);
});
