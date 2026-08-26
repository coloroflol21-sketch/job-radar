import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleCommands } from '../src/handler.js';
import { parseCommand } from '../src/commands.js';

const goodBody = 'Здравствуйте! Заинтересовала ваша вакансия, готов обсудить детали.';

function freshState() {
  return {
    catalog: {
      A1: {
        id: 'a',
        title: 'Python разработчик',
        company: 'ООО Тест',
        email: 'hr@example.com',
        url: 'https://trudvsem.ru/vacancy/a',
        contactPerson: 'Иванова Мария',
        addedAt: new Date().toISOString(),
      },
      A2: {
        id: 'b',
        title: 'Frontend разработчик',
        company: 'ООО Два',
        email: '',
        url: 'https://trudvsem.ru/vacancy/b',
        addedAt: new Date().toISOString(),
      },
    },
    sentLog: [],
  };
}

function stubTransport() {
  const sent = [];
  return { sent, sendMail: async (m) => { sent.push(m); return { messageId: '<id>', accepted: [m.to] }; } };
}

async function run(text, state, transport) {
  const command = parseCommand(text);
  return handleCommands([command], state, { transport, from: 'me@example.com' });
}

test('/help отвечает справкой с примером отклика', async () => {
  const [reply] = await run('/help', freshState());
  assert.match(reply, /\/apply/);
  assert.match(reply, /Job Radar/);
});

test('/list показывает коды и помечает вакансии без email', async () => {
  const [reply] = await run('/list', freshState());
  assert.match(reply, /A1/);
  assert.match(reply, /Python разработчик/);
  assert.match(reply, /A2/);
  assert.match(reply, /без email/);
});

test('/list на пустом каталоге объясняет, что ждать', async () => {
  const [reply] = await run('/list', { catalog: {}, sentLog: [] });
  assert.match(reply, /пуст/);
});

test('/preview показывает адрес отклика', async () => {
  const [reply] = await run('/preview A1', freshState());
  assert.match(reply, /hr@example\.com/);
  assert.match(reply, /Иванова Мария/);
  assert.match(reply, /\/apply A1/);
});

test('/preview на неизвестный код подсказывает /list', async () => {
  const [reply] = await run('/preview Z9', freshState());
  assert.match(reply, /не найдена/);
  assert.match(reply, /\/list/);
});

test('/apply отправляет письмо и пишет об успехе', async () => {
  const state = freshState();
  const transport = stubTransport();
  const [reply] = await run(`/apply A1\n${goodBody}`, state, transport);

  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].to, 'hr@example.com');
  assert.match(reply, /Отклик отправлен/);
  assert.equal(state.sentLog.length, 1);
  assert.equal(state.sentLog[0].code, 'A1');
});

test('/apply на вакансию без email ничего не отправляет', async () => {
  const state = freshState();
  const transport = stubTransport();
  const [reply] = await run(`/apply A2\n${goodBody}`, state, transport);

  assert.equal(transport.sent.length, 0);
  assert.match(reply, /не указан email/);
  assert.equal(state.sentLog.length, 0);
});

test('повторный /apply на ту же вакансию не отправляет письмо второй раз', async () => {
  const state = freshState();
  const transport = stubTransport();
  await run(`/apply A1\n${goodBody}`, state, transport);
  const [reply] = await run(`/apply A1\n${goodBody}`, state, transport);

  assert.equal(transport.sent.length, 1, 'второе письмо не ушло');
  assert.match(reply, /уже отправлен/);
});

test('сбой SMTP не роняет обработку и сообщается пользователю', async () => {
  const state = freshState();
  const transport = { sendMail: async () => { throw new Error('535 Authentication failed'); } };
  const [reply] = await run(`/apply A1\n${goodBody}`, state, transport);

  assert.match(reply, /не отправлен/);
  assert.match(reply, /535/);
  assert.equal(state.sentLog.length, 0, 'неудачная отправка не попадает в журнал');
});

test('/sent показывает историю откликов', async () => {
  const state = freshState();
  const transport = stubTransport();
  await run(`/apply A1\n${goodBody}`, state, transport);
  const [reply] = await run('/sent', state, transport);

  assert.match(reply, /A1/);
  assert.match(reply, /hr@example\.com/);
});

test('/sent без откликов сообщает об этом', async () => {
  const [reply] = await run('/sent', freshState());
  assert.match(reply, /не было/);
});

test('неизвестная команда отправляет к справке', async () => {
  const [reply] = await run('/qwerty', freshState());
  assert.match(reply, /Не знаю команду/);
});

test('несколько команд обрабатываются по порядку', async () => {
  const state = freshState();
  const transport = stubTransport();
  const commands = ['/list', `/apply A1\n${goodBody}`, '/sent'].map(parseCommand);
  const replies = await handleCommands(commands, state, { transport, from: 'me@example.com' });

  assert.equal(replies.length, 3);
  assert.match(replies[1], /Отклик отправлен/);
  assert.match(replies[2], /A1/);
});

test('HTML в данных вакансии экранируется в ответах', async () => {
  const state = freshState();
  state.catalog.A1.company = 'ООО <b>Х</b>';
  const [reply] = await run('/list', state);
  assert.match(reply, /&lt;b&gt;/);
});
