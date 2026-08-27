/**
 * Режим живого бота: запустили один раз — отвечает сразу, пока не остановите.
 * Команды читаются длинным опросом, поиск вакансий идёт по таймеру.
 */

import { processInbox } from './inbox.js';
import { scanVacancies } from './scan.js';
import { sendMessage, setCommands } from './telegram.js';
import { createMailer } from './mailer.js';
import { effectiveConfig } from './settings.js';
import { homeScreen } from './menu.js';
import { BOT_COMMANDS } from './commands.js';

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
 * Объясняет пустой результат: на каком шаге всё отсеялось.
 * Без этого непонятно, фильтры слишком строгие или бот не работает.
 */
export function emptyResultText({ collected, matching, active }) {
  const filters = active?.filters ?? {};
  const lines = ['🔍 <b>Новых вакансий нет</b>', ''];

  if (collected === 0) {
    lines.push('Источники ничего не вернули по вашим запросам.');
    lines.push('Проверьте поисковые фразы — возможно, они слишком узкие.');
  } else if (matching === 0) {
    lines.push(`Источники дали ${collected} вакансий, но ни одна не прошла фильтры.`);
    lines.push('');
    const reasons = [];
    if (filters.minSalary > 0) reasons.push(`зарплата от ${filters.minSalary.toLocaleString('ru-RU')} ₽`);
    if ((filters.titleKeywords ?? []).length > 0) reasons.push(`слова в названии: ${filters.titleKeywords.join(', ')}`);
    if (filters.remoteOnly) reasons.push('только удалённо');
    if ((filters.schedules ?? []).length > 0) reasons.push(`график: ${filters.schedules.join(', ')}`);
    if (filters.maxExperienceYears !== null && filters.maxExperienceYears !== undefined) {
      reasons.push(`опыт до ${filters.maxExperienceYears} лет`);
    }
    if (reasons.length > 0) lines.push(`Сейчас отсекают: ${reasons.join('; ')}.`);
    lines.push('');
    lines.push('Ослабить — <code>/settings</code>');
  } else {
    lines.push('Всё подходящее уже присылал раньше — повторно не отправляю.');
  }

  return lines.join('\n');
}

export function failureText(failures) {
  const lines = ['⚠️ <b>Источник недоступен</b>', ''];
  for (const failure of failures.slice(0, 5)) {
    lines.push(`${failure.label}: ${failure.reason}`);
  }
  lines.push('', 'Остальные источники продолжают работать. Повторю при следующем поиске.');
  return lines.join('\n');
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

  // Чтобы не присылать «ничего не найдено» на каждый прогон, помним,
  // сообщали ли об этом в прошлый раз.
  let reportedEmpty = false;
  let reportedFailure = '';

  /** Настройки из чата перекрывают config.json, поэтому читаем их каждый раз. */
  const runScan = async ({ announce = true } = {}) => {
    const active = effectiveConfig(config, state);
    const result = await scan(state, statePath, active, { credentials, log });
    const { sent, failures, collected, matching, deferred } = result;

    if (sent.length > 0) {
      const withEmail = sent.filter((vacancy) => vacancy.email).length;
      log(`Отправлено вакансий: ${sent.length}, с адресом для отклика: ${withEmail}\n`);
      reportedEmpty = false;
    } else {
      log('Новых подходящих вакансий нет.\n');
      // Молчание неотличимо от «бот сломался», поэтому сообщаем — но один раз.
      if (announce && !reportedEmpty) {
        await sendMessage(emptyResultText({ collected, matching, active }), credentials).catch(() => {});
        reportedEmpty = true;
      }
    }

    // Сбой источника — это не «нет вакансий», о нём нужно знать отдельно.
    const failureKey = failures.map((f) => f.label).join('|');
    if (announce && failures.length > 0 && failureKey !== reportedFailure) {
      await sendMessage(failureText(failures), credentials).catch(() => {});
      reportedFailure = failureKey;
    } else if (failures.length === 0) {
      reportedFailure = '';
    }

    return { sent, deferred, matching };
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
        // Здесь отвечаем всегда: пользователь нажал и ждёт ответа.
        onPreview: async () => {
          lastScanAt = Date.now();
          reportedEmpty = false;
          try {
            await runScan();
          } catch (error) {
            log(`Поиск не удался: ${error.message}`);
            await sendMessage(`❌ Поиск не удался: ${error.message}`, credentials).catch(() => {});
          }
        },
        // /more — прислать следующую пачку из очереди, не дожидаясь таймера.
        onMore: async () => {
          reportedEmpty = false;
          try {
            const { sent, deferred } = await runScan();
            if (sent.length > 0 && deferred > 0) {
              await sendMessage(`В очереди осталось ${deferred}. Ещё — <code>/more</code>`, credentials).catch(() => {});
            }
          } catch (error) {
            await sendMessage(`❌ Поиск не удался: ${error.message}`, credentials).catch(() => {});
          }
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
/**
 * Регистрирует команды в интерфейсе Telegram. Ошибку глушим: без списка команд
 * бот работает, а падать из-за косметики при старте незачем.
 */
export async function registerCommands(credentials) {
  await setCommands(BOT_COMMANDS, credentials).catch(() => {});
}

export async function announceOnline(credentials, { scanIntervalMinutes, state = {} } = {}) {
  const home = homeScreen(state);
  const text = [
    '🟢 <b>Бот на связи</b>',
    `Отвечаю сразу. Новые вакансии проверяю каждые ${scanIntervalMinutes} мин.`,
    '',
    home.text,
  ].join('\n');

  // Сразу с кнопками: команды набирать не нужно.
  await sendMessage(text, { ...credentials, keyboard: home.keyboard });
}

export async function announceOffline(credentials) {
  await sendMessage('⚪️ <b>Бот выключен</b>\nКоманды снова заработают после запуска.', credentials);
}
