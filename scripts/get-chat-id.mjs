#!/usr/bin/env node
/**
 * Определяет chat_id: показывает, какому боту принадлежит токен,
 * и ждёт сообщение от вас, печатая id как только оно придёт.
 *
 * Запуск: node scripts/get-chat-id.mjs
 */

// База API вынесена, чтобы скрипт можно было проверить на локальном сервере.
const API = process.env.TELEGRAM_API_BASE ?? 'https://api.telegram.org';
const WAIT_SECONDS = Number(process.env.WAIT_SECONDS ?? 90);

async function call(token, method, params = {}) {
  const query = new URLSearchParams(params);
  const response = await fetch(`${API}/bot${token}/${method}?${query}`);
  return response.json();
}

const token = (process.env.TELEGRAM_BOT_TOKEN ?? '').trim();

if (!token) {
  console.error('Не задан TELEGRAM_BOT_TOKEN.');
  console.error('Задайте его так: export TELEGRAM_BOT_TOKEN="ваш_токен"');
  process.exitCode = 1;
} else {
  const me = await call(token, 'getMe');

  if (!me.ok) {
    console.error(`❌ Токен не принят: ${me.description}`);
    console.error('Проверьте, что скопирован весь токен целиком, вместе с частью до двоеточия.');
    process.exitCode = 1;
  } else {
    console.log(`Токен принадлежит боту: @${me.result.username} (${me.result.first_name})`);
    console.log('Убедитесь, что писали именно этому боту, а не другому.\n');

    const hook = await call(token, 'getWebhookInfo');
    if (hook.ok && hook.result?.url) {
      console.error(`❌ У бота установлен webhook: ${hook.result.url}`);
      console.error('Пока он стоит, сообщения не читаются. Удалите его:');
      console.error(`   https://api.telegram.org/bot<ТОКЕН>/deleteWebhook`);
      process.exitCode = 1;
    } else {
      console.log(`Жду сообщение от вас в чате с @${me.result.username}...`);
      console.log(`Откройте этот чат и отправьте любой текст. Ожидание до ${WAIT_SECONDS} секунд.\n`);

      const deadline = Date.now() + WAIT_SECONDS * 1000;
      let found = null;

      while (!found && Date.now() < deadline) {
        // timeout — это long-polling: соединение висит, пока не придёт сообщение.
        const updates = await call(token, 'getUpdates', { timeout: '20', limit: '10' });

        if (!updates.ok) {
          console.error(`❌ Ошибка Telegram: ${updates.description}`);
          process.exitCode = 1;
          break;
        }

        for (const update of updates.result ?? []) {
          const message = update.message ?? update.edited_message;
          if (message?.chat?.id) {
            found = message;
            break;
          }
        }
      }

      if (found) {
        const chat = found.chat;
        const who = chat.username ? `@${chat.username}` : chat.first_name ?? 'вы';
        console.log('✅ Сообщение получено!');
        console.log(`   от: ${who}`);
        console.log(`   текст: ${found.text ?? '(без текста)'}`);
        console.log(`\nВаш TELEGRAM_CHAT_ID: ${chat.id}\n`);
        console.log('Дальше:');
        console.log(`   export TELEGRAM_CHAT_ID="${chat.id}"`);
        console.log('   npm run check');
      } else if (process.exitCode !== 1) {
        console.error('❌ Сообщений не пришло.');
        console.error('\nВозможные причины:');
        console.error(`   1. Писали другому боту, а не @${me.result.username}`);
        console.error('   2. Чат открыт, но сообщение не отправлено (нажат Start без текста тоже подойдёт)');
        console.error('   3. Токен от другого бота — сверьте имя выше со списком в @BotFather (/mybots)');
        process.exitCode = 1;
      }
    }
  }
}
