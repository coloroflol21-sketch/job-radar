import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderVacancy, renderSaved, renderStats, cleanDescription, daysListed } from '../src/views.js';

function entry(overrides = {}) {
  return {
    id: 'a',
    title: 'Специалист технической поддержки',
    company: 'ООО Тест',
    email: 'hr@example.com',
    url: 'https://example.com/1',
    region: 'Москва',
    salaryMin: 100000,
    salaryMax: 0,
    schedule: 'Полный рабочий день',
    employment: '',
    experienceYears: 1,
    description: 'Консультирование пользователей по телефону и в чате.',
    source: 'trudvsem',
    addedAt: new Date().toISOString(),
    ...overrides,
  };
}

test('описание вакансии содержит условия и текст', () => {
  const text = renderVacancy(entry(), 'A1');
  assert.match(text, /Специалист технической поддержки/);
  assert.match(text, /ООО Тест/);
  assert.match(text, /от 100\s000\s₽/);
  assert.match(text, /Консультирование пользователей/);
  assert.match(text, /\/apply A1/);
});

test('у вакансии без email предлагается отклик на сайте', () => {
  const text = renderVacancy(entry({ email: '' }), 'A1');
  assert.match(text, /только на сайте/);
  assert.doesNotMatch(text, /\/apply/);
});

test('долго висящая вакансия помечается', () => {
  const old = entry({ addedAt: new Date(Date.now() - 10 * 86_400_000).toISOString() });
  assert.match(renderVacancy(old, 'A1'), /висит 10 дней/);
  assert.doesNotMatch(renderVacancy(entry(), 'A1'), /висит/);
});

test('длинное описание обрезается', () => {
  const text = renderVacancy(entry({ description: 'а'.repeat(3000) }), 'A1');
  assert.ok(text.length <= 4096, `длина ${text.length}`);
  assert.match(text, /…/);
});

test('отсутствие описания объясняется', () => {
  assert.match(renderVacancy(entry({ description: '' }), 'A1'), /источник не отдал/);
});

test('для hh честно сказано, что описания в фиде нет', () => {
  // Проверено на живых данных: RSS поиска hh описание не отдаёт вообще.
  const text = renderVacancy(entry({ description: '', source: 'hh' }), 'A1');
  assert.match(text, /hh\.ru не отдаёт описание в фиде/);
});

test('служебные абзацы не съедают полезный текст', () => {
  // Шаблон «Регион:[^.]*\.» проглатывал описание до первой точки.
  const raw = '<p>Вакансия компании: X</p> <p>Регион: Москва</p> <p>Работа с обращениями. Первая линия.</p>';
  const text = renderVacancy(entry({ description: raw }), 'A1');
  assert.match(text, /Работа с обращениями/);
  assert.match(text, /Первая линия/);
});

test('HTML в данных экранируется', () => {
  const text = renderVacancy(entry({ company: 'ООО <b>Х</b>' }), 'A1');
  assert.match(text, /&lt;b&gt;/);
});

test('cleanDescription убирает разметку и служебные строки', () => {
  const raw = '<p>Вакансия компании: X</p> <p>Создана: 27.08.2026</p> <p>Регион: Москва</p> <p>Реальный текст.</p>';
  const clean = cleanDescription(raw);
  assert.match(clean, /Реальный текст/);
  assert.doesNotMatch(clean, /<p>/);
  assert.doesNotMatch(clean, /Создана/);
});

test('daysListed считает срок и терпит битую дату', () => {
  assert.equal(daysListed(entry({ addedAt: new Date(Date.now() - 3 * 86_400_000).toISOString() })), 3);
  assert.equal(daysListed(entry({ addedAt: 'не дата' })), null);
});

test('избранное показывает список, пустое — объясняет', () => {
  assert.match(renderSaved({}, []), /пусто/);
  const catalog = { A1: entry(), A2: entry({ title: 'Инженер' }) };
  const text = renderSaved(catalog, ['A1', 'A2']);
  assert.match(text, /Специалист/);
  assert.match(text, /Инженер/);
});

test('пропавшая из каталога запись не роняет избранное', () => {
  const text = renderSaved({ A1: entry() }, ['A1', 'Z9']);
  assert.match(text, /Специалист/);
});

test('сводка считает медиану, а не среднее', () => {
  // Одна вакансия за 900k не должна задирать картину.
  const catalog = {
    A1: entry({ salaryMin: 100000 }),
    A2: entry({ salaryMin: 120000 }),
    A3: entry({ salaryMin: 900000 }),
  };
  const text = renderStats(catalog);
  assert.match(text, /Медиана — 120\s000\s₽/);
});

test('сводка считает удалёнку, источники и свежесть', () => {
  const catalog = {
    A1: entry({ employment: 'Дистанционная (удаленная) работа', source: 'hh' }),
    A2: entry({ source: 'trudvsem' }),
    A3: entry({ source: 'hh', addedAt: new Date(Date.now() - 9 * 86_400_000).toISOString() }),
  };
  const text = renderStats(catalog);
  assert.match(text, /Удалённо: 1/);
  assert.match(text, /hh: 2/);
  assert.match(text, /Висят больше недели: 1/);
});

test('сводка предупреждает о вялом рынке', () => {
  const stale = new Date(Date.now() - 10 * 86_400_000).toISOString();
  const catalog = { A1: entry({ addedAt: stale }), A2: entry({ addedAt: stale }), A3: entry() };
  assert.match(renderStats(catalog), /рынок в вашей нише вялый/);
});

test('пустой каталог в сводке не ломается', () => {
  assert.match(renderStats({}), /Данных пока нет/);
});

test('сводка без зарплат не выдумывает медиану', () => {
  const catalog = { A1: entry({ salaryMin: 0, salaryMax: 0 }) };
  assert.match(renderStats(catalog), /Ни в одной вакансии не указана/);
});
