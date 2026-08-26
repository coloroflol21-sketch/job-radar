/** Отправка отклика на вакансию по SMTP. */

import { createTransport } from 'nodemailer';

/**
 * Тема письма по вакансии. Название вакансии в теме — то, что рекрутёр
 * видит первым, поэтому оно важнее любых формулировок вроде «отклик».
 */
export function buildSubject(entry) {
  return `Отклик на вакансию: ${entry.title}`;
}

/** Обращение по имени, если контактное лицо указано в вакансии. */
function buildGreeting(entry) {
  const person = (entry.contactPerson ?? '').trim();
  // В вакансиях встречается не имя, а название отдела — тогда обращение неуместно.
  const looksLikeName = person && person.split(/\s+/).length <= 3 && !/[,(]/.test(person);
  return looksLikeName ? `${person}, здравствуйте!` : '';
}

export function buildBody(entry, userText) {
  const greeting = buildGreeting(entry);
  const parts = [];
  if (greeting) parts.push(greeting);
  parts.push(userText.trim());
  if (entry.url) parts.push(`Вакансия: ${entry.url}`);
  return parts.join('\n\n');
}

/**
 * Транспорт по логину и паролю из окружения.
 * Хост и порт настраиваются: у Gmail, Яндекса и Mail.ru они разные.
 */
export function createMailer(env = process.env) {
  const user = env.SMTP_USER;
  const pass = env.SMTP_PASSWORD;
  if (!user || !pass) throw new Error('Не заданы SMTP_USER или SMTP_PASSWORD');

  return createTransport({
    host: env.SMTP_HOST ?? 'smtp.gmail.com',
    port: Number(env.SMTP_PORT ?? 465),
    secure: Number(env.SMTP_PORT ?? 465) === 465,
    auth: { user, pass },
  });
}

/**
 * Отправляет отклик. transport передаётся снаружи, чтобы тесты
 * не открывали сетевых соединений.
 */
export async function sendApplication(entry, userText, { transport, from, replyTo } = {}) {
  if (!entry?.email) throw new Error('У вакансии нет адреса для отклика');

  const info = await transport.sendMail({
    from,
    to: entry.email,
    replyTo: replyTo || from,
    subject: buildSubject(entry),
    text: buildBody(entry, userText),
  });

  return { messageId: info.messageId, accepted: info.accepted ?? [] };
}
