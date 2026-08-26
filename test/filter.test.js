import { test } from 'node:test';
import assert from 'node:assert/strict';

import { matchesFilters, selectNew } from '../src/filter.js';

const now = new Date().toISOString();

function vacancy(overrides = {}) {
  return {
    id: 'v1',
    title: 'Python разработчик',
    company: 'ООО Тест',
    region: 'Москва',
    url: 'https://example.com/1',
    salaryMin: 150000,
    salaryMax: 0,
    schedule: 'Полный день',
    experienceYears: 3,
    description: 'Разработка сервисов',
    createdAt: now,
    modifiedAt: now,
    ...overrides,
  };
}

test('пропускает вакансию, проходящую все правила', () => {
  assert.equal(matchesFilters(vacancy(), { minSalary: 100000 }), true);
});

test('отбрасывает вакансию с зарплатой ниже порога', () => {
  assert.equal(matchesFilters(vacancy({ salaryMin: 50000 }), { minSalary: 100000 }), false);
});

test('вакансия без зарплаты проходит, пока requireSalary не включён', () => {
  const noSalary = vacancy({ salaryMin: 0, salaryMax: 0 });
  assert.equal(matchesFilters(noSalary, { minSalary: 100000 }), true);
  assert.equal(matchesFilters(noSalary, { minSalary: 100000, requireSalary: true }), false);
});

test('порог сверяется по верхней границе вилки', () => {
  const wideRange = vacancy({ salaryMin: 60000, salaryMax: 200000 });
  assert.equal(matchesFilters(wideRange, { minSalary: 100000 }), true);
});

test('стоп-слова ищутся и в заголовке, и в описании, без учёта регистра', () => {
  const filters = { excludeKeywords: ['вахта'] };
  assert.equal(matchesFilters(vacancy({ title: 'Слесарь ВАХТА' }), filters), false);
  assert.equal(matchesFilters(vacancy({ description: 'работа вахтой' }), filters), true);
  assert.equal(matchesFilters(vacancy({ description: 'график: вахта 30/30' }), filters), false);
});

test('отбрасывает вакансии старше maxAgeDays', () => {
  const old = vacancy({ modifiedAt: new Date(Date.now() - 10 * 86_400_000).toISOString() });
  assert.equal(matchesFilters(old, { maxAgeDays: 3 }), false);
  assert.equal(matchesFilters(old, { maxAgeDays: 30 }), true);
});

test('битую дату не считает свежей', () => {
  assert.equal(matchesFilters(vacancy({ modifiedAt: 'не дата', createdAt: '' }), { maxAgeDays: 3 }), false);
});

test('selectNew убирает дубли внутри выдачи', () => {
  const items = [vacancy({ id: 'a' }), vacancy({ id: 'a' }), vacancy({ id: 'b' })];
  const result = selectNew(items, new Set(), {});
  assert.deepEqual(result.map((v) => v.id), ['a', 'b']);
});

test('selectNew не возвращает уже отправленные вакансии', () => {
  const items = [vacancy({ id: 'a' }), vacancy({ id: 'b' })];
  const result = selectNew(items, new Set(['a']), {});
  assert.deepEqual(result.map((v) => v.id), ['b']);
});

test('selectNew соблюдает лимит и сортирует свежие вперёд', () => {
  const older = vacancy({ id: 'old', modifiedAt: new Date(Date.now() - 2 * 86_400_000).toISOString() });
  const newer = vacancy({ id: 'new', modifiedAt: now });
  const result = selectNew([older, newer], new Set(), {}, 1);
  assert.deepEqual(result.map((v) => v.id), ['new']);
});

test('при равной дате выше идёт вакансия с большей вилкой', () => {
  const low = vacancy({ id: 'low', salaryMin: 100000 });
  const high = vacancy({ id: 'high', salaryMin: 300000 });
  const result = selectNew([low, high], new Set(), {});
  assert.deepEqual(result.map((v) => v.id), ['high', 'low']);
});

test('вакансии без id игнорируются', () => {
  const result = selectNew([vacancy({ id: undefined }), vacancy({ id: 'ok' })], new Set(), {});
  assert.deepEqual(result.map((v) => v.id), ['ok']);
});
