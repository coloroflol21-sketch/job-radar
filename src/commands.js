/**
 * Разбор команд, которые пользователь пишет боту.
 * Ответ приходит следующим запуском по расписанию, поэтому команды
 * самодостаточны: письмо целиком передаётся одним сообщением.
 */

import { normalizeCode } from './catalog.js';

export const HELP_TEXT = [
  '<b>Job Radar — команды</b>',
  '',
  '<code>/list</code> — вакансии, доступные для отклика',
  '<code>/preview A1</code> — контакты и адрес отклика',
  '<code>/apply A1</code> + текст письма с новой строки — отправить отклик',
  '<code>/sent</code> — история отправленных откликов',
  '<code>/help</code> — эта справка',
  '',
  'Пример отклика:',
  '<code>/apply A1</code>',
  '<code>Здравствуйте! Заинтересовала вакансия...</code>',
  '',
  'Ответ приходит при следующем запуске по расписанию, обычно в пределах часа.',
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
    case 'preview':
      return { type: 'preview', code: normalizeCode(args[0]) };
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
