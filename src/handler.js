/** Исполнение разобранных команд: формирует ответы и отправляет отклики. */

import { findByCode, pruneCatalog } from './catalog.js';
import { HELP_TEXT, validateApply } from './commands.js';
import { sendApplication } from './mailer.js';
import { buildScreen, homeScreen } from './menu.js';
import { updateSetting } from './settings.js';
import { escapeHtml, renderVacancy, renderSaved, renderStats } from './views.js';
import { takePendingApply, expiredConfirmText } from './pending.js';

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

/** Показывает письмо перед отправкой: адрес, тема и текст целиком. */
function renderConfirmation(entry, body) {
  return [
    '📧 <b>Проверьте письмо перед отправкой</b>',
    '',
    `<b>Кому:</b> ${escapeHtml(entry.email)}`,
    `<b>Компания:</b> ${escapeHtml(entry.company)}`,
    `<b>Вакансия:</b> ${escapeHtml(entry.title)}`,
    '',
    '<b>Текст письма:</b>',
    escapeHtml(body.length > 600 ? `${body.slice(0, 600)}…` : body),
    '',
    'Отправить письмо с вашего адреса?',
  ].join('\n');
}

/**
 * Выполняет отложенную отправку после подтверждения кнопкой.
 * Возвращает текст ответа; state изменяется на месте.
 */
export async function confirmApply(code, state, { transport, from, replyTo, now = () => new Date() } = {}) {
  const taken = takePendingApply(state, code, now());

  if (taken.missing) {
    return '⚠️ Нечего подтверждать — подготовьте отклик заново командой <code>/apply КОД</code>';
  }
  // Устаревшее подтверждение не исполняем: человек мог давно забыть, о чём речь.
  if (taken.expired) return expiredConfirmText(code);
  const { pending } = taken;

  const entry = findByCode(state.catalog, code);
  const check = validateApply({ code, body: pending.body }, entry, state.sentLog);
  if (!check.ok) return `⚠️ ${check.reason}`;

  if (!transport) return '⚠️ Отправка почты не настроена: нужны SMTP_USER и SMTP_PASSWORD';

  try {
    const result = await sendApplication(entry, pending.body, { transport, from, replyTo });
    state.sentLog ??= [];
    state.sentLog.push({
      code,
      id: entry.id,
      title: entry.title,
      company: entry.company,
      email: entry.email,
      sentAt: now().toISOString(),
      messageId: result.messageId,
    });
    return `✅ Отклик отправлен: <b>${escapeHtml(entry.title)}</b>\n${escapeHtml(entry.company)} → ${escapeHtml(entry.email)}`;
  } catch (error) {
    return `❌ Отклик не отправлен: ${escapeHtml(error.message)}\nПопробуйте ещё раз командой <code>/apply ${code}</code>`;
  }
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

      case 'list': {
        // Избранное и вакансии с откликом чистка не трогает: к ним ещё вернутся.
        const keepCodes = [...(state.saved ?? []), ...(state.sentLog ?? []).map((r) => r.code)];
        replies.push(renderList(pruneCatalog(state.catalog, now(), { keepCodes })));
        break;
      }

      case 'preview':
        replies.push(renderPreview(state.catalog, command.code));
        break;

      case 'sent':
        replies.push(renderSent(state.sentLog));
        break;

      case 'show': {
        const entry = findByCode(state.catalog, command.code);
        replies.push(
          entry
            ? renderVacancy(entry, command.code, { now: now() })
            : `Вакансия <code>${escapeHtml(command.code)}</code> не найдена. Список — <code>/list</code>`,
        );
        break;
      }

      case 'save': {
        state.saved ??= [];
        const entry = findByCode(state.catalog, command.code);
        if (!entry) {
          replies.push(`Вакансия <code>${escapeHtml(command.code)}</code> не найдена.`);
        } else if (state.saved.includes(command.code)) {
          replies.push(`Уже в избранном. Список — <code>/saved</code>`);
        } else {
          state.saved.push(command.code);
          replies.push(`⭐ <b>${escapeHtml(entry.title)}</b> в избранном.\nСписок — <code>/saved</code>`);
        }
        break;
      }

      case 'saved':
        replies.push(renderSaved(state.catalog, state.saved ?? [], { now: now() }));
        break;

      case 'stats':
        replies.push(renderStats(state.catalog, { now: now() }));
        break;

      case 'more':
        // Очередь наполняет поиск, отдаёт её отправитель: здесь только сигнал.
        replies.push({ more: true });
        break;

      case 'settings': {
        // Ответ с клавиатурой: отправитель разберётся, как его показать.
        const screen = buildScreen('main', config, state);
        replies.push({ text: screen.text, keyboard: screen.keyboard });
        break;
      }

      case 'menu': {
        const screen = homeScreen(state);
        replies.push({ text: screen.text, keyboard: screen.keyboard });
        break;
      }

      case 'cancel': {
        const hadLetter = Boolean(state.awaitingLetter);
        const hadPending = Boolean(state.pendingApply);
        state.awaitingLetter = null;
        state.pendingApply = null;
        replies.push(
          hadLetter || hadPending
            ? '✖️ Отменено. Письмо не отправлено, ваши сообщения снова обычный текст.'
            : 'Нечего отменять.',
        );
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

        // Отправка письма необратима, поэтому сначала показываем, что уйдёт,
        // и ждём подтверждения кнопкой.
        state.pendingApply = {
          code: command.code,
          body: command.body,
          preparedAt: now().toISOString(),
        };
        replies.push({
          text: renderConfirmation(entry, command.body),
          keyboard: [[
            { text: '✅ Отправить', callback_data: `apply:yes:${command.code}` },
            { text: '✖️ Отменить', callback_data: 'apply:no:0' },
          ]],
        });
        break;
      }

      case 'unknown':
        replies.push(`Не знаю команду <code>/${escapeHtml(command.name)}</code>. Справка — <code>/help</code>`);
        break;
    }
  }

  return replies;
}
