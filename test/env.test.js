import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseEnv, loadEnv } from '../src/env.js';

test('читает пары ключ-значение', () => {
  const values = parseEnv('TELEGRAM_CHAT_ID=123456789\nSMTP_PORT=465');
  assert.equal(values.TELEGRAM_CHAT_ID, '123456789');
  assert.equal(values.SMTP_PORT, '465');
});

test('пароль приложения Google с пробелами читается целиком', () => {
  const values = parseEnv('SMTP_PASSWORD=abcd efgh ijkl mnop');
  assert.equal(values.SMTP_PASSWORD, 'abcd efgh ijkl mnop');
});

test('кавычки снимаются, содержимое сохраняется', () => {
  const values = parseEnv('A="abcd efgh"\nB=\'xyz\'');
  assert.equal(values.A, 'abcd efgh');
  assert.equal(values.B, 'xyz');
});

test('токен со знаками : и - не ломается', () => {
  const values = parseEnv('TELEGRAM_BOT_TOKEN=8123456789:AAF-abc_DEF123');
  assert.equal(values.TELEGRAM_BOT_TOKEN, '8123456789:AAF-abc_DEF123');
});

test('адрес в угловых скобках сохраняется', () => {
  const values = parseEnv('SMTP_FROM=Иван Петров <ivan@gmail.com>');
  assert.equal(values.SMTP_FROM, 'Иван Петров <ivan@gmail.com>');
});

test('комментарии и пустые строки пропускаются', () => {
  const values = parseEnv('# комментарий\n\nA=1\n   # ещё один\nB=2');
  assert.deepEqual(values, { A: '1', B: '2' });
});

test('пробелы вокруг ключа и значения обрезаются', () => {
  const values = parseEnv('  SMTP_USER  =  me@gmail.com  ');
  assert.equal(values.SMTP_USER, 'me@gmail.com');
});

test('строки без знака равенства игнорируются', () => {
  const values = parseEnv('просто текст\nA=1');
  assert.deepEqual(values, { A: '1' });
});

test('пустое значение допустимо', () => {
  assert.equal(parseEnv('SMTP_FROM=').SMTP_FROM, '');
});

test('файл с переводами строк Windows читается', () => {
  const values = parseEnv('A=1\r\nB=2\r\n');
  assert.deepEqual(values, { A: '1', B: '2' });
});

test('отсутствующий файл не считается ошибкой', () => {
  assert.deepEqual(loadEnv(join(tmpdir(), 'нет-такого-файла-job-radar.env')), {});
});

test('loadEnv переносит значения в process.env', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'job-radar-env-'));
  const path = join(dir, '.env');
  await writeFile(path, 'JOB_RADAR_TEST_KEY=из файла', 'utf8');

  delete process.env.JOB_RADAR_TEST_KEY;
  loadEnv(path);
  assert.equal(process.env.JOB_RADAR_TEST_KEY, 'из файла');
  delete process.env.JOB_RADAR_TEST_KEY;
});

test('уже заданная переменная окружения приоритетнее файла', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'job-radar-env-'));
  const path = join(dir, '.env');
  await writeFile(path, 'JOB_RADAR_TEST_KEY=из файла', 'utf8');

  process.env.JOB_RADAR_TEST_KEY = 'из окружения';
  loadEnv(path);
  assert.equal(
    process.env.JOB_RADAR_TEST_KEY,
    'из окружения',
    'в GitHub Actions значения приходят из секретов и не должны затираться',
  );
  delete process.env.JOB_RADAR_TEST_KEY;
});
