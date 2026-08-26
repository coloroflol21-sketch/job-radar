/**
 * Читает настройки из файла .env, чтобы не задавать их в командной строке:
 * синтаксис отличается в Git Bash, cmd и PowerShell, а файл работает везде.
 *
 * Уже заданные переменные окружения приоритетнее файла: в GitHub Actions
 * значения приходят из секретов, и .env там просто отсутствует.
 */

import { readFileSync } from 'node:fs';

function parse(contents) {
  const values = {};

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const separator = line.indexOf('=');
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();

    // Кавычки нужны для значений с пробелами: пароли приложений Google
    // показываются как четыре группы по четыре символа через пробел.
    const quote = value[0];
    if ((quote === '"' || quote === "'") && value.endsWith(quote) && value.length > 1) {
      value = value.slice(1, -1);
    }

    if (key) values[key] = value;
  }

  return values;
}

export function loadEnv(path = '.env') {
  let contents;
  try {
    contents = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }

  const values = parse(contents);
  for (const [key, value] of Object.entries(values)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }

  return values;
}

export { parse as parseEnv };
