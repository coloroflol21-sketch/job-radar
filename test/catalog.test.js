import { test } from 'node:test';
import assert from 'node:assert/strict';

import { registerVacancies, findByCode, pruneCatalog, normalizeCode, codeForIndex } from '../src/catalog.js';

function vacancy(id, overrides = {}) {
  return {
    id,
    title: 'Python разработчик',
    company: 'ООО Тест',
    email: 'hr@example.com',
    url: `https://trudvsem.ru/vacancy/${id}`,
    contactPerson: 'Иванова Мария',
    ...overrides,
  };
}

test('присваивает каждой вакансии свой код по порядку', () => {
  const catalog = {};
  const result = registerVacancies(catalog, [vacancy('a'), vacancy('b'), vacancy('c')]);
  assert.deepEqual(result.map((v) => v.code), ['A1', 'A2', 'A3']);
});

test('коды уникальны на всём объёме каталога', () => {
  const catalog = {};
  const many = Array.from({ length: 50 }, (_, i) => vacancy(`id-${i}`));
  const codes = registerVacancies(catalog, many).map((v) => v.code);
  assert.equal(new Set(codes).size, 50);
});

test('после A9 переходит к B1', () => {
  const catalog = {};
  const codes = registerVacancies(catalog, Array.from({ length: 10 }, (_, i) => vacancy(`id-${i}`)))
    .map((v) => v.code);
  assert.equal(codes[8], 'A9');
  assert.equal(codes[9], 'B1');
});

test('код вакансии не меняется при повторной регистрации', () => {
  const catalog = {};
  const [first] = registerVacancies(catalog, [vacancy('a')]);
  registerVacancies(catalog, [vacancy('b'), vacancy('c')]);
  const [again] = registerVacancies(catalog, [vacancy('a')]);
  assert.equal(again.code, first.code, 'ссылка из старого сообщения должна остаться верной');
});

test('занятые коды не выдаются повторно', () => {
  const catalog = { A1: { id: 'old', addedAt: new Date().toISOString() } };
  const [result] = registerVacancies(catalog, [vacancy('new')]);
  assert.equal(result.code, 'A2');
});

test('в каталог попадают данные, нужные для отклика', () => {
  const catalog = {};
  registerVacancies(catalog, [vacancy('a')]);
  const entry = catalog.A1;
  assert.equal(entry.email, 'hr@example.com');
  assert.equal(entry.title, 'Python разработчик');
  assert.equal(entry.contactPerson, 'Иванова Мария');
  assert.ok(entry.addedAt);
});

test('код НИКОГДА не достаётся другой вакансии', () => {
  // Раньше кодов было 216 и они переиспользовались: ответ /apply на старое
  // сообщение отправлял письмо не тому работодателю.
  const catalog = {};
  const counter = {};
  const codes = [];

  for (let batch = 0; batch < 50; batch += 1) {
    const vacancies = Array.from({ length: 12 }, (_, i) => vacancy(`id-${batch * 12 + i}`));
    codes.push(...registerVacancies(catalog, vacancies, new Date(), counter).map((v) => v.code));
  }

  assert.equal(codes.length, 600);
  assert.equal(new Set(codes).size, 600, 'ни один код не повторился');
  assert.equal(findByCode(catalog, 'A1').id, 'id-0', 'A1 всё ещё первая вакансия');
});

test('после 216 кодов буквы удваиваются', () => {
  assert.equal(codeForIndex(0), 'A1');
  assert.equal(codeForIndex(215), 'Z9');
  assert.equal(codeForIndex(216), 'AA1');
  assert.equal(codeForIndex(1000), 'DR2');
});

test('счётчик кодов продолжается после чистки каталога', () => {
  const catalog = {};
  const counter = {};
  registerVacancies(catalog, [vacancy('a'), vacancy('b')], new Date(), counter);
  // Каталог опустошён по TTL, но счётчик помнит выданные номера.
  delete catalog.A1;
  delete catalog.A2;
  const [next] = registerVacancies(catalog, [vacancy('c')], new Date(), counter);
  assert.equal(next.code, 'A3', 'старые коды не выдаются заново');
});

test('в каталог попадают данные для показа описания', () => {
  const catalog = {};
  registerVacancies(catalog, [
    { ...vacancy('a'), region: 'Москва', salaryMin: 100000, schedule: 'Полный день', description: 'Текст', source: 'hh' },
  ]);
  const saved = catalog.A1;
  assert.equal(saved.region, 'Москва');
  assert.equal(saved.salaryMin, 100000);
  assert.equal(saved.description, 'Текст');
  assert.equal(saved.source, 'hh');
});

test('избранное и отклики не удаляются по TTL', () => {
  const old = new Date(Date.now() - 20 * 86_400_000).toISOString();
  const catalog = {
    A1: { id: 'saved', addedAt: old },
    A2: { id: 'applied', addedAt: old },
    A3: { id: 'plain', addedAt: old },
  };
  pruneCatalog(catalog, new Date(), { keepCodes: ['A1', 'A2'] });
  assert.deepEqual(Object.keys(catalog).sort(), ['A1', 'A2'], 'к избранному ещё вернутся');
});

test('findByCode нечувствителен к регистру и пробелам', () => {
  const catalog = {};
  registerVacancies(catalog, [vacancy('a')]);
  assert.equal(findByCode(catalog, 'a1')?.id, 'a');
  assert.equal(findByCode(catalog, ' A1 ')?.id, 'a');
  assert.equal(findByCode(catalog, 'Z9'), null);
});

test('normalizeCode убирает мусорные символы', () => {
  assert.equal(normalizeCode('a1'), 'A1');
  assert.equal(normalizeCode(' /a1. '), 'A1');
  assert.equal(normalizeCode(undefined), '');
});

test('pruneCatalog удаляет записи старше двух недель', () => {
  const catalog = {
    A1: { id: 'fresh', addedAt: new Date().toISOString() },
    A2: { id: 'old', addedAt: new Date(Date.now() - 20 * 86_400_000).toISOString() },
    A3: { id: 'broken', addedAt: 'не дата' },
  };
  pruneCatalog(catalog);
  assert.deepEqual(Object.keys(catalog), ['A1']);
});
