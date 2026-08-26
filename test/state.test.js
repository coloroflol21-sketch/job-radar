import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { loadState, saveState, windowStart } from '../src/state.js';

async function tempFile(name = 'state.json') {
  const dir = await mkdtemp(join(tmpdir(), 'job-radar-'));
  return join(dir, name);
}

test('отсутствующий файл состояния даёт пустое состояние', async () => {
  const state = await loadState(await tempFile('missing.json'));
  assert.deepEqual(state, {
    sentIds: [],
    lastRunAt: null,
    totalSent: 0,
    catalog: {},
    sentLog: [],
    lastUpdateId: 0,
  });
});

test('состояние старого формата читается без потерь', async () => {
  const path = await tempFile();
  await writeFile(path, JSON.stringify({ sentIds: ['a'], lastRunAt: null, totalSent: 1 }), 'utf8');
  const state = await loadState(path);
  assert.deepEqual(state.sentIds, ['a']);
  assert.deepEqual(state.catalog, {}, 'новые поля получают значения по умолчанию');
  assert.deepEqual(state.sentLog, []);
  assert.equal(state.lastUpdateId, 0);
});

test('каталог и журнал откликов сохраняются', async () => {
  const path = await tempFile();
  await saveState(path, {
    sentIds: [],
    lastRunAt: null,
    totalSent: 0,
    catalog: { A1: { id: 'a', email: 'hr@example.com', addedAt: new Date().toISOString() } },
    sentLog: [{ code: 'A1', sentAt: new Date().toISOString() }],
    lastUpdateId: 42,
  });

  const state = await loadState(path);
  assert.equal(state.catalog.A1.email, 'hr@example.com');
  assert.equal(state.sentLog.length, 1);
  assert.equal(state.lastUpdateId, 42);
});

test('битый JSON пробрасывает ошибку, а не молча теряет историю', async () => {
  const path = await tempFile();
  await writeFile(path, '{ не json', 'utf8');
  await assert.rejects(() => loadState(path));
});

test('состояние сохраняется и читается обратно', async () => {
  const path = await tempFile();
  await saveState(path, { sentIds: ['a', 'b'], lastRunAt: '2026-08-26T10:00:00.000Z', totalSent: 2 });
  const state = await loadState(path);
  assert.deepEqual(state.sentIds, ['a', 'b']);
  assert.equal(state.totalSent, 2);
});

test('saveState создаёт вложенные каталоги', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'job-radar-')), 'nested', 'deep', 'state.json');
  await saveState(path, { sentIds: ['x'], lastRunAt: null, totalSent: 1 });
  assert.match(await readFile(path, 'utf8'), /"x"/);
});

test('история id обрезается, чтобы файл не рос бесконечно', async () => {
  const path = await tempFile();
  const ids = Array.from({ length: 5000 }, (_, i) => `id-${i}`);
  await saveState(path, { sentIds: ids, lastRunAt: null, totalSent: 5000 });
  const state = await loadState(path);
  assert.equal(state.sentIds.length, 3000);
  assert.equal(state.sentIds.at(-1), 'id-4999', 'должны остаться самые свежие id');
});

test('первый запуск берёт окно из fallbackDays', () => {
  const from = Date.parse(windowStart(null, { fallbackDays: 3 }));
  const expected = Date.now() - 3 * 86_400_000;
  assert.ok(Math.abs(from - expected) < 5000);
});

test('следующий запуск отступает назад на нахлёст', () => {
  const lastRun = '2026-08-26T12:00:00.000Z';
  const from = Date.parse(windowStart(lastRun, { overlapHours: 6 }));
  assert.equal(from, Date.parse('2026-08-26T06:00:00.000Z'));
});

test('окно отдаётся в формате, который принимает API (без миллисекунд)', () => {
  assert.match(windowStart('2026-08-26T12:00:00.000Z'), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test('нечитаемая дата последнего запуска не роняет расчёт окна', () => {
  const from = Date.parse(windowStart('чепуха', { fallbackDays: 2 }));
  assert.ok(Math.abs(from - (Date.now() - 2 * 86_400_000)) < 5000);
});
