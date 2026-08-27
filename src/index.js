#!/usr/bin/env node
/**
 * Job Radar — вакансии в Telegram и отклики прямо из чата.
 *
 * Запуск:
 *   node src/index.js            один прогон: команды + поиск (для GitHub Actions)
 *   node src/index.js --serve    живой бот: отвечает сразу, пока не остановите
 *   node src/index.js --dry-run  показать найденное в консоли, ничего не отправляя
 */

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

import { loadEnv } from './env.js';
import { loadState } from './state.js';
import { processInbox } from './inbox.js';
import { scanVacancies } from './scan.js';
import { serve, announceOnline, announceOffline, emptyResultText, failureText, registerCommands } from './serve.js';
import { sendMessage } from './telegram.js';
import { createMailer } from './mailer.js';
import { effectiveConfig } from './settings.js';
import { checkReplies } from './replies.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

loadEnv(resolve(ROOT, '.env'));

function parseArgs(argv) {
  const args = {
    dryRun: false,
    serve: false,
    config: resolve(ROOT, 'config.json'),
    state: resolve(ROOT, 'state/state.json'),
    scanInterval: 60,
  };

  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--dry-run') args.dryRun = true;
    else if (argv[i] === '--serve') args.serve = true;
    else if (argv[i] === '--config') args.config = resolve(argv[++i]);
    else if (argv[i] === '--state') args.state = resolve(argv[++i]);
    else if (argv[i] === '--scan-interval') args.scanInterval = Number(argv[++i]) || 60;
  }

  return args;
}

/** Ctrl+C переводит цикл в остановку; второй Ctrl+C выходит немедленно. */
function stopOnInterrupt(log) {
  const controller = new AbortController();
  let asked = false;

  const onSignal = () => {
    if (asked) {
      log('\nВыхожу немедленно.');
      process.exit(130);
    }
    asked = true;
    log('\nЗавершаю текущую операцию... (ещё раз Ctrl+C — выйти сразу)');
    controller.abort();
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  return controller.signal;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const config = JSON.parse(await readFile(args.config, 'utf8'));
  const state = await loadState(args.state);

  const credentials = {
    token: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID,
  };

  if (args.serve) {
    if (!credentials.token || !credentials.chatId) {
      throw new Error('Для режима бота нужны TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID в файле .env');
    }

    const stopSignal = stopOnInterrupt(console.log);
    await registerCommands(credentials);
    await announceOnline(credentials, { scanIntervalMinutes: args.scanInterval, state });

    try {
      await serve(state, args.state, config, {
        credentials,
        stopSignal,
        scanIntervalMinutes: args.scanInterval,
      });
    } finally {
      // Сообщение об остановке отправляем в любом случае, чтобы в чате
      // не осталось ложного впечатления, что бот ещё отвечает.
      await announceOffline(credentials).catch(() => {});
    }
    return;
  }

  // «Проверить сейчас» и «Ещё вакансии» в одиночном режиме обслуживаются тем же
  // поиском, который идёт ниже: отдельного прогона не нужно, достаточно
  // подтвердить нажатие, чтобы кнопка не выглядела мёртвой.
  let askedForScan = false;

  if (!args.dryRun && credentials.token && credentials.chatId) {
    try {
      const replies = await processInbox(state, args.state, credentials, {
        createTransport: createMailer,
        mail: {
          from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
          replyTo: process.env.SMTP_USER,
        },
        config,
        onPreview: async () => {
          askedForScan = true;
          await sendMessage('🔄 Ищу вакансии, результат пришлю сюда же.', credentials).catch(() => {});
        },
        onMore: async () => {
          askedForScan = true;
          await sendMessage('➕ Смотрю, что ещё есть по вашим фильтрам.', credentials).catch(() => {});
        },
      });
      if (replies.length > 0) console.log(`Обработано команд из чата: ${replies.length}`);
    } catch (error) {
      // Сбой в командах не должен ломать основной поиск вакансий.
      console.error(`Не удалось обработать команды: ${error.message}`);
    }
  }

  // Настройки из чата перекрывают config.json — читаем их после обработки команд.
  const active = effectiveConfig(config, state);
  const { sent, failures, collected, matching } = await scanVacancies(state, args.state, active, {
    credentials,
    dryRun: args.dryRun,
  });

  if (!args.dryRun) {
    if (sent.length === 0) {
      console.log('Новых подходящих вакансий нет.');
      // При запуске по расписанию каждые 5 минут сообщение о пустом результате
      // превратилось бы в 288 уведомлений в сутки. Пишем только когда причина
      // в фильтрах либо когда пользователь сам нажал кнопку и ждёт ответа.
      const worthTelling = askedForScan || (collected > 0 && matching === 0);
      if (worthTelling && credentials.token && credentials.chatId) {
        await sendMessage(emptyResultText({ collected, matching, active }), credentials).catch(() => {});
      }
    } else {
      const withEmail = sent.filter((vacancy) => vacancy.email).length;
      console.log(`Отправлено вакансий: ${sent.length}, из них с email для отклика: ${withEmail}`);
    }

    // Ответы работодателей: проверяем после поиска, чтобы сбой почты
    // не помешал прислать вакансии.
    await checkReplies(state, args.state, credentials);

    // О сбое источника сообщаем всегда: молчание выглядело бы как «нет вакансий».
    if (failures.length > 0 && credentials.token && credentials.chatId) {
      await sendMessage(failureText(failures), credentials).catch(() => {});
    }
  }
}

main().catch((error) => {
  console.error(`Сбой: ${error.message}`);
  process.exit(1);
});
