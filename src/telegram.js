/** Отправка сообщений в Telegram Bot API. */

const TELEGRAM_LIMIT = 4096;

/** Пауза между сообщениями в одном чате: Telegram пропускает примерно одно в секунду. */
const CARD_INTERVAL_MS = 1100;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function formatSalary(vacancy) {
  const { salaryMin: min, salaryMax: max } = vacancy;
  if (!min && !max) return 'не указана';
  const money = (value) => `${value.toLocaleString('ru-RU')} ₽`;
  if (min && max && min !== max) return `${money(min)} – ${money(max)}`;
  return min ? `от ${money(min)}` : `до ${money(max)}`;
}

/**
 * withHints=false — когда под сообщением есть кнопки: текстовые подсказки
 * вида «/apply A1» тогда лишние.
 */
export function formatVacancy(vacancy, index, { withHints = true } = {}) {
  const label = vacancy.code ? `<code>${escapeHtml(vacancy.code)}</code> ` : `${index}. `;
  const lines = [
    `${label}<b>${escapeHtml(vacancy.title)}</b>`,
    `🏢 ${escapeHtml(vacancy.company)}`,
    `💰 ${escapeHtml(formatSalary(vacancy))}`,
  ];
  if (vacancy.region) lines.push(`📍 ${escapeHtml(vacancy.region)}`);
  if (vacancy.experienceYears) lines.push(`🎓 опыт от ${vacancy.experienceYears} лет`);
  if (vacancy.schedule) lines.push(`🕒 ${escapeHtml(vacancy.schedule)}`);
  if (vacancy.employment) lines.push(`🏠 ${escapeHtml(vacancy.employment)}`);

  if (!withHints) return lines.join('\n');

  if (vacancy.url) lines.push(`<a href="${escapeHtml(vacancy.url)}">Открыть вакансию</a>`);
  if (vacancy.code && vacancy.email) {
    lines.push(`✍️ отклик: <code>/apply ${escapeHtml(vacancy.code)}</code>`);
  } else if (vacancy.url) {
    // У источников без контактов откликнуться можно только на их сайте.
    lines.push('✍️ отклик — на сайте вакансии');
  }

  return lines.join('\n');
}

/** Собирает дайджест и режет его на части, которые влезают в лимит Telegram. */
export function buildDigest(vacancies) {
  const header = `🎯 <b>Новые вакансии: ${vacancies.length}</b>`;
  const blocks = vacancies.map((vacancy, i) => formatVacancy(vacancy, i + 1));

  const messages = [];
  let current = header;

  for (const block of blocks) {
    const candidate = `${current}\n\n${block}`;
    if (candidate.length > TELEGRAM_LIMIT) {
      messages.push(current);
      current = block;
    } else {
      current = candidate;
    }
  }
  messages.push(current);

  return messages;
}

/**
 * Кнопки действий под вакансией: отклик, описание, избранное.
 * Так не нужно набирать «/apply A1» руками.
 */
export function vacancyKeyboard(vacancy) {
  const row = [];
  if (vacancy.email) row.push({ text: '✍️ Откликнуться', callback_data: `act:apply:${vacancy.code}` });
  row.push({ text: '📄 Подробнее', callback_data: `act:show:${vacancy.code}` });

  const second = [{ text: '⭐ В избранное', callback_data: `act:save:${vacancy.code}` }];
  if (vacancy.url) second.push({ text: '🔗 На сайте', url: vacancy.url });

  return [row, second];
}

/**
 * Каждая вакансия — отдельное сообщение со своими кнопками.
 * Слить их в один дайджест нельзя: кнопки привязаны к сообщению, а не к строке.
 */
export async function sendVacancyCards(vacancies, credentials, { sleep = defaultSleep } = {}) {
  await sendMessage(`🎯 <b>Новые вакансии: ${vacancies.length}</b>`, credentials);

  const delivered = [];
  for (const vacancy of vacancies) {
    try {
      await sendMessage(formatVacancy(vacancy, 0, { withHints: false }), {
        ...credentials,
        keyboard: vacancyKeyboard(vacancy),
        sleep,
      });
      delivered.push(vacancy);
    } catch (error) {
      // Возвращаем дошедшие: недоставленные не должны попасть в «отправленные»,
      // иначе пользователь не увидит их уже никогда.
      return { delivered, error };
    }
    // Пауза между карточками, чтобы не упираться в ограничение частоты.
    if (vacancy !== vacancies.at(-1)) await sleep(CARD_INTERVAL_MS);
  }

  return { delivered, error: null };
}

/**
 * Отправляет сообщение, переживая ограничение частоты.
 *
 * Telegram при потоке в один чат пропускает примерно одно сообщение в секунду
 * и отвечает 429 с полем retry_after. Дайджест карточками — это 13 сообщений
 * подряд, поэтому без повтора часть вакансий просто не дошла бы.
 */
