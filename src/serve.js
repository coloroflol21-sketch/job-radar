/**
 * Режим живого бота: запустили один раз — отвечает сразу, пока не остановите.
 * Команды читаются длинным опросом, поиск вакансий идёт по таймеру.
 */

import { processInbox } from './inbox.js';
import { scanVacancies } from './scan.js';
import { sendMessage } from './telegram.js';
import { createMailer } from './mailer.js';
import { effectiveConfig } from './settings.js';

/** Telegram держит соединение до 50 секунд; больше не имеет смысла. */
const POLL_TIMEOUT_SECONDS = 30;

/** Пауза после сетевой ошибки, чтобы не долбить API в цикле. */
const ERROR_BACKOFF_MS = 5000;

function mailSettings() {
  return {
    from: process.env.SMTP_FROM ?? process.env.SMTP_USER,
    replyTo: process.env.SMTP_USER,
  };
}

/**
 * Запускает бота до сигнала остановки.
 * stopSignal — AbortSignal: по нему цикл завершается, не обрывая текущую команду.
 */
export async function serve(state, statePath, config, { credentials, stopSignal, scanIntervalMinutes = 60, log = console.log, fetchImpl = fetch, scan = scanVacancies } = {}) {
  const scanIntervalMs = scanIntervalMinutes * 60_000;
  let lastScanAt = 0;

  log('Бот запущен. Команды: /settings, /help, /list, /preview, /apply, /sent');
  log(`Поиск вакансий — каждые ${scanIntervalMinutes} мин. Остановить — Ctrl+C.\n`);

  /** Настройки из чата перекрывают config.json, поэтому читаем их каждый раз. */
  const runScan = async () => {
    const active = effectiveConfig(config, state);
    const sent = await scan(state, statePath, active, { credentials, log });
    if (sent.length > 0) {
      const withEmail = sent.filter((vacancy) => vacancy.email).length;
      log(`Отправлено вакансий: ${sent.length}, с адресом для отклика: ${withEmail}\n`);
    } else {
      log('Новых подходящих вакансий нет.\n');
    }
    return sent;
  };

  while (!stopSignal.aborted) {
    // Поиск по таймеру: первый прогон сразу при старте.
    if (Date.now() - lastScanAt >= scanIntervalMs) {
      lastScanAt = Date.now();
      try {
        await runScan();
      } catch (error) {
        log(`Поиск не удался: ${error.message}`);
      }
      if (stopSignal.aborted) break;
    }

    // Длинный опрос: возвращается сразу при новом сообщении либо по таймауту.
    try {
      const replies = await processInbox(state, statePath, credentials, {
        createTransport: createMailer,
        mail: mailSettings(),
        config,
        timeout: POLL_TIMEOUT_SECONDS,
        signal: stopSignal,
        fetchImpl,
        // Кнопка «Проверить выдачу» в меню запускает поиск не дожидаясь таймера.
        onPreview: async () => {
          lastScanAt = Date.now();
          await runScan().catch((error) => log(`Поиск не удался: ${error.message}`));
        },
      });
      if (replies.length > 0) log(`Ответов на команды: ${replies.length}`);
    } catch (error) {
      // Прерывание по Ctrl+C приходит сюда же — это не ошибка.
      if (stopSignal.aborted) break;
      log(`Ошибка при обработке команд: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, ERROR_BACKOFF_MS));
    }
  }

  log('\nБот остановлен.');
}

/**
 * Сообщает в чат, что бот на связи: иначе неясно,
 * дошла ли команда или программа не запущена.
 */
export async function announceOnline(credentials, { scanIntervalMinutes } = {}) {
  const text = [
    '🟢 <b>Бот на связи</b>',
    '',
    'Отвечаю сразу, пока запущен.',
    '',
    '<code>/settings</code> — настроить поиск кнопками',
    '<code>/list</code> — вакансии для отклика',
    '<code>/help</code> — все команды',
    '',
    `Новые вакансии проверяю каждые ${scanIntervalMinutes} мин.`,
  ].join('\n');

  await sendMessage(text, credentials);
}

export async function announceOffline(credentials) {
  await sendMessage('⚪️ <b>Бот выключен</b>\nКоманды снова заработают после запуска.', credentials);
}
