/** Интерфейс без набора команд: главное меню, кнопки под вакансиями, ForceReply. */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { homeScreen, buildScreen } from '../src/menu.js';
import { vacancyKeyboard, formatVacancy } from '../src/telegram.js';
import { BOT_COMMANDS, parseCommand } from '../src/commands.js';

function vacancy(overrides = {}) {
  return {
    code: 'A1',
    title: 'Специалист технической поддержки',
    company: 'ООО Тест',
    email: 'hr@example.com',
    url: 'https://example.com/1',
    salaryMin: 100000,
    salaryMax: 0,
    region: 'Москва',
    schedule: 'Полный день',
    ...overrides,
  };
}

test('главное меню ведёт во все разделы кнопками', () => {
  const data = homeScreen({}).keyboard.flat().map((b) => b.callback_data);
  for (const target of ['go:list', 'go:saved', 'open:main', 'go:stats', 'go:sent', 'go:more', 'go:help']) {
    assert.ok(data.includes(target), `нет кнопки ${target}`);
  }
});

test('главное меню показывает счётчики', () => {
  const text = homeScreen({ catalog: { A1: {}, A2: {} }, saved: ['A1'], sentLog: [{ code: 'A1' }] }).text;
  assert.match(text, /Вакансий в каталоге: 2/);
  assert.match(text, /В избранном: 1/);
  assert.match(text, /Откликов отправлено: 1/);
});

test('из настроек есть путь в главное меню', () => {
  const data = buildScreen('main', { filters: {} }, {}).keyboard.flat().map((b) => b.callback_data);
  assert.ok(data.includes('go:home'), 'иначе из настроек не выйти кнопками');
});

test('под вакансией есть кнопки отклика, описания и избранного', () => {
  const data = vacancyKeyboard(vacancy()).flat().map((b) => b.callback_data ?? b.url);
  assert.ok(data.includes('act:apply:A1'));
  assert.ok(data.includes('act:show:A1'));
  assert.ok(data.includes('act:save:A1'));
  assert.ok(data.includes('https://example.com/1'), 'ссылка на сайт кнопкой');
});

test('у вакансии без email кнопки отклика нет', () => {
  const data = vacancyKeyboard(vacancy({ email: '' })).flat().map((b) => b.callback_data ?? '');
  assert.ok(!data.includes('act:apply:A1'), 'иначе кнопка обещала бы невозможное');
  assert.ok(data.includes('act:show:A1'));
});

test('callback_data кнопок вакансии влезает в 64 байта', () => {
  // Коды растут: A1, потом AA1, AAA1 — проверяем длинный вариант.
  for (const code of ['A1', 'AA1', 'AAAA9']) {
    for (const button of vacancyKeyboard(vacancy({ code })).flat()) {
      if (!button.callback_data) continue;
      assert.ok(Buffer.byteLength(button.callback_data) <= 64, `${button.callback_data} слишком длинный`);
    }
  }
});

test('в карточке с кнопками нет текстовых подсказок', () => {
  const withButtons = formatVacancy(vacancy(), 0, { withHints: false });
  assert.doesNotMatch(withButtons, /\/apply/, 'кнопка уже есть, подсказка лишняя');
  assert.match(withButtons, /Специалист технической поддержки/);

  const plain = formatVacancy(vacancy(), 1);
  assert.match(plain, /\/apply A1/, 'без кнопок подсказка нужна');
});

test('команды для меню Telegram описаны понятно', () => {
  assert.ok(BOT_COMMANDS.length >= 8);
  for (const item of BOT_COMMANDS) {
    assert.match(item.command, /^[a-z]+$/, 'Telegram принимает только строчные латинские');
    assert.ok(item.description.length > 3 && item.description.length <= 256);
  }
});

test('все команды из меню Telegram действительно разбираются', () => {
  for (const item of BOT_COMMANDS) {
    const parsed = parseCommand(`/${item.command}`);
    assert.ok(parsed, `/${item.command} не разбирается`);
    assert.notEqual(parsed.type, 'unknown', `/${item.command} не реализована`);
  }
});

test('/menu открывает главное меню', () => {
  assert.equal(parseCommand('/menu').type, 'menu');
});
