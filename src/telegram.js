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
  const lines = [
    `<b>${index}. ${escapeHtml(vacancy.title)}</b>`,
    `🏢 ${escapeHtml(vacancy.company)}`,
    `💰 ${escapeHtml(formatSalary(vacancy))}`,
  ];
  if (vacancy.region) lines.push(`📍 ${escapeHtml(vacancy.region)}`);
  if (vacancy.experienceYears) lines.push(`🎓 опыт от ${vacancy.experienceYears} лет`);
  if (vacancy.schedule) lines.push(`🕒 ${escapeHtml(vacancy.schedule)}`);
  if (vacancy.url) lines.push(`<a href="${escapeHtml(vacancy.url)}">Открыть вакансию</a>`);
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
