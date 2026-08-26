import { test } from 'node:test';
import assert from 'node:assert/strict';

import { planQueries, sourceNames, sourceLabel, SOURCES } from '../src/sources/index.js';

test('в реестре оба источника', () => {
  assert.deepEqual(sourceNames().sort(), ['habr', 'trudvsem']);
});

test('у источников есть человеческие названия', () => {
  assert.equal(sourceLabel('trudvsem'), 'Работа в России');
  assert.equal(sourceLabel('habr'), 'Хабр Карьера');
});

test('неизвестный источник возвращается как есть', () => {
  assert.equal(sourceLabel('нечто'), 'нечто');
});

test('помечено, какие источники дают адрес для отклика', () => {
  assert.equal(SOURCES.trudvsem.supportsEmail, true);
  assert.equal(SOURCES.habr.supportsEmail, false, 'в RSS Хабра контактов нет');
});

test('каждый запрос раскрывается во все включённые источники', () => {
  const tasks = planQueries([{ text: 'поддержка' }], ['trudvsem', 'habr']);
  assert.equal(tasks.length, 2);
  assert.deepEqual(tasks.map((t) => t.source), ['trudvsem', 'habr']);
});

test('два запроса и два источника дают четыре задачи', () => {
  const tasks = planQueries([{ text: 'a' }, { text: 'b' }], ['trudvsem', 'habr']);
  assert.equal(tasks.length, 4);
});

test('запрос может задать свои источники', () => {
  // Например, региональный код имеет смысл только для trudvsem.
  const tasks = planQueries(
    [{ text: 'поддержка', region: '7700000000', sources: ['trudvsem'] }, { text: 'python' }],
    ['trudvsem', 'habr'],
  );
  assert.deepEqual(tasks.map((t) => t.source), ['trudvsem', 'trudvsem', 'habr']);
});

test('неизвестные источники отбрасываются', () => {
  const tasks = planQueries([{ text: 'поддержка' }], ['trudvsem', 'выдуманный']);
  assert.deepEqual(tasks.map((t) => t.source), ['trudvsem']);
});

test('без источников задач нет', () => {
  assert.deepEqual(planQueries([{ text: 'поддержка' }], []), []);
});

test('без запросов задач нет', () => {
  assert.deepEqual(planQueries([], ['trudvsem']), []);
});
