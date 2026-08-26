import { test } from 'node:test';
import assert from 'node:assert/strict';

import { fetchVacancies, parseDescription, parseTitle } from '../src/sources/habr.js';

/** Фид отдаёт XML, поэтому тесты кормят источник настоящей разметкой. */
function feed(items) {
  return `<?xml version="1.0" encoding="UTF-8"?><rss><channel><title>Вакансии</title>${items
    .map((i) => `<item>${i}</item>`)
    .join('')}</channel></rss>`;
}

function item({
  guid = '1000167621',
  title = 'Требуется «Специалист технической поддержки» (Москва)',
  description = 'Компания «Тест» ищет хорошего специалиста на вакансию «Специалист технической поддержки». Москва (Россия). От 62 000 ₽ до 70 000 ₽. Полный рабочий день. Требуемые навыки: #junior, #Linux.',
  author = 'ООО Тест',
  pubDate = 'Thu, 20 Aug 2026 18:27:08 +0300',
  link = 'https://career.habr.com/vacancies/1000167621',
} = {}) {
  return `<title>${title}</title><description>${description}</description><author>${author}</author><pubDate>${pubDate}</pubDate><link>${link}</link><guid>${guid}</guid>`;
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

test('название вакансии берётся из кавычек, без «Требуется» и города', () => {
  assert.equal(parseTitle('Требуется «Инженер поддержки» (Москва)'), 'Инженер поддержки');
});

test('название без кавычек тоже разбирается', () => {
  assert.equal(parseTitle('Требуется Инженер поддержки (Москва)'), 'Инженер поддержки');
});

test('вилка зарплаты разбирается из описания', () => {
  const parsed = parseDescription('От 62 000 ₽ до 70 000 ₽.');
  assert.equal(parsed.salaryMin, 62000);
  assert.equal(parsed.salaryMax, 70000);
});

test('зарплата «от» и «до» по отдельности', () => {
  assert.equal(parseDescription('От 35 000 ₽.').salaryMin, 35000);
  assert.equal(parseDescription('До 92 000 ₽.').salaryMax, 92000);
});

test('описание без зарплаты даёт нули, а не мусор', () => {
  const parsed = parseDescription('Компания ищет специалиста. Москва (Россия).');
  assert.equal(parsed.salaryMin, 0);
  assert.equal(parsed.salaryMax, 0);
});

test('регион берётся из скобок перед точкой', () => {
  assert.equal(parseDescription('Вакансия. Санкт-Петербург (Россия). Полный рабочий день.').region, 'Санкт-Петербург');
});

test('признак удалёнки распознаётся', () => {
  assert.equal(parseDescription('Полный рабочий день. Можно удалённо.').remote, true);
  assert.equal(parseDescription('Полный рабочий день.').remote, false);
});

test('грейд переводится в годы опыта', () => {
  // В фиде опыт задан тегом, а фильтр работает с числом лет.
  assert.equal(parseDescription('#intern').experienceYears, 0);
  assert.equal(parseDescription('#junior').experienceYears, 1);
  assert.equal(parseDescription('#middle').experienceYears, 3);
  assert.equal(parseDescription('#senior').experienceYears, 5);
  assert.equal(parseDescription('#lead').experienceYears, 6);
});

test('без тега грейда опыт считается нулевым', () => {
  assert.equal(parseDescription('Требуемые навыки: #Linux.').experienceYears, 0);
});

test('вакансия приводится к общему виду', async () => {
  const { impl } = stubFetch(feed([item()]));
  const [vacancy] = await fetchVacancies({ text: 'поддержка' }, { fetchImpl: impl });

  assert.equal(vacancy.id, 'habr-1000167621', 'id с префиксом источника');
  assert.equal(vacancy.title, 'Специалист технической поддержки');
  assert.equal(vacancy.company, 'ООО Тест');
  assert.equal(vacancy.salaryMin, 62000);
  assert.equal(vacancy.region, 'Москва');
  assert.equal(vacancy.source, 'habr');
  assert.match(vacancy.modifiedAt, /^2026-08-20T/);
});

test('email всегда пустой: в фиде нет контактов', async () => {
  const { impl } = stubFetch(feed([item()]));
  const [vacancy] = await fetchVacancies({ text: 'поддержка' }, { fetchImpl: impl });
  assert.equal(vacancy.email, '', 'иначе бот предложил бы отклик, который невозможно отправить');
});

test('id префиксован источником, чтобы не столкнуться с другим API', async () => {
  const { impl } = stubFetch(feed([item({ guid: '12345' })]));
  const [vacancy] = await fetchVacancies({ text: 'поддержка' }, { fetchImpl: impl });
  assert.equal(vacancy.id, 'habr-12345');
});

test('запрос попадает в параметр q, remoteOnly включает фильтр фида', async () => {
  const { impl, calls } = stubFetch(feed([]));
  await fetchVacancies({ text: 'техническая поддержка', remoteOnly: true }, { fetchImpl: impl });
  assert.match(calls[0], /q=%D1%82%D0%B5%D1%85/);
  assert.match(calls[0], /remote=true/);
});

test('perQuery ограничивает число вакансий', async () => {
  const { impl } = stubFetch(feed([item({ guid: '1' }), item({ guid: '2' }), item({ guid: '3' })]));
  const vacancies = await fetchVacancies({ text: 'поддержка' }, { perQuery: 2, fetchImpl: impl });
  assert.equal(vacancies.length, 2);
});

test('пустой фид не ломает разбор', async () => {
  const { impl } = stubFetch(feed([]));
  assert.deepEqual(await fetchVacancies({ text: 'поддержка' }, { fetchImpl: impl }), []);
});

test('CDATA и HTML-сущности раскодируются', async () => {
  const xml = feed([
    item({
      author: '<![CDATA[ООО «Тест» &amp; Ко]]>',
      title: 'Требуется «Инженер &quot;поддержки&quot;» (Москва)',
    }),
  ]);
  const { impl } = stubFetch(xml);
  const [vacancy] = await fetchVacancies({ text: 'поддержка' }, { fetchImpl: impl });
  assert.equal(vacancy.company, 'ООО «Тест» & Ко');
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

test('на 404 повторы не тратятся', async () => {
  let attempt = 0;
  const impl = async () => {
    attempt += 1;
    return { ok: false, status: 404, text: async () => '' };
  };
  await assert.rejects(() => fetchVacancies({ text: 'поддержка' }, { fetchImpl: impl }), /HTTP 404/);
  assert.equal(attempt, 1);
});
