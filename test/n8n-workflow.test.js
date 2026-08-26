/**
 * Прогоняет код из нод n8n workflow в эмуляции окружения n8n.
 * Защищает от расхождения логики между GitHub Actions и n8n.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const workflow = JSON.parse(await readFile(resolve(ROOT, 'n8n/job-radar.workflow.json'), 'utf8'));
const nodeByName = (name) => workflow.nodes.find((node) => node.name === name);

/** Исполняет jsCode ноды, подставляя $input и $getWorkflowStaticData. */
async function runCodeNode(name, { items = [], staticData = {} } = {}) {
  const { jsCode } = nodeByName(name).parameters;
  const runner = new Function(
    '$input',
    '$getWorkflowStaticData',
    `return (async () => { ${jsCode} })();`,
  );
  const $input = { all: () => items };
  const result = await runner($input, () => staticData);
  return { result, staticData };
}

function apiResponse(vacancies) {
  return { json: { results: { vacancies } } };
}

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
      schedule: 'Полный рабочий день',
      duty: 'Разработка сервисов',
      requirement: '{"experience":3}',
      'creation-date': new Date().toISOString().slice(0, 10),
      date_modify: new Date().toISOString(),
      ...overrides,
    },
  };
}

test('нода «Собрать запросы» строит по URL на каждый поисковый запрос', async () => {
  const { result } = await runCodeNode('Собрать запросы');
  assert.equal(result.length, 3);
  for (const item of result) {
    assert.match(item.json.url, /^https:\/\/opendata\.trudvsem\.ru\/api\/v1\/vacancies/);
    assert.match(item.json.url, /modifiedFrom=\d{4}-\d{2}-\d{2}T/);
    assert.match(item.json.url, /limit=100/);
  }
  assert.match(result[0].json.url, /\/region\/7700000000\?/);
});

test('окно поиска опирается на lastRunAt из staticData', async () => {
  const staticData = { lastRunAt: '2026-08-26T12:00:00.000Z' };
  const { result } = await runCodeNode('Собрать запросы', { staticData });
  const url = new URL(result[0].json.url);
  assert.equal(url.searchParams.get('modifiedFrom'), '2026-08-26T06:00:00Z');
});

test('нода отбора фильтрует, оформляет HTML и запоминает id', async () => {
  const staticData = {};
  const items = [apiResponse([apiVacancy('a'), apiVacancy('b', { salary_min: 30000 })])];

  const { result } = await runCodeNode('Отобрать и оформить', { items, staticData });

  assert.equal(result.length, 1, 'один дайджест-сообщение');
  assert.match(result[0].json.text, /Новые вакансии: 1/, 'дешёвая вакансия отфильтрована');
  assert.match(result[0].json.text, /Python разработчик/);
  assert.deepEqual(staticData.sentIds, ['a']);
  assert.ok(staticData.lastRunAt, 'окно сдвинуто');
});

test('нода отбора не присылает повторно уже отправленное', async () => {
  const staticData = { sentIds: ['a'] };
  const { result } = await runCodeNode('Отобрать и оформить', {
    items: [apiResponse([apiVacancy('a')])],
    staticData,
  });
  assert.deepEqual(result, [], 'при отсутствии новинок сообщений нет');
  assert.ok(staticData.lastRunAt, 'но окно всё равно сдвинуто');
});

test('нода отбора выдерживает ошибочный ответ API', async () => {
  const items = [{ json: { errors: [{ type: 'forbidden' }] } }, apiResponse([apiVacancy('a')])];
  const { result } = await runCodeNode('Отобрать и оформить', { items, staticData: {} });
  assert.equal(result.length, 1, 'пустой ответ пропущен, рабочий обработан');
});

test('нода отбора экранирует HTML в названиях компаний', async () => {
  const items = [apiResponse([apiVacancy('a', { company: { name: 'ООО <b>Х</b>' } })])];
  const { result } = await runCodeNode('Отобрать и оформить', { items, staticData: {} });
  assert.match(result[0].json.text, /ООО &lt;b&gt;Х&lt;\/b&gt;/);
});

test('длинный дайджест разбивается на сообщения в пределах лимита Telegram', async () => {
  const many = Array.from({ length: 60 }, (_, i) =>
    apiVacancy(`v${i}`, { 'job-name': `Разработчик специализации номер ${i} с длинным названием` }),
  );
  const { result } = await runCodeNode('Отобрать и оформить', {
    items: [apiResponse(many)],
    staticData: {},
  });

  for (const item of result) {
    assert.ok(item.json.text.length <= 4096, `сообщение ${item.json.text.length} символов`);
  }
});

test('история id в staticData обрезается', async () => {
  const staticData = { sentIds: Array.from({ length: 3000 }, (_, i) => `old-${i}`) };
  await runCodeNode('Отобрать и оформить', {
    items: [apiResponse([apiVacancy('fresh')])],
    staticData,
  });
  assert.equal(staticData.sentIds.length, 3000);
  assert.equal(staticData.sentIds.at(-1), 'fresh');
});

test('нода Telegram подставляет токен и chat_id из переменных окружения', () => {
  const node = nodeByName('Отправить в Telegram');
  assert.equal(node.parameters.method, 'POST');
  assert.match(node.parameters.url, /\$env\.TELEGRAM_BOT_TOKEN/);
  assert.match(node.parameters.jsonBody, /\$env\.TELEGRAM_CHAT_ID/);
  assert.match(node.parameters.jsonBody, /parse_mode: 'HTML'/);
});

test('сетевые ноды настроены на повторные попытки', () => {
  for (const name of ['Запрос к API вакансий', 'Отправить в Telegram']) {
    assert.equal(nodeByName(name).retryOnFail, true, `${name}: нет retryOnFail`);
  }
});
