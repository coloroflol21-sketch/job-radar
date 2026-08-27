/** Обработка входящих команд и нажатий кнопок. */

import {
  getUpdates,
  confirmUpdates,
  extractCommands,
  extractCallbacks,
  lastUpdateId,
  sendMessage,
  editMessage,
  answerCallback,
} from './telegram.js';
import { parseCommand } from './commands.js';
import { handleCommands } from './handler.js';
import { applyCallback } from './menu.js';
import { saveState } from './state.js';

/** Отправляет ответ: строка — обычный текст, объект — текст с клавиатурой. */
async function reply(item, credentials) {
  if (typeof item === 'string') return sendMessage(item, credentials);
  return sendMessage(item.text, { ...credentials, keyboard: item.keyboard });
}

/**
 * Читает команды и нажатия, выполняет их и отвечает в чат.
 * state изменяется на месте и сохраняется по пути statePath.
 *
 * createTransport вызывается только если есть команда /apply: без откликов
 * настройки почты не нужны, и их отсутствие не должно мешать остальному.
 */
export async function processInbox(state, statePath, credentials, { createTransport, mail = {}, config = {}, fetchImpl = fetch, now = () => new Date(), timeout = 0, signal, onPreview } = {}) {
  const updates = await getUpdates({
    token: credentials.token,
    offset: (state.lastUpdateId ?? 0) + 1,
    timeout,
    signal,
    fetchImpl,
  });
  if (updates.length === 0) return [];

  const messages = extractCommands(updates, credentials.chatId);
  const callbacks = extractCallbacks(updates, credentials.chatId);
  const commands = messages.map((message) => parseCommand(message.text)).filter(Boolean);

  // Подтверждаем до выполнения: иначе упавшая на середине команда
  // повторится при следующем запуске и отклик уйдёт дважды.
  const highest = lastUpdateId(updates);
  state.lastUpdateId = highest;
  await saveState(statePath, state);
  await confirmUpdates({ token: credentials.token, lastUpdateId: highest, fetchImpl });

  const replies = [];

  // Нажатия кнопок: применяем настройку и перерисовываем меню на месте.
  for (const callback of callbacks) {
    const result = applyCallback(callback.data, config, state);
    await answerCallback(callback.id, { token: credentials.token, text: result.notice, fetchImpl });

    if (result.screen) {
      await editMessage(result.screen.text, {
        ...credentials,
        messageId: callback.messageId,
        keyboard: result.screen.keyboard,
        fetchImpl,
      });
      replies.push(result.notice || 'меню обновлено');
    }

    if (result.preview && onPreview) {
      await onPreview();
      replies.push('проверка выдачи');
    }
  }

  if (callbacks.length > 0) await saveState(statePath, state);
  if (commands.length === 0) return replies;

  let transport = null;
  if (commands.some((command) => command.type === 'apply')) {
    try {
      transport = createTransport();
    } catch (error) {
      const warning = `⚠️ Отправка почты не настроена: ${error.message}`;
      await sendMessage(warning, { ...credentials, fetchImpl });
      return [...replies, warning];
    }
  }

  const answers = await handleCommands(commands, state, {
    transport,
    from: mail.from,
    replyTo: mail.replyTo,
    now,
    config,
  });

  await saveState(statePath, state);
  for (const answer of answers) {
    await reply(answer, { ...credentials, fetchImpl });
  }

  return [...replies, ...answers];
}
