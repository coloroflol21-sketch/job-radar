import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildDigest, formatVacancy, sendMessage } from '../src/telegram.js';

function vacancy(overrides = {}) {
  return {
    id: 'v1',
    title: 'Python разработчик',
    company: 'ООО Тест',
    region: 'Москва',
    url: 'https://example.com/1',
    salaryMin: 150000,
    salaryMax: 0,
    schedule: 'Полный день',
    experienceYears: 3,
    description: '',
    ...overrides,
  };
}

// Разряды в ru-RU разделяются неразрывным пробелом, поэтому в шаблонах \s.
test('форматирует вилку, нижнюю и верхнюю границу, и отсутствие зарплаты', () => {
  assert.match(formatVacancy(vacancy({ salaryMin: 100000, salaryMax: 200000 }), 1), /100\s000\s₽\s–\s200\s000\s₽/);
  assert.match(formatVacancy(vacancy({ salaryMin: 100000, salaryMax: 0 }), 1), /от\s100\s000\s₽/);
  assert.match(formatVacancy(vacancy({ salaryMin: 0, salaryMax: 90000 }), 1), /до\s90\s000\s₽/);
  assert.match(formatVacancy(vacancy({ salaryMin: 0, salaryMax: 0 }), 1), /не указана/);
  assert.match(formatVacancy(vacancy({ salaryMin: 120000, salaryMax: 120000 }), 1), /от\s120\s000\s₽/);
});

test('экранирует HTML в данных вакансии', () => {
  const message = formatVacancy(vacancy({ company: 'ООО <b>Х</b> & Ко' }), 1);
  assert.match(message, /ООО &lt;b&gt;Х&lt;\/b&gt; &amp; Ко/);
  assert.doesNotMatch(message, /ООО <b>Х<\/b>/);
});

test('необязательные поля не попадают в сообщение пустыми', () => {
  const message = formatVacancy(vacancy({ region: '', schedule: '', experienceYears: 0 }), 1);
  assert.doesNotMatch(message, /📍|🕒|🎓/);
});

test('короткий дайджест укладывается в одно сообщение', () => {
  const messages = buildDigest([vacancy(), vacancy({ id: 'v2' })]);
  assert.equal(messages.length, 1);
  assert.match(messages[0], /Новые вакансии: 2/);
});

test('длинный дайджест режется на части в пределах лимита Telegram', () => {
  const many = Array.from({ length: 60 }, (_, i) =>
    vacancy({ id: `v${i}`, title: `Разработчик очень длинной специализации номер ${i}` }),
  );
  const messages = buildDigest(many);
  assert.ok(messages.length > 1, 'ожидалось несколько сообщений');
  for (const message of messages) {
    assert.ok(message.length <= 4096, `сообщение длиной ${message.length} превышает лимит`);
  }
});

test('sendMessage передаёт chat_id и HTML-разметку', async () => {
  let captured;
  const fetchImpl = async (url, options) => {
    captured = { url, body: JSON.parse(options.body) };
    return { json: async () => ({ ok: true, result: {} }) };
  };

  await sendMessage('привет', { token: 'T', chatId: '42', fetchImpl });

  assert.match(captured.url, /\/botT\/sendMessage$/);
  assert.equal(captured.body.chat_id, '42');
  assert.equal(captured.body.parse_mode, 'HTML');
});

test('sendMessage сообщает об ошибке Telegram', async () => {
  const fetchImpl = async () => ({ json: async () => ({ ok: false, description: 'chat not found' }) });
  await assert.rejects(
    () => sendMessage('привет', { token: 'T', chatId: 'bad', fetchImpl }),
    /chat not found/,
  );
});

test('sendMessage требует токен и chat_id', async () => {
  await assert.rejects(() => sendMessage('привет', {}), /TELEGRAM_BOT_TOKEN/);
});
