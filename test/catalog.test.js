import { test } from 'node:test';
import assert from 'node:assert/strict';

import { registerVacancies, findByCode, pruneCatalog, normalizeCode } from '../src/catalog.js';

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

test('переполненный каталог переиспользует самую давнюю запись', () => {
  const catalog = {};
  const old = new Date(Date.now() - 20 * 86_400_000);
  // 24 буквы по 9 цифр = 216 кодов
  registerVacancies(catalog, Array.from({ length: 216 }, (_, i) => vacancy(`id-${i}`)), old);
  const [overflow] = registerVacancies(catalog, [vacancy('overflow')]);
  assert.ok(overflow.code, 'код всё равно выдан');
  assert.equal(catalog[overflow.code].id, 'overflow');
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
