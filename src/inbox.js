/** Обработка входящих команд из чата. */

import { getUpdates, confirmUpdates, extractCommands, lastUpdateId, sendMessage } from './telegram.js';
import { parseCommand } from './commands.js';
import { handleCommands } from './handler.js';
import { saveState } from './state.js';

/**
 * Читает команды, выполняет их и отвечает в чат.
 * state изменяется на месте и сохраняется по пути statePath.
 *
 * createTransport вызывается только если есть команда /apply: без откликов
 * настройки почты не нужны, и их отсутствие не должно мешать остальному.
 */
export async function processInbox(state, statePath, credentials, { createTransport, mail = {}, fetchImpl = fetch, now = () => new Date() } = {}) {
  const updates = await getUpdates({
    token: credentials.token,
    offset: (state.lastUpdateId ?? 0) + 1,
    fetchImpl,
  });
  if (updates.length === 0) return [];

  const messages = extractCommands(updates, credentials.chatId);
  const commands = messages.map((message) => parseCommand(message.text)).filter(Boolean);

  // Подтверждаем до выполнения: иначе упавшая на середине команда
  // повторится при следующем запуске и отклик уйдёт дважды.
  const highest = lastUpdateId(updates);
  state.lastUpdateId = highest;
  await saveState(statePath, state);
  await confirmUpdates({ token: credentials.token, lastUpdateId: highest, fetchImpl });

  if (commands.length === 0) return [];

  let transport = null;
  if (commands.some((command) => command.type === 'apply')) {
    try {
      transport = createTransport();
    } catch (error) {
      const warning = `⚠️ Отправка почты не настроена: ${error.message}`;
      await sendMessage(warning, { ...credentials, fetchImpl });
      return [warning];
    }
  }

  const replies = await handleCommands(commands, state, {
    transport,
    from: mail.from,
    replyTo: mail.replyTo,
    now,
  });

  await saveState(statePath, state);
  for (const reply of replies) {
    await sendMessage(reply, { ...credentials, fetchImpl });
  }

  return replies;
}
