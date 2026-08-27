import { test } from 'node:test';
import assert from 'node:assert/strict';

import { handleCommands, confirmApply } from '../src/handler.js';
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

async function run(text, state) {
  const command = parseCommand(text);
  return handleCommands([command], state, { from: 'me@example.com' });
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

const applyCommand = `/apply A1\n${goodBody}`;

test('/apply показывает письмо и просит подтверждение, но не отправляет', async () => {
  const state = freshState();
  const [reply] = await run(applyCommand, state);

  assert.match(reply.text, /Проверьте письмо перед отправкой/);
  assert.match(reply.text, /hr@example.com/);
  assert.match(reply.text, /Python разработчик/);
  assert.ok(reply.keyboard, 'нужны кнопки подтверждения');
  assert.equal(state.sentLog.length, 0, 'письмо ещё не отправлено');
  assert.equal(state.pendingApply.code, 'A1');
});

test('подтверждение отправляет письмо и пишет в журнал', async () => {
  const state = freshState();
  const transport = stubTransport();
  await run(applyCommand, state);

  const answer = await confirmApply('A1', state, { transport, from: 'me@example.com' });

  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].to, 'hr@example.com');
  assert.match(answer, /Отклик отправлен/);
  assert.equal(state.sentLog.length, 1);
  assert.equal(state.pendingApply, null, 'подтверждение одноразовое');
});

test('подтверждение без подготовленного отклика ничего не отправляет', async () => {
  const state = freshState();
  const transport = stubTransport();
  const answer = await confirmApply('A1', state, { transport, from: 'me@example.com' });
  assert.match(answer, /Нечего подтверждать/);
  assert.equal(transport.sent.length, 0);
});

test('повторное подтверждение не отправляет письмо дважды', async () => {
  const state = freshState();
  const transport = stubTransport();
  await run(applyCommand, state);
  await confirmApply('A1', state, { transport, from: 'me@example.com' });
  const again = await confirmApply('A1', state, { transport, from: 'me@example.com' });

  assert.equal(transport.sent.length, 1, 'второе письмо не ушло');
  assert.match(again, /Нечего подтверждать/);
});

test('/apply на вакансию без email не доходит до подтверждения', async () => {
  const state = freshState();
  const [reply] = await run(`/apply A2\n${goodBody}`, state);
  assert.match(reply, /не указан email/);
  assert.equal(state.pendingApply ?? null, null);
});

test('повторный отклик на ту же вакансию отклоняется', async () => {
  const state = freshState();
  const transport = stubTransport();
  await run(applyCommand, state);
  await confirmApply('A1', state, { transport, from: 'me@example.com' });

  const [reply] = await run(applyCommand, state);
  assert.match(reply, /уже отправлен/);
});

test('сбой SMTP сообщается и не пишет в журнал', async () => {
  const state = freshState();
  const failing = { sendMail: async () => { throw new Error('535 Authentication failed'); } };
  await run(applyCommand, state);

  const answer = await confirmApply('A1', state, { transport: failing, from: 'me@example.com' });
  assert.match(answer, /не отправлен/);
  assert.match(answer, /535/);
  assert.equal(state.sentLog.length, 0);
});

test('/sent показывает историю откликов', async () => {
  const state = freshState();
  const transport = stubTransport();
  await run(applyCommand, state);
  await confirmApply('A1', state, { transport, from: 'me@example.com' });

  const [reply] = await run('/sent', state);

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
  const commands = ['/list', applyCommand, '/sent'].map(parseCommand);
  const replies = await handleCommands(commands, state, { from: 'me@example.com' });

  assert.equal(replies.length, 3);
  assert.match(replies[0], /A1/, 'сначала список');
  assert.match(replies[1].text, /Проверьте письмо/, 'потом подтверждение отклика');
  assert.match(replies[2], /не было/, 'журнал пуст: письмо ещё не подтверждено');
});

test('/show отдаёт описание вакансии', async () => {
  const state = freshState();
  state.catalog.A1.description = 'Консультирование пользователей по телефону и в чате.';
  const [reply] = await run('/show A1', state);

  assert.match(reply, /Python разработчик/);
  assert.match(reply, /Консультирование пользователей/);
  assert.match(reply, /\/apply A1/);
});

test('/save добавляет в избранное, повторно — нет', async () => {
  const state = freshState();
  const [first] = await run('/save A1', state);
  assert.match(first, /в избранном/);
  assert.deepEqual(state.saved, ['A1']);

  const [second] = await run('/save A1', state);
  assert.match(second, /Уже в избранном/);
  assert.deepEqual(state.saved, ['A1'], 'дубликата нет');
});

test('/saved показывает список, пустой — объясняет', async () => {
  const state = freshState();
  assert.match((await run('/saved', state))[0], /пусто/);

  await run('/save A1', state);
  assert.match((await run('/saved', state))[0], /Python разработчик/);
});

test('/stats считает сводку по каталогу', async () => {
  const state = freshState();
  state.catalog.A1.salaryMin = 100000;
  state.catalog.A2.salaryMin = 200000;
  const [reply] = await run('/stats', state);

  assert.match(reply, /Сводка по рынку/);
  assert.match(reply, /Медиана/);
});

test('/more передаёт сигнал вызывающему, а не отвечает сам', async () => {
  const [reply] = await run('/more', freshState());
  assert.equal(reply.more, true);
});

test('HTML в данных вакансии экранируется в ответах', async () => {
  const state = freshState();
  state.catalog.A1.company = 'ООО <b>Х</b>';
  const [reply] = await run('/list', state);
  assert.match(reply, /&lt;b&gt;/);
});
