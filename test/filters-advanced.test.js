import { test } from 'node:test';
import assert from 'node:assert/strict';

import { matchesFilters, matchesTitle, isRemote } from '../src/filter.js';

const now = new Date().toISOString();

function vacancy(overrides = {}) {
  return {
    id: 'v1',
    title: 'Специалист технической поддержки',
    company: 'ООО Тест',
    region: 'Москва',
    url: 'https://example.com/1',
    salaryMin: 150000,
    salaryMax: 0,
    schedule: 'Полный рабочий день',
    employment: '',
    experienceYears: 1,
    description: 'Консультирование пользователей',
    createdAt: now,
    modifiedAt: now,
    ...overrides,
  };
}

test('ключевые слова ищутся в названии без учёта регистра', () => {
  assert.equal(matchesTitle(vacancy(), ['поддержк']), true);
  assert.equal(matchesTitle(vacancy(), ['ПОДДЕРЖК']), true);
  assert.equal(matchesTitle(vacancy({ title: 'Python разработчик' }), ['поддержк']), false);
});

test('пустой список ключевых слов пропускает всё', () => {
  assert.equal(matchesTitle(vacancy({ title: 'Дворник' }), []), true);
});

test('совпадение по любому из ключевых слов', () => {
  const keywords = ['поддержк', 'helpdesk', 'сопровождени'];
  assert.equal(matchesTitle(vacancy({ title: 'Инженер Helpdesk' }), keywords), true);
  assert.equal(matchesTitle(vacancy({ title: 'Специалист сопровождения' }), keywords), true);
  assert.equal(matchesTitle(vacancy({ title: 'Бухгалтер' }), keywords), false);
});

test('ключевые слова не ищутся в описании', () => {
  // Иначе слово «поддержка» из текста любой вакансии ломало бы отбор.
  const v = vacancy({ title: 'Грузчик', description: 'поддержка склада в порядке' });
  assert.equal(matchesTitle(v, ['поддержк']), false);
});

test('удалёнка определяется по полю employment', () => {
  assert.equal(isRemote(vacancy({ employment: 'Дистанционная (удаленная) работа' })), true);
  assert.equal(isRemote(vacancy({ employment: 'Полная занятость' })), false);
});

test('удалёнка находится в названии и описании, когда employment пустой', () => {
  assert.equal(isRemote(vacancy({ title: 'Оператор (удалённо)' })), true);
  assert.equal(isRemote(vacancy({ description: 'работа дистанционно из любого города' })), true);
  assert.equal(isRemote(vacancy({ description: 'офис в центре' })), false);
});

test('фильтр по опыту отсекает вакансии выше порога', () => {
  const filters = { maxExperienceYears: 1 };
  assert.equal(matchesFilters(vacancy({ experienceYears: 0 }), filters), true);
  assert.equal(matchesFilters(vacancy({ experienceYears: 1 }), filters), true);
  assert.equal(matchesFilters(vacancy({ experienceYears: 3 }), filters), false);
});

test('без порога опыта проходят любые вакансии', () => {
  assert.equal(matchesFilters(vacancy({ experienceYears: 10 }), {}), true);
  assert.equal(matchesFilters(vacancy({ experienceYears: 10 }), { maxExperienceYears: null }), true);
});

test('remoteOnly оставляет только удалённые', () => {
  const filters = { remoteOnly: true };
  assert.equal(matchesFilters(vacancy({ employment: 'Дистанционная (удаленная) работа' }), filters), true);
  assert.equal(matchesFilters(vacancy({ title: 'Оператор удалённо' }), filters), true);
  assert.equal(matchesFilters(vacancy(), filters), false);
});

test('фильтр по графику сверяется по подстроке', () => {
  // В данных графики записаны длинно: «Неполный рабочий день/неполная рабочая неделя».
  const flexible = vacancy({ schedule: 'Режим гибкого рабочего времени' });
  assert.equal(matchesFilters(flexible, { schedules: ['гибк'] }), true);
  assert.equal(matchesFilters(flexible, { schedules: ['сменная'] }), false);
  assert.equal(matchesFilters(vacancy(), { schedules: ['полный'] }), true);
});

test('пустой список графиков пропускает любой', () => {
  assert.equal(matchesFilters(vacancy({ schedule: 'Вахтовый метод' }), { schedules: [] }), true);
});

test('несколько допустимых графиков — совпадение по любому', () => {
  const filters = { schedules: ['гибк', 'неполный'] };
  assert.equal(matchesFilters(vacancy({ schedule: 'Режим гибкого рабочего времени' }), filters), true);
  assert.equal(matchesFilters(vacancy({ schedule: 'Неполный рабочий день' }), filters), true);
  assert.equal(matchesFilters(vacancy({ schedule: 'Сменная работа' }), filters), false);
});

test('все фильтры применяются вместе', () => {
  const filters = {
    minSalary: 100000,
    titleKeywords: ['поддержк'],
    maxExperienceYears: 2,
    remoteOnly: true,
    schedules: ['полный'],
  };
  const good = vacancy({
    title: 'Специалист поддержки (удалённо)',
    salaryMin: 150000,
    experienceYears: 1,
    schedule: 'Полный рабочий день',
  });
  assert.equal(matchesFilters(good, filters), true);
  assert.equal(matchesFilters({ ...good, experienceYears: 5 }, filters), false, 'опыт');
  assert.equal(matchesFilters({ ...good, title: 'Специалист поддержки' }, filters), false, 'не удалёнка');
  assert.equal(matchesFilters({ ...good, salaryMin: 50000 }, filters), false, 'зарплата');
});
