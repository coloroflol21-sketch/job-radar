import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fetchVacancies, parseDescription } from '../src/sources/hh.js';

function feed(items) {
  return `<?xml version='1.0' encoding='utf-8'?><rss version="2.0"><channel><title>HeadHunter Vacancy</title>${items
    .map((i) => `<item>${i}</item>`)
    .join('')}</channel></rss>`;
}

function item({
  id = '136630261',
  title = 'Специалист технической поддержки',
  company = 'Совкомбанк',
  region = 'Москва',
  income = 'от 70 000 до 150 000 ₽',
  pubDate = '2026-08-26T11:14:11.665+03:00',
} = {}) {
  const description = `<![CDATA[<p>Вакансия компании: ${company}</p> <p>Создана: 26.08.2026</p> <p>Регион: ${region}</p>${
    income ? ` <p>Предполагаемый уровень месячного дохода: ${income}</p>` : ''
  }]]>`;
  return `<pubDate>${pubDate}</pubDate><title>${title}</title><link>https://hh.ru/vacancy/${id}</link><guid isPermaLink="true">https://hh.ru/vacancy/${id}</guid><description>${description}</description>`;
}

function stubFetch(xml) {
  const calls = [];
  return {
    calls,
    impl: async (url) => {
      calls.push(url);
      return { ok: true, status: 200, text: async () => xml };
    },
  };
}

test('компания и регион берутся из абзацев описания', () => {
  const parsed = parseDescription('<p>Вакансия компании: Совкомбанк</p> <p>Создана: 26.08.2026</p> <p>Регион: Москва</p>');
  assert.equal(parsed.company, 'Совкомбанк');
  assert.equal(parsed.region, 'Москва');
});

test('вилка дохода разбирается', () => {
  const parsed = parseDescription('<p>Предполагаемый уровень месячного дохода: от 70 000 до 150 000 ₽</p>');
  assert.equal(parsed.salaryMin, 70000);
  assert.equal(parsed.salaryMax, 150000);
});

test('доход только «от» или только «до»', () => {
  assert.equal(parseDescription('дохода: от 383 000 ₽').salaryMin, 383000);
  assert.equal(parseDescription('дохода: до 250 000 ₽').salaryMax, 250000);
});

test('без указания дохода получаем нули', () => {
  const parsed = parseDescription('<p>Вакансия компании: X</p> <p>Регион: Москва</p>');
  assert.equal(parsed.salaryMin, 0);
  assert.equal(parsed.salaryMax, 0);
});

test('вакансия приводится к общему виду', async () => {
  const { impl } = stubFetch(feed([item()]));
  const [vacancy] = await fetchVacancies({ text: 'поддержка' }, { fetchImpl: impl });

  assert.equal(vacancy.id, 'hh-136630261', 'id с префиксом источника');
  assert.equal(vacancy.title, 'Специалист технической поддержки');
  assert.equal(vacancy.company, 'Совкомбанк');
  assert.equal(vacancy.region, 'Москва');
  assert.equal(vacancy.salaryMin, 70000);
  assert.equal(vacancy.url, 'https://hh.ru/vacancy/136630261');
  assert.equal(vacancy.source, 'hh');
  assert.match(vacancy.modifiedAt, /^2026-08-26T/);
});

test('email пустой: контактов в фиде нет', async () => {
  const { impl } = stubFetch(feed([item()]));
  const [vacancy] = await fetchVacancies({ text: 'поддержка' }, { fetchImpl: impl });
  assert.equal(vacancy.email, '', 'иначе бот предложил бы невозможный отклик');
});

test('удалёнка распознаётся по названию', async () => {
  const { impl } = stubFetch(feed([item({ title: 'Оператор чата (удаленно)' })]));
  const [vacancy] = await fetchVacancies({ text: 'чат' }, { fetchImpl: impl });
  assert.match(vacancy.employment, /Дистанционная/);
});

test('сменный график и неполный день распознаются по названию', async () => {
  const { impl } = stubFetch(
    feed([item({ id: '1', title: 'Оператор 2/2' }), item({ id: '2', title: 'Курьер, подработка' })]),
  );
  const [shift, part] = await fetchVacancies({ text: 'x' }, { fetchImpl: impl });
  assert.equal(shift.schedule, 'Сменная работа');
  assert.equal(part.schedule, 'Неполный рабочий день');
});

test('limit не превышает 200 — на больших значениях фид ломается', async () => {
  const { impl, calls } = stubFetch(feed([]));
  await fetchVacancies({ text: 'поддержка' }, { perQuery: 500, fetchImpl: impl });
  assert.match(calls[0], /limit=200/);
});

test('order_by в запрос не попадает: он выбрасывает релевантность', async () => {
  // С order_by=publication_time по запросу «поддержка» приходят полицейские.
  const { impl, calls } = stubFetch(feed([]));
  await fetchVacancies({ text: 'поддержка' }, { fetchImpl: impl });
  assert.doesNotMatch(calls[0], /order_by/);
  assert.doesNotMatch(calls[0], /period/);
});

test('регион передаётся отдельным параметром', async () => {
  const { impl, calls } = stubFetch(feed([]));
  await fetchVacancies({ text: 'поддержка', hhArea: 2 }, { fetchImpl: impl });
  assert.match(calls[0], /area=2/);
});

test('пустой фид не ломает разбор', async () => {
  const { impl } = stubFetch(feed([]));
  assert.deepEqual(await fetchVacancies({ text: 'поддержка' }, { fetchImpl: impl }), []);
});

test('повтор после ошибки 500', async () => {
  let attempt = 0;
  const impl = async () => {
    attempt += 1;
    if (attempt === 1) return { ok: false, status: 500, text: async () => '' };
    return { ok: true, status: 200, text: async () => feed([item()]) };
  };
  const vacancies = await fetchVacancies({ text: 'поддержка' }, { fetchImpl: impl });
  assert.equal(attempt, 2);
  assert.equal(vacancies.length, 1);
});

test('на 403 повторы не тратятся', async () => {
  let attempt = 0;
  const impl = async () => {
    attempt += 1;
    return { ok: false, status: 403, text: async () => '' };
  };
  await assert.rejects(() => fetchVacancies({ text: 'поддержка' }, { fetchImpl: impl }), /HTTP 403/);
  assert.equal(attempt, 1);
});
