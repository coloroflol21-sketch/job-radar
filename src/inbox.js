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
  askForReply,
} from './telegram.js';
import { parseCommand } from './commands.js';
import { handleCommands, confirmApply } from './handler.js';
import { applyCallback, homeScreen } from './menu.js';
import { findByCode } from './catalog.js';
import { saveState } from './state.js';

/** Отправляет ответ: строка — обычный текст, объект — текст с клавиатурой. */
async function reply(item, credentials) {
  if (typeof item === 'string') return sendMessage(item, credentials);
  return sendMessage(item.text, { ...credentials, keyboard: item.keyboard });
}

/** Раздел главного меню — то же, что соответствующая команда. */
async function runSection(section, state, { config, onMore, now }) {
  if (section === 'more') {
    if (onMore) await onMore();
    return null;
  }
  if (section === 'home') return homeScreen(state);

  const map = { list: '/list', saved: '/saved', stats: '/stats', sent: '/sent', help: '/help' };
  const command = parseCommand(map[section] ?? '/help');
  const [answer] = await handleCommands([command], state, { config, now });
  return answer;
}

/**
 * Действие по вакансии из кнопки под сообщением.
 * Для отклика открывается поле ввода: текст письма пишет пользователь.
 */
async function runVacancyAction(action, code, state, { credentials, fetchImpl, now }) {
  if (action === 'apply') {
    const entry = findByCode(state.catalog ?? {}, code);
    if (!entry) return `Вакансия ${code} не найдена.`;
    if (!entry.email) return `У вакансии ${code} нет адреса — откликнуться можно только на сайте.`;

    // Запоминаем, на что отвечаем: следующее сообщение станет текстом письма.
    state.awaitingLetter = { code, askedAt: new Date().toISOString() };
    await askForReply(
      [
        `✍️ <b>Отклик на «${entry.title}»</b>`,
        `Компания: ${entry.company}`,
        '',
        'Напишите текст письма ответом на это сообщение.',
        'Перед отправкой я покажу письмо и спрошу подтверждение.',
      ].join('\n'),
      { ...credentials, fetchImpl },
    );
    return null;
  }

  const command = parseCommand(`/${action} ${code}`);
  const [answer] = await handleCommands([command], state, { now });
  return answer;
}

/**
 * Читает команды и нажатия, выполняет их и отвечает в чат.
 * state изменяется на месте и сохраняется по пути statePath.
 *
 * createTransport вызывается только если есть команда /apply: без откликов
 * настройки почты не нужны, и их отсутствие не должно мешать остальному.
 */
export async function processInbox(state, statePath, credentials, { createTransport = () => null, mail = {}, config = {}, fetchImpl = fetch, now = () => new Date(), timeout = 0, signal, onPreview, onMore } = {}) {
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

  // Если бот ждёт текст письма, первое сообщение без слеша — это письмо,
  // а не команда: пользователь нажал «Откликнуться» и пишет ответ.
  const commands = [];
  for (const message of messages) {
    const waiting = state.awaitingLetter;
    if (waiting && !message.text.trim().startsWith('/')) {
      state.awaitingLetter = null;
      commands.push({ type: 'apply', code: waiting.code, body: message.text.trim() });
      continue;
    }
    const command = parseCommand(message.text);
    if (command) commands.push(command);
  }

  // Подтверждаем до выполнения: иначе упавшая на середине команда
  // повторится при следующем запуске и отклик уйдёт дважды.
  const highest = lastUpdateId(updates);
  state.lastUpdateId = highest;
  await saveState(statePath, state);
  await confirmUpdates({ token: credentials.token, lastUpdateId: highest, fetchImpl });

  const replies = [];

  // Нажатия кнопок: подтверждение отклика либо настройка с перерисовкой меню.
  for (const callback of callbacks) {
    const [action, decision, code] = callback.data.split(':');

    // Переходы по разделам: новое сообщение, чтобы не терять список вакансий.
    if (action === 'go') {
      await answerCallback(callback.id, { token: credentials.token, text: '', fetchImpl });
      const answer = await runSection(decision, state, { config, onMore, now });
      if (answer) {
        await reply(answer, { ...credentials, fetchImpl });
        replies.push(typeof answer === 'string' ? answer : answer.text);
      }
      await saveState(statePath, state);
      continue;
    }

    // Кнопки под вакансией: отклик, описание, избранное.
    if (action === 'act' && ['apply', 'show', 'save'].includes(decision)) {
      await answerCallback(callback.id, { token: credentials.token, text: '', fetchImpl });
      const answer = await runVacancyAction(decision, code, state, { credentials, fetchImpl, now });
      if (answer) {
        await reply(answer, { ...credentials, fetchImpl });
        replies.push(typeof answer === 'string' ? answer : answer.text);
      }
      await saveState(statePath, state);
      continue;
    }

    if (action === 'apply') {
      await answerCallback(callback.id, { token: credentials.token, text: '', fetchImpl });

      if (decision === 'no') {
        state.pendingApply = null;
        await editMessage('✖️ Отклик отменён, письмо не отправлено.', {
          ...credentials,
          messageId: callback.messageId,
          fetchImpl,
        });
        replies.push('отклик отменён');
      } else {
        // Транспорт создаём только здесь: до подтверждения почта не нужна.
        let transport = null;
        try {
          transport = createTransport();
        } catch {
          transport = null;
        }
        const answer = await confirmApply(code, state, {
          transport,
          from: mail.from,
          replyTo: mail.replyTo,
          now,
        });
        await editMessage(answer, { ...credentials, messageId: callback.messageId, fetchImpl });
        replies.push(answer);
      }

      await saveState(statePath, state);
      continue;
    }

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

  // Проверяем настройки почты заранее: лучше сказать сразу, чем показать
  // письмо, дать нажать «Отправить» и только потом сообщить о проблеме.
  if (commands.some((command) => command.type === 'apply')) {
    try {
      createTransport();
    } catch (error) {
      const warning = `⚠️ Отправка почты не настроена: ${error.message}`;
      await sendMessage(warning, { ...credentials, fetchImpl });
      return [...replies, warning];
    }
  }

  const answers = await handleCommands(commands, state, {
    from: mail.from,
    replyTo: mail.replyTo,
    now,
    config,
  });

  await saveState(statePath, state);
  for (const answer of answers) {
    // /more обслуживает вызывающий: у него есть доступ к очереди и поиску.
    if (answer?.more) {
      if (onMore) await onMore();
      continue;
    }
    await reply(answer, { ...credentials, fetchImpl });
  }

  return [...replies, ...answers];
}
