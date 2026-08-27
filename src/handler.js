/** Исполнение разобранных команд: формирует ответы и отправляет отклики. */

import { findByCode, pruneCatalog } from './catalog.js';
import { HELP_TEXT, validateApply } from './commands.js';
import { sendApplication } from './mailer.js';
import { buildScreen } from './menu.js';
import { updateSetting } from './settings.js';

function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderList(catalog) {
  const entries = Object.entries(catalog).sort(
    (a, b) => Date.parse(b[1].addedAt ?? 0) - Date.parse(a[1].addedAt ?? 0),
  );
  if (entries.length === 0) return 'Каталог пуст. Вакансии появятся после следующего поиска.';

  const lines = ['<b>Доступно для отклика</b>', ''];
  for (const [code, entry] of entries.slice(0, 30)) {
    const mark = entry.email ? '' : ' — без email, только на сайте';
    lines.push(`<code>${code}</code> — ${escapeHtml(entry.title)}, ${escapeHtml(entry.company)}${mark}`);
  }
  lines.push('', 'Отклик: <code>/apply КОД</code> и текст письма с новой строки.');
  return lines.join('\n');
}

function renderPreview(catalog, code) {
  const entry = findByCode(catalog, code);
  if (!entry) return `Вакансия <code>${escapeHtml(code)}</code> не найдена. Список — <code>/list</code>`;

  const lines = [
    `<b>${escapeHtml(entry.title)}</b>`,
    `🏢 ${escapeHtml(entry.company)}`,
    entry.email ? `✉️ ${escapeHtml(entry.email)}` : '✉️ адрес не указан — откликнуться можно на сайте',
  ];
  if (entry.contactPerson) lines.push(`👤 ${escapeHtml(entry.contactPerson)}`);
  if (entry.url) lines.push(`<a href="${escapeHtml(entry.url)}">Открыть вакансию</a>`);
  if (entry.email) {
    lines.push('', `Отправить: <code>/apply ${entry.code ?? code}</code> и текст письма с новой строки.`);
  }
  return lines.join('\n');
}

function renderSent(sentLog) {
  if (sentLog.length === 0) return 'Откликов ещё не было.';

  const lines = ['<b>Отправленные отклики</b>', ''];
  for (const record of sentLog.slice(-20).reverse()) {
    const date = new Date(record.sentAt).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
    lines.push(`<code>${record.code}</code> ${escapeHtml(record.title)} — ${escapeHtml(record.email)}, ${date}`);
  }
  return lines.join('\n');
}

/**
 * Выполняет команды и возвращает ответы для отправки в чат.
 * state изменяется на месте: журнал откликов должен сохраниться
 * даже если следующая команда упадёт.
 */
export async function handleCommands(commands, state, { transport, from, replyTo, now = () => new Date(), config = {} } = {}) {
  const replies = [];
  state.catalog ??= {};
  state.sentLog ??= [];

  for (const command of commands) {
    switch (command.type) {
      case 'help':
        replies.push(HELP_TEXT);
        break;

      case 'list':
        replies.push(renderList(pruneCatalog(state.catalog, now())));
        break;

      case 'preview':
        replies.push(renderPreview(state.catalog, command.code));
        break;

      case 'sent':
        replies.push(renderSent(state.sentLog));
        break;

      case 'settings': {
        // Ответ с клавиатурой: отправитель разберётся, как его показать.
        const screen = buildScreen('main', config, state);
        replies.push({ text: screen.text, keyboard: screen.keyboard });
        break;
      }

      case 'keywords': {
        updateSetting(state, 'titleKeywords', command.words);
        replies.push(
          command.words.length > 0
            ? `🔍 Ключевые слова обновлены: <code>${escapeHtml(command.words.join(', '))}</code>\n\nТеперь в дайджест попадают вакансии, у которых одно из этих слов есть в названии.`
            : '🔍 Фильтр по ключевым словам убран — приходят все вакансии по вашим запросам.',
        );
        break;
      }

      case 'apply': {
        const entry = findByCode(state.catalog, command.code);
        const check = validateApply(command, entry, state.sentLog);
        if (!check.ok) {
          replies.push(`⚠️ ${check.reason}`);
          break;
        }

        try {
          const result = await sendApplication(entry, command.body, { transport, from, replyTo });
          state.sentLog.push({
            code: command.code,
            id: entry.id,
            title: entry.title,
            company: entry.company,
            email: entry.email,
            sentAt: now().toISOString(),
            messageId: result.messageId,
          });
          replies.push(
            `✅ Отклик отправлен: <b>${escapeHtml(entry.title)}</b>\n` +
              `${escapeHtml(entry.company)} → ${escapeHtml(entry.email)}`,
          );
        } catch (error) {
          replies.push(`❌ Отклик не отправлен: ${escapeHtml(error.message)}\nПопробуйте ещё раз.`);
        }
        break;
      }

      case 'unknown':
        replies.push(`Не знаю команду <code>/${escapeHtml(command.name)}</code>. Справка — <code>/help</code>`);
        break;
    }
  }

  return replies;
}
