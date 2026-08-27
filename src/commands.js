/**
 * Разбор команд, которые пользователь пишет боту.
 * Ответ приходит следующим запуском по расписанию, поэтому команды
 * самодостаточны: письмо целиком передаётся одним сообщением.
 */

import { normalizeCode } from './catalog.js';

/** Команды для меню Telegram: показываются рядом с полем ввода. */
export const BOT_COMMANDS = [
  { command: 'menu', description: 'Главное меню' },
  { command: 'list', description: 'Вакансии для отклика' },
  { command: 'settings', description: 'Настройки поиска' },
  { command: 'saved', description: 'Избранное' },
  { command: 'stats', description: 'Сводка по рынку' },
  { command: 'more', description: 'Прислать ещё вакансий' },
  { command: 'sent', description: 'Отправленные отклики' },
  { command: 'keywords', description: 'Ключевые слова в названии' },
  { command: 'help', description: 'Справка' },
];

export const HELP_TEXT = [
  '<b>Job Radar — команды</b>',
  '',
  '<b>Поиск</b>',
  '<code>/settings</code> — настройки кнопками',
  '<code>/keywords поддержк, helpdesk</code> — слова в названии',
  '<code>/more</code> — прислать ещё из очереди',
  '<code>/stats</code> — сводка по рынку',
  '',
  '<b>Вакансии</b>',
  '<code>/list</code> — что доступно для отклика',
  '<code>/show A1</code> — описание вакансии целиком',
  '<code>/preview A1</code> — куда уйдёт отклик',
  '<code>/save A1</code> — в избранное, <code>/saved</code> — список',
  '',
  '<b>Отклик</b>',
  '<code>/apply A1</code> и текст письма со второй строки.',
  'Бот покажет письмо и спросит подтверждение кнопкой.',
  '<code>/sent</code> — история отправленных',
  '',
  'В режиме живого бота ответ приходит сразу, при запуске по расписанию —',
  'при следующем прогоне.',
].join('\n');

/**
 * Разбирает одно сообщение в команду.
 * Возвращает null, если это не команда (обычный текст игнорируется).
 */
export function parseCommand(text) {
  const trimmed = String(text ?? '').trim();
  if (!trimmed.startsWith('/')) return null;

  // Первая строка — команда с аргументом, остальное — тело письма.
  const lineBreak = trimmed.indexOf('\n');
  const head = (lineBreak === -1 ? trimmed : trimmed.slice(0, lineBreak)).trim();
  const body = lineBreak === -1 ? '' : trimmed.slice(lineBreak + 1).trim();

  // Telegram дописывает @имя_бота в группах.
  const [rawName, ...args] = head.split(/\s+/);
  const name = rawName.replace(/@\w+$/, '').slice(1).toLowerCase();

  switch (name) {
    case 'start':
    case 'help':
      return { type: 'help' };
    case 'list':
      return { type: 'list' };
    case 'sent':
      return { type: 'sent' };
    case 'settings':
      return { type: 'settings' };
    case 'menu':
      return { type: 'menu' };
    case 'cancel':
      return { type: 'cancel' };
    case 'keywords':
      // Слова перечисляются через запятую в той же строке.
      return {
        type: 'keywords',
        words: args
          .join(' ')
          .split(',')
          .map((word) => word.trim().toLowerCase())
          .filter(Boolean),
      };
    case 'preview':
      return { type: 'preview', code: normalizeCode(args[0]) };
    case 'show':
      return { type: 'show', code: normalizeCode(args[0]) };
    case 'save':
      return { type: 'save', code: normalizeCode(args[0]) };
    case 'saved':
      return { type: 'saved' };
    case 'more':
      return { type: 'more' };
    case 'stats':
      return { type: 'stats' };
    case 'apply':
      return { type: 'apply', code: normalizeCode(args[0]), body };
    default:
      return { type: 'unknown', name };
  }
}

/** Проверяет, что команду можно выполнить, до любых сетевых действий. */
export function validateApply(command, entry, sentLog = []) {
  if (!command.code) {
    return { ok: false, reason: 'Не указан код вакансии. Пример: <code>/apply A1</code>' };
  }
  if (!entry) {
    return {
      ok: false,
      reason: `Вакансия с кодом <code>${command.code}</code> не найдена. Актуальные коды — <code>/list</code>`,
    };
  }
  if (!entry.email) {
    return {
      ok: false,
      reason: `У вакансии <code>${command.code}</code> не указан email. Откликнуться можно на сайте: ${entry.url}`,
    };
  }
  if (!command.body) {
    return {
      ok: false,
      reason: 'Письмо пустое. Текст отклика пишется со второй строки того же сообщения.',
    };
  }
  if (command.body.length < 30) {
    return {
      ok: false,
      reason: 'Письмо короче 30 символов. Такой отклик выглядит как спам — напишите подробнее.',
    };
  }
  if (sentLog.some((record) => record.code === command.code)) {
    return { ok: false, reason: `На вакансию <code>${command.code}</code> отклик уже отправлен.` };
  }
  return { ok: true };
}
