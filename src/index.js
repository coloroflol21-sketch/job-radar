#!/usr/bin/env node
/**
 * Job Radar — присылает в Telegram новые вакансии по заданным запросам.
 * Запуск: node src/index.js [--dry-run] [--config path]
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { loadEnv } from './env.js';
import { fetchVacancies } from './sources/trudvsem.js';
import { selectNew } from './filter.js';
import { loadState, saveState, windowStart } from './state.js';
import { sendDigest, formatVacancy } from './telegram.js';
import { registerVacancies, pruneCatalog } from './catalog.js';
import { processInbox } from './inbox.js';
import { createMailer } from './mailer.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

loadEnv(resolve(ROOT, '.env'));

function parseArgs(argv) {
  const args = { dryRun: false, config: resolve(ROOT, 'config.json'), state: resolve(ROOT, 'state/state.json') };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--config') args.config = resolve(argv[++i]);
    else if (argv[i] === '--state') args.state = resolve(argv[++i]);
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = JSON.parse(await readFile(args.config, 'utf8'));
  const state = await loadState(args.state);

  const credentials = {
    token: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
  };

  if (!args.dryRun && credentials.token && credentials.chatId) {
    try {
      const replies = await processInbox(state, args.state, credentials, {
        createTransport: createMailer,
        mail: {
          from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
          replyTo: process.env.SMTP_USER,
        },
      });
      if (replies.length > 0) console.log(`Обработано команд из чата: ${replies.length}`);
    } catch (error) {
      // Сбой в командах не должен ломать основной поиск вакансий.
      console.error(`Не удалось обработать команды: ${error.message}`);
    }
  }

  const modifiedFrom = windowStart(state.lastRunAt, { fallbackDays: config.filters?.maxAgeDays ?? 3 });
  console.log(`Окно поиска: с ${modifiedFrom}`);

  const results = await Promise.allSettled(
    config.queries.map((query) =>
      fetchVacancies(query, { perQuery: config.limits?.perQuery ?? 100, modifiedFrom }),
    ),
  );

  const collected = [];
  results.forEach((result, i) => {
    const label = `${config.queries[i].text}@${config.queries[i].region ?? 'все регионы'}`;
    if (result.status === 'fulfilled') {
      console.log(`  ${label}: получено ${result.value.length}`);
      collected.push(...result.value);
    } else {
      console.error(`  ${label}: ошибка — ${result.reason?.message ?? result.reason}`);
    }
  });

  if (results.every((r) => r.status === 'rejected')) {
    throw new Error('Ни один запрос не выполнился, источник недоступен');
  }

  const fresh = selectNew(
    collected,
    new Set(state.sentIds),
    config.filters ?? {},
    config.limits?.maxNotificationsPerRun ?? 12,
  );

  console.log(`Всего собрано ${collected.length}, после фильтров и дедупликации: ${fresh.length}`);

  if (fresh.length === 0) {
    state.lastRunAt = new Date().toISOString();
    await saveState(args.state, state);
    console.log('Новых подходящих вакансий нет, уведомление не отправляется.');
    return;
  }

  state.catalog ??= {};
  pruneCatalog(state.catalog);
  const coded = registerVacancies(state.catalog, fresh);
  const withEmail = coded.filter((vacancy) => vacancy.email).length;

  if (args.dryRun) {
    console.log(`\n--- dry-run, сообщения не отправляются (с email: ${withEmail} из ${coded.length}) ---`);
    coded.forEach((vacancy, i) => console.log(`\n${formatVacancy(vacancy, i + 1)}`));
    return;
  }

  await sendDigest(coded, credentials);

  state.sentIds = [...state.sentIds, ...coded.map((v) => v.id)];
  state.lastRunAt = new Date().toISOString();
  state.totalSent = (state.totalSent ?? 0) + coded.length;
  await saveState(args.state, state);

  console.log(`Отправлено вакансий: ${coded.length}, из них с email для отклика: ${withEmail}`);
}

main().catch((error) => {
  console.error(`Сбой: ${error.message}`);
  process.exit(1);
});
