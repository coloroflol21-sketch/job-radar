import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fetchVacancies } from '../src/sources/trudvsem.js';

function apiVacancy(id, overrides = {}) {
  return {
    vacancy: {
      id,
      'job-name': 'Python разработчик',
      company: { name: 'ООО Тест' },
      region: { name: 'Город Москва' },
      vac_url: `https://trudvsem.ru/vacancy/${id}`,
      salary_min: 150000,
      salary_max: 0,
      salary: 'от 150000',
      schedule: 'Полный рабочий день',
      duty: 'Разработка',
      requirement: '{"education":"Высшее","experience":3}',
      'creation-date': '2026-08-25',
      date_modify: '2026-08-25T10:00:00+0300',
      ...overrides,
    },
  };
}

function stubFetch(pages) {
  const calls = [];
  const impl = async (url) => {
    calls.push(url);
    const page = pages.shift() ?? [];
    return { ok: true, status: 200, json: async () => ({ results: { vacancies: page } }) };
  };
  return { impl, calls };
}

test('нормализует запись API в плоский объект', async () => {
  const { impl } = stubFetch([[apiVacancy('a')]]);
  const [vacancy] = await fetchVacancies({ text: 'python' }, { perQuery: 1, fetchImpl: impl });

  assert.equal(vacancy.id, 'a');
  assert.equal(vacancy.title, 'Python разработчик');
  assert.equal(vacancy.company, 'ООО Тест');
  assert.equal(vacancy.salaryMin, 150000);
  assert.equal(vacancy.experienceYears, 3, 'опыт разбирается из JSON-строки requirement');
  assert.equal(vacancy.matchedQuery, 'python');
});

test('нечитаемое поле requirement не роняет разбор', async () => {
  const { impl } = stubFetch([[apiVacancy('a', { requirement: 'не json' })]]);
  const [vacancy] = await fetchVacancies({ text: 'python' }, { perQuery: 1, fetchImpl: impl });
  assert.equal(vacancy.experienceYears, 0);
});

test('отсутствующие поля заменяются безопасными значениями', async () => {
  const { impl } = stubFetch([[{ vacancy: { id: 'bare' } }]]);
  const [vacancy] = await fetchVacancies({ text: 'python' }, { perQuery: 1, fetchImpl: impl });
  assert.equal(vacancy.title, '');
  assert.equal(vacancy.company, 'не указана');
  assert.equal(vacancy.salaryMin, 0);
});

test('регион и modifiedFrom попадают в запрос', async () => {
  const { impl, calls } = stubFetch([[]]);
  await fetchVacancies(
    { text: 'python', region: '7700000000' },
    { perQuery: 10, modifiedFrom: '2026-08-24T00:00:00Z', fetchImpl: impl },
  );
  assert.match(calls[0], /\/region\/7700000000\?/);
  assert.match(calls[0], /modifiedFrom=2026-08-24T00%3A00%3A00Z/);
});

test('листает страницы, пока API отдаёт полные', async () => {
  const full = Array.from({ length: 100 }, (_, i) => apiVacancy(`p1-${i}`));
  const tail = [apiVacancy('p2-0')];
  const { impl, calls } = stubFetch([full, tail]);

  const vacancies = await fetchVacancies({ text: 'python' }, { perQuery: 200, fetchImpl: impl });

  assert.equal(vacancies.length, 101);
  assert.equal(calls.length, 2);
  assert.match(calls[1], /offset=100/);
});

test('не запрашивает больше, чем perQuery', async () => {
  const { impl, calls } = stubFetch([[apiVacancy('a')]]);
  await fetchVacancies({ text: 'python' }, { perQuery: 5, fetchImpl: impl });
  assert.match(calls[0], /limit=5/);
});

test('повторяет попытку после ошибки 500 и возвращает данные', async () => {
  let attempt = 0;
  const impl = async () => {
    attempt += 1;
    if (attempt === 1) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ results: { vacancies: [apiVacancy('a')] } }) };
  };

  const vacancies = await fetchVacancies({ text: 'python' }, { perQuery: 1, fetchImpl: impl });
  assert.equal(attempt, 2);
  assert.equal(vacancies.length, 1);
});

test('на 400 не тратит повторы — ошибка не временная', async () => {
  let attempt = 0;
  const impl = async () => {
    attempt += 1;
    return { ok: false, status: 400, json: async () => ({}) };
  };

  await assert.rejects(() => fetchVacancies({ text: 'python' }, { perQuery: 1, fetchImpl: impl }), /HTTP 400/);
  assert.equal(attempt, 1);
});

test('пустая выдача возвращает пустой список', async () => {
  const impl = async () => ({ ok: true, status: 200, json: async () => ({ results: {} }) });
  const vacancies = await fetchVacancies({ text: 'python' }, { perQuery: 10, fetchImpl: impl });
  assert.deepEqual(vacancies, []);
});
