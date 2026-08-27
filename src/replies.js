/** Проверка почты на ответы работодателей и уведомление в чат. */

import { createClient, fetchReplies, formatReply } from './mailbox.js';
import { sendMessage } from './telegram.js';
import { saveState } from './state.js';

/**
 * Ищет новые ответы и присылает их в чат. Возвращает число найденных.
 *
 * Проверять почту незачем, если откликов не было: тогда и отвечать некому.
 * Сбой IMAP не должен ломать поиск вакансий, поэтому ошибка возвращается,
 * а не выбрасывается.
 */
export async function checkReplies(state, statePath, credentials, { makeClient = createClient, log = console.log } = {}) {
  const sentLog = state.sentLog ?? [];
  if (sentLog.length === 0) return { found: 0, error: null };

  let client;
  try {
    client = makeClient();
  } catch (error) {
    // Почта не настроена — это не сбой, откликов через бота тоже не было бы.
    return { found: 0, error: null };
  }

  try {
    state.seenReplies ??= [];
    const replies = await fetchReplies(sentLog, { client, seenIds: state.seenReplies });

    if (replies.length === 0) return { found: 0, error: null };

    log(`Найдено ответов работодателей: ${replies.length}`);
    for (const reply of replies) {
      await sendMessage(formatReply(reply), credentials);
      state.seenReplies.push(reply.id);
    }
    await saveState(statePath, state);

    return { found: replies.length, error: null };
  } catch (error) {
    log(`Не удалось проверить почту: ${error.message}`);
    return { found: 0, error };
  }
}
