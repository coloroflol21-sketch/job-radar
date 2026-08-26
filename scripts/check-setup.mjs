#!/usr/bin/env node
/**
 * Проверка настроек перед запуском: токен бота, доступ к чату, почта, источник вакансий.
 * Ничего не отправляет работодателям — только тестовое сообщение вам в Telegram.
 *
 * Запуск: node scripts/check-setup.mjs
 */

import { createMailer } from '../src/mailer.js';

const results = [];
let mailTransport = null;

function report(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? `: ${detail}` : ''}`);
}

async function checkTelegramToken(token) {
  if (!token) {
    report('Токен бота', false, 'переменная TELEGRAM_BOT_TOKEN не задана');
    return null;
  }
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    const payload = await response.json();
    if (!payload.ok) {
      report('Токен бота', false, payload.description);
      return null;
    }
    report('Токен бота', true, `бот @${payload.result.username}`);
    return payload.result;
  } catch (error) {
    report('Токен бота', false, error.message);
    return null;
  }
}

/** Webhook и getUpdates взаимоисключающие: если webhook стоит, команды читаться не будут. */
async function checkWebhookFree(token) {
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/getWebhookInfo`);
    const payload = await response.json();
    const url = payload.result?.url ?? '';
    if (url) {
      report('Режим получения команд', false, `установлен webhook ${url} — удалите его: /deleteWebhook`);
      return false;
    }
    report('Режим получения команд', true, 'long-polling, webhook не мешает');
    return true;
  } catch (error) {
    report('Режим получения команд', false, error.message);
    return false;
  }
}

async function checkChat(token, chatId) {
  if (!chatId) {
    report('Доступ к чату', false, 'переменная TELEGRAM_CHAT_ID не задана');
    return false;
  }
  try {
    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: '🔧 Проверка связи. Если вы видите это сообщение, бот настроен верно.',
      }),
    });
    const payload = await response.json();
    if (!payload.ok) {
      const hint = /chat not found/i.test(payload.description ?? '')
        ? 'напишите боту любое сообщение и проверьте chat_id'
        : payload.description;
      report('Доступ к чату', false, hint);
      return false;
    }
    report('Доступ к чату', true, 'тестовое сообщение отправлено');
    return true;
  } catch (error) {
    report('Доступ к чату', false, error.message);
    return false;
  }
}

async function checkMail() {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASSWORD) {
    report('Почта для откликов', false, 'SMTP_USER или SMTP_PASSWORD не заданы (отклики работать не будут)');
    return false;
  }
  try {
    mailTransport = createMailer();
    await mailTransport.verify();
    report('Почта для откликов', true, `${process.env.SMTP_USER} через ${mailTransport.options.host}`);
    return true;
  } catch (error) {
    const hint = /Username and Password not accepted|BadCredentials|535/i.test(error.message)
      ? 'нужен пароль приложения, а не обычный пароль от почты'
      : error.message;
    report('Почта для откликов', false, hint);
    return false;
  }
}

async function checkSource() {
  try {
    const response = await fetch(
      'https://opendata.trudvsem.ru/api/v1/vacancies/region/7700000000?text=python&limit=1&offset=0',
    );
    const payload = await response.json();
    const total = payload?.meta?.total ?? 0;
    report('Источник вакансий', total > 0, `найдено ${total} по пробному запросу`);
    return total > 0;
  } catch (error) {
    report('Источник вакансий', false, error.message);
    return false;
  }
}

const token = process.env.TELEGRAM_BOT_TOKEN;
const bot = await checkTelegramToken(token);
if (bot) {
  await checkWebhookFree(token);
  await checkChat(token, process.env.TELEGRAM_CHAT_ID);
}
await checkMail();
await checkSource();

const failed = results.filter((result) => !result.ok);
console.log(
  failed.length === 0
    ? '\nВсё готово. Можно запускать: npm start'
    : `\nОсталось исправить: ${failed.map((result) => result.name).join(', ')}`,
);

// Транспорт nodemailer держит открытые соединения: закрываем их,
// иначе процесс либо висит, либо падает на принудительном exit.
if (mailTransport) mailTransport.close();
process.exitCode = failed.length === 0 ? 0 : 1;
