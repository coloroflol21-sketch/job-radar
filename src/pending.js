/**
 * Ожидания с ограниченным сроком: текст письма и подтверждение отправки.
 *
 * Срок обязателен. Без него сообщение «спасибо, посмотрю позже», написанное
 * через час после нажатия «Откликнуться», уходило работодателю как письмо.
 */

/** Успеть написать письмо — минут. Дольше человек уже занят другим. */
export const LETTER_TTL_MINUTES = 15;

/** Подтвердить готовое письмо — минут. Здесь достаточно короткого срока. */
export const CONFIRM_TTL_MINUTES = 10;

function isFresh(record, ttlMinutes, now) {
  const at = Date.parse(record?.askedAt ?? record?.preparedAt ?? '');
  if (Number.isNaN(at)) return false;
  return now.getTime() - at <= ttlMinutes * 60_000;
}

/**
 * Действующее ожидание письма либо null, если срок вышел.
 * Просроченное ожидание снимается, чтобы текст не стал письмом задним числом.
 */
export function takeAwaitingLetter(state, now = new Date()) {
  const waiting = state.awaitingLetter;
  if (!waiting) return null;

  state.awaitingLetter = null;
  if (!isFresh(waiting, LETTER_TTL_MINUTES, now)) {
    return { expired: true, code: waiting.code };
  }
  return { expired: false, code: waiting.code };
}

/** То же для подтверждения отправки. */
export function takePendingApply(state, code, now = new Date()) {
  const pending = state.pendingApply;
  state.pendingApply = null;

  if (!pending) return { missing: true };
  if (pending.code !== code) return { missing: true };
  if (!isFresh(pending, CONFIRM_TTL_MINUTES, now)) return { expired: true };
  return { pending };
}

export function expiredLetterText(code) {
  return [
    '⌛ <b>Время на письмо истекло</b>',
    '',
    `Прошло больше ${LETTER_TTL_MINUTES} минут с нажатия «Откликнуться», поэтому это сообщение`,
    'я не считаю письмом — иначе случайный текст ушёл бы работодателю.',
    '',
    `Начать заново: <code>/apply ${code}</code> или кнопка под вакансией.`,
  ].join('\n');
}

export function expiredConfirmText(code) {
  return [
    '⌛ <b>Подтверждение устарело</b>',
    '',
    `Письмо было готово больше ${CONFIRM_TTL_MINUTES} минут назад и не отправлено.`,
    `Подготовьте заново: <code>/apply ${code}</code>`,
  ].join('\n');
}
