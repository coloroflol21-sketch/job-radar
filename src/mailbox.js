/**
 * Чтение ответов работодателей по IMAP.
 *
 * Ответ связывается с откликом по заголовку In-Reply-To: он ссылается
 * на messageId письма, который мы сохранили в журнале при отправке.
 */

import { ImapFlow } from 'imapflow';

/** Гугл иногда кладёт письма от незнакомых отправителей в спам. */
const FOLDERS = ['INBOX', '[Gmail]/Spam'];

export function createClient(env = process.env, { ClientImpl = ImapFlow } = {}) {
  const user = env.SMTP_USER;
  const pass = env.SMTP_PASSWORD;
  if (!user || !pass) throw new Error('Не заданы SMTP_USER или SMTP_PASSWORD');

  return new ClientImpl({
    host: env.IMAP_HOST ?? 'imap.gmail.com',
    port: Number(env.IMAP_PORT ?? 993),
    secure: true,
    auth: { user, pass },
    logger: false,
  });
}

/** Из «<a@b> <c@d>» получаем ['<a@b>', '<c@d>'] — заголовок может содержать цепочку. */
function parseReferences(raw) {
  return String(raw ?? '')
    .split(/\s+/)
    .map((token) => token.trim())
    .filter((token) => token.startsWith('<') && token.endsWith('>'));
}

/**
 * Ищет ответы на наши отклики среди писем, пришедших после отправки.
 * sentLog — журнал откликов; возвращает найденные ответы с кодом вакансии.
 */
export async function fetchReplies(sentLog, { client, seenIds = [], limitPerFolder = 60 } = {}) {
  const byMessageId = new Map();
  for (const record of sentLog) {
    if (record.messageId) byMessageId.set(record.messageId, record);
  }
  if (byMessageId.size === 0) return [];

  const seen = new Set(seenIds);
  const replies = [];

  await client.connect();
  try {
    for (const folder of FOLDERS) {
      let box;
      try {
        box = await client.mailboxOpen(folder, { readOnly: true });
      } catch {
        // Папки спама может не быть — это не ошибка.
        continue;
      }
      if (!box.exists) continue;

      // Смотрим только хвост папки: ответ приходит после нашего письма.
      const from = Math.max(1, box.exists - limitPerFolder + 1);
      for await (const message of client.fetch(`${from}:*`, { envelope: true, headers: ['in-reply-to', 'references'] })) {
        const headers = message.headers?.toString() ?? '';
        const inReplyTo = /in-reply-to:\s*(.+)/i.exec(headers)?.[1] ?? '';
        const references = /references:\s*(.+)/i.exec(headers)?.[1] ?? '';

        const candidates = [...parseReferences(inReplyTo), ...parseReferences(references)];
        const match = candidates.map((id) => byMessageId.get(id)).find(Boolean);
        if (!match) continue;

        const uniqueId = message.envelope?.messageId ?? `${folder}:${message.seq}`;
        if (seen.has(uniqueId)) continue;

        replies.push({
          id: uniqueId,
          code: match.code,
          vacancyTitle: match.title,
          company: match.company,
          from: message.envelope?.from?.[0]?.address ?? '',
          fromName: message.envelope?.from?.[0]?.name ?? '',
          subject: message.envelope?.subject ?? '',
          date: (message.envelope?.date ?? new Date()).toISOString(),
          folder,
        });
      }
    }
  } finally {
    await client.logout().catch(() => {});
  }

  return replies;
}

/** Оформление ответа для чата. */
export function formatReply(reply) {
  const escape = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const lines = [
    '📨 <b>Ответ на ваш отклик</b>',
    '',
    `<b>Вакансия:</b> ${escape(reply.vacancyTitle)} (<code>${escape(reply.code)}</code>)`,
    `<b>От:</b> ${escape(reply.fromName || reply.from)}`,
    `<b>Тема:</b> ${escape(reply.subject)}`,
  ];
  if (reply.folder !== 'INBOX') lines.push('', '⚠️ Письмо лежит в спаме — проверьте почту.');
  lines.push('', 'Читать и отвечать — в почте: https://mail.google.com');
  return lines.join('\n');
}