export async function sendMessage(text, { token, chatId, keyboard, fetchImpl = fetch, retries = 4, sleep = defaultSleep } = {}) {
  if (!token || !chatId) throw new Error('Не заданы TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID');

  const body = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };

  let lastDescription = '';
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const payload = await response.json();
    if (payload.ok) return payload;

    lastDescription = payload.description ?? String(response.status);
    const retryAfter = payload.parameters?.retry_after;

    // Ждём столько, сколько просит Telegram, иначе повтор снова упрётся в лимит.
    if (retryAfter !== undefined && attempt < retries) {
      await sleep((retryAfter + 1) * 1000);
      continue;
    }
    // Прочие ошибки (неверный чат, битая разметка) повторять бессмысленно.
    break;
  }

  throw new Error(`Telegram: ${lastDescription}`);
}

/**
 * Перерисовывает уже отправленное сообщение — так меню меняется на месте,
 * без новых сообщений в чате на каждое нажатие.
 */
export async function editMessage(text, { token, chatId, messageId, keyboard, fetchImpl = fetch } = {}) {
  const body = {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  };
  if (keyboard) body.reply_markup = { inline_keyboard: keyboard };

  const response = await fetchImpl(`https://api.telegram.org/bot${token}/editMessageText`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  const payload = await response.json();
  // Нажатие на уже выбранный вариант не меняет текст — Telegram отвечает
  // ошибкой «message is not modified», и это не сбой.
  if (!payload.ok && !/message is not modified/i.test(payload.description ?? '')) {
    throw new Error(`Telegram: ${payload.description ?? response.status}`);
  }
  return payload;
}

/**
 * Регистрирует команды в интерфейсе Telegram: они появляются в меню рядом
 * с полем ввода и в подсказке при наборе «/». Иначе про команды надо знать заранее.
 */
export async function setCommands(commands, { token, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`https://api.telegram.org/bot${token}/setMyCommands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ commands }),
  });
  return response.json();
}

/**
 * Просит написать текст: Telegram сам открывает поле ответа, как будто нажали
 * «Ответить». Так письмо и ключевые слова вводятся без набора команды.
 */
export async function askForReply(text, { token, chatId, fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      reply_markup: { force_reply: true, input_field_placeholder: 'Напишите текст здесь' },
    }),
  });
  const payload = await response.json();
  if (!payload.ok) throw new Error(`Telegram: ${payload.description ?? response.status}`);
  return payload;
}

/**
 * Гасит «часики» на кнопке. Telegram требует ответить на каждый callback,
 * иначе клиент показывает загрузку до таймаута.
 */
export async function answerCallback(callbackId, { token, text = '', fetchImpl = fetch } = {}) {
  const response = await fetchImpl(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackId, text }),
  });
  return response.json();
}

export async function sendDigest(vacancies, credentials) {
  for (const message of buildDigest(vacancies)) {
    await sendMessage(message, credentials);
  }
}

/**
 * Забирает накопившиеся сообщения (long-polling).
 * Telegram держит непрочитанное 24 часа, поэтому команды не теряются
 * между запусками по расписанию. Webhook при этом должен быть не установлен:
 * getUpdates и webhook взаимоисключающие.
 */
export async function getUpdates({ token, offset = 0, timeout = 0, signal, fetchImpl = fetch } = {}) {
  if (!token) throw new Error('Не задан TELEGRAM_BOT_TOKEN');

  const params = new URLSearchParams({
    offset: String(offset),
    // timeout > 0 — длинный опрос: Telegram держит ответ, пока не придёт сообщение.
    timeout: String(timeout),
    allowed_updates: JSON.stringify(['message', 'callback_query']),
  });

  const response = await fetchImpl(`https://api.telegram.org/bot${token}/getUpdates?${params}`, { signal });
  const payload = await response.json();
  if (!payload.ok) throw new Error(`Telegram: ${payload.description ?? response.status}`);
  return payload.result ?? [];
}

/**
 * Подтверждает обработку апдейтов: смещение выше последнего update_id
 * заставляет Telegram забыть их и не присылать снова.
 */
export async function confirmUpdates({ token, lastUpdateId, fetchImpl = fetch } = {}) {
  if (!lastUpdateId) return;
  await getUpdates({ token, offset: lastUpdateId + 1, fetchImpl });
}

/**
 * Отбирает сообщения только из своего чата: бот может получить апдейт
 * от любого, кто его найдёт, а команды дают доступ к отправке почты.
 */
export function extractCommands(updates, allowedChatId) {
  const allowed = String(allowedChatId);
  const messages = [];

  for (const update of updates) {
    const message = update.message;
    const chatId = message?.chat?.id;
    const text = message?.text;
    if (!text || String(chatId) !== allowed) continue;
    messages.push({ text, updateId: update.update_id, from: message.from?.username ?? '' });
  }

  return messages;
}

export function lastUpdateId(updates) {
  return updates.reduce((max, update) => Math.max(max, update.update_id ?? 0), 0);
}

/**
 * Отбирает нажатия кнопок — тоже только из своего чата.
 * Нажать кнопку в пересланном сообщении может посторонний.
 */
export function extractCallbacks(updates, allowedChatId) {
  const allowed = String(allowedChatId);
  const callbacks = [];

  for (const update of updates) {
    const query = update.callback_query;
    const chatId = query?.message?.chat?.id;
    if (!query?.data || String(chatId) !== allowed) continue;
    callbacks.push({
      id: query.id,
      data: query.data,
      messageId: query.message.message_id,
      updateId: update.update_id,
    });
  }

  return callbacks;
}
