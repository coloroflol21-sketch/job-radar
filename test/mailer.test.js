import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSubject, buildBody, sendApplication, createMailer } from '../src/mailer.js';

const entry = {
  id: 'a',
  title: 'Python разработчик',
  company: 'ООО Тест',
  email: 'hr@example.com',
  url: 'https://trudvsem.ru/vacancy/a',
  contactPerson: 'Иванова Мария',
};

function stubTransport() {
  const sent = [];
  return {
    sent,
    sendMail: async (message) => {
      sent.push(message);
      return { messageId: '<id@local>', accepted: [message.to] };
    },
  };
}

test('тема письма содержит название вакансии', () => {
  assert.equal(buildSubject(entry), 'Отклик на вакансию: Python разработчик');
});

test('в письме есть обращение по имени, текст и ссылка на вакансию', () => {
  const body = buildBody(entry, 'Заинтересовала ваша вакансия.');
  assert.match(body, /^Иванова Мария, здравствуйте!/);
  assert.match(body, /Заинтересовала ваша вакансию\.|Заинтересовала ваша вакансия\./);
  assert.match(body, /https:\/\/trudvsem\.ru\/vacancy\/a/);
});

test('вместо имени указан отдел — обращение не подставляется', () => {
  const body = buildBody({ ...entry, contactPerson: 'Команда рекрутмента Сбера, HR' }, 'Текст.');
  assert.doesNotMatch(body, /здравствуйте!/);
  assert.match(body, /^Текст\./);
});

test('контактное лицо не указано — письмо начинается с текста', () => {
  const body = buildBody({ ...entry, contactPerson: '' }, 'Текст отклика.');
  assert.match(body, /^Текст отклика\./);
});

test('отправляет письмо на адрес вакансии', async () => {
  const transport = stubTransport();
  const result = await sendApplication(entry, 'Заинтересовала вакансия.', {
    transport,
    from: 'me@example.com',
  });

  assert.equal(transport.sent.length, 1);
  assert.equal(transport.sent[0].to, 'hr@example.com');
  assert.equal(transport.sent[0].from, 'me@example.com');
  assert.equal(transport.sent[0].subject, 'Отклик на вакансию: Python разработчик');
  assert.equal(result.messageId, '<id@local>');
});

test('replyTo по умолчанию совпадает с отправителем', async () => {
  const transport = stubTransport();
  await sendApplication(entry, 'Текст отклика.', { transport, from: 'me@example.com' });
  assert.equal(transport.sent[0].replyTo, 'me@example.com');
});

test('вакансия без email отклоняется до обращения к транспорту', async () => {
  const transport = stubTransport();
  await assert.rejects(
    () => sendApplication({ ...entry, email: '' }, 'Текст.', { transport, from: 'me@example.com' }),
    /нет адреса/,
  );
  assert.equal(transport.sent.length, 0);
});

test('ошибка SMTP пробрасывается наружу', async () => {
  const transport = { sendMail: async () => { throw new Error('535 Authentication failed'); } };
  await assert.rejects(
    () => sendApplication(entry, 'Текст.', { transport, from: 'me@example.com' }),
    /535/,
  );
});

test('createMailer требует логин и пароль', () => {
  assert.throws(() => createMailer({}), /SMTP_USER/);
  assert.throws(() => createMailer({ SMTP_USER: 'a' }), /SMTP_PASSWORD/);
});

test('createMailer собирает транспорт по настройкам окружения', () => {
  const transport = createMailer({
    SMTP_USER: 'me@yandex.ru',
    SMTP_PASSWORD: 'secret',
    SMTP_HOST: 'smtp.yandex.ru',
    SMTP_PORT: '465',
  });
  assert.equal(typeof transport.sendMail, 'function');
  assert.equal(transport.options.host, 'smtp.yandex.ru');
  assert.equal(transport.options.port, 465);
  assert.equal(transport.options.secure, true);
});

test('порт 587 переключает транспорт в STARTTLS', () => {
  const transport = createMailer({ SMTP_USER: 'a', SMTP_PASSWORD: 'b', SMTP_PORT: '587' });
  assert.equal(transport.options.secure, false);
});
