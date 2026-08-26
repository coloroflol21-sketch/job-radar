/** Отправка сообщений в Telegram Bot API. */

const TELEGRAM_LIMIT = 4096;

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

export function formatVacancy(vacancy, index) {
  const label = vacancy.code ? `<code>${escapeHtml(vacancy.code)}</code> ` : `${index}. `;
  const lines = [
    `${label}<b>${escapeHtml(vacancy.title)}</b>`,
    `🏢 ${escapeHtml(vacancy.company)}`,
    `💰 ${escapeHtml(formatSalary(vacancy))}`,
  ];
  if (vacancy.region) lines.push(`📍 ${escapeHtml(vacancy.region)}`);
  if (vacancy.experienceYears) lines.push(`🎓 опыт от ${vacancy.experienceYears} лет`);
  if (vacancy.schedule) lines.push(`🕒 ${escapeHtml(vacancy.schedule)}`);
  if (vacancy.url) lines.push(`<a href="${escapeHtml(vacancy.url)}">Открыть вакансию</a>`);
  if (vacancy.code && vacancy.email) lines.push(`✍️ отклик: <code>/apply ${escapeHtml(vacancy.code)}</code>`);
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

export async function sendMessage(text, { token, chatId, fetchImpl = fetch } = {}) {
  if (!token || !chatId) throw new Error('Не заданы TELEGRAM_BOT_TOKEN или TELEGRAM_CHAT_ID');

  const response = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });

  const payload = await response.json();
  if (!payload.ok) throw new Error(`Telegram: ${payload.description ?? response.status}`);
  return payload;
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
    allowed_updates: JSON.stringify(['message']),
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
