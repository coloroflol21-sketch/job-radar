import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildScreen, applyCallback, parseCallback } from '../src/menu.js';
import { effectiveConfig } from '../src/settings.js';

const config = {
  sources: ['trudvsem'],
  queries: [{ text: 'поддержка' }],
  filters: { minSalary: 80000, maxAgeDays: 3, titleKeywords: ['поддержк'], schedules: [] },
};

/** Все кнопки экрана одним списком. */
function flatButtons(screen) {
  return screen.keyboard.flat();
}

test('главный экран показывает текущие настройки', () => {
  const screen = buildScreen('main', config, {});
  assert.match(screen.text, /Настройки поиска/);
  assert.match(screen.text, /Работа в России/);
  assert.match(screen.text, /от 80 000 ₽/);
});

test('на главном экране есть кнопки во все разделы', () => {
  const data = flatButtons(buildScreen('main', config, {})).map((b) => b.callback_data);
  for (const screen of ['sources', 'salary', 'experience', 'remote', 'schedules', 'age', 'keywords']) {
    assert.ok(data.includes(`open:${screen}`), `нет кнопки ${screen}`);
  }
});

test('callback_data влезает в лимит Telegram 64 байта', () => {
  const screens = ['main', 'sources', 'salary', 'experience', 'remote', 'schedules', 'age', 'keywords'];
  for (const name of screens) {
    for (const button of flatButtons(buildScreen(name, config, {}))) {
      const size = Buffer.byteLength(button.callback_data);
      assert.ok(size <= 64, `${button.callback_data} — ${size} байт на экране ${name}`);
    }
  }
});

test('выбранный вариант отмечен галочкой', () => {
  const screen = buildScreen('salary', config, {});
  const marked = flatButtons(screen).filter((b) => b.text.startsWith('✓'));
  assert.equal(marked.length, 1);
  assert.match(marked[0].text, /80 000/);
});

test('нажатие меняет настройку и возвращает тот же экран', () => {
  const state = {};
  const salaryScreen = buildScreen('salary', config, state);
  // Индекс варианта «от 40 000 ₽»
  const index = flatButtons(salaryScreen).findIndex((b) => /40 000/.test(b.text));

  const result = applyCallback(`set:salary:${index}`, config, state);

  assert.equal(state.settings.minSalary, 40000);
  assert.equal(result.notice, 'Сохранено');
  assert.match(result.screen.text, /Минимальная зарплата/, 'остаёмся в том же разделе');
});

test('после выбора галочка переезжает', () => {
  const state = {};
  applyCallback('set:salary:1', config, state);
  const marked = flatButtons(buildScreen('salary', config, state)).filter((b) => b.text.startsWith('✓'));
  assert.equal(marked.length, 1);
  assert.match(marked[0].text, /40 000/);
});

test('графики отмечаются по несколько', () => {
  const state = {};
  applyCallback('set:schedules:0', config, state);
  applyCallback('set:schedules:1', config, state);
  assert.deepEqual(state.settings.schedules, ['полный', 'гибк']);

  const marked = flatButtons(buildScreen('schedules', config, state)).filter((b) => b.text.startsWith('✓'));
  assert.equal(marked.length, 2);
});

test('повторное нажатие снимает отметку графика', () => {
  const state = {};
  applyCallback('set:schedules:0', config, state);
  applyCallback('set:schedules:0', config, state);
  assert.deepEqual(state.settings.schedules, []);
});

test('источники переключаются, но последний снять нельзя', () => {
  const state = {};
  applyCallback('set:sources:1', config, state); // включаем hh
  assert.deepEqual(state.settings.sources, ['trudvsem', 'hh']);

  applyCallback('set:sources:0', config, state); // выключаем trudvsem
  assert.deepEqual(state.settings.sources, ['hh']);

  const result = applyCallback('set:sources:1', config, state); // пытаемся снять последний
  assert.match(result.notice, /хотя бы один/);
  assert.deepEqual(state.settings.sources, ['hh'], 'поиск без источников невозможен');
});

test('переключатель формата работы', () => {
  const state = {};
  applyCallback('set:remote:1', config, state);
  assert.equal(state.settings.remoteOnly, true);
  applyCallback('set:remote:0', config, state);
  assert.equal(state.settings.remoteOnly, false);
});

test('опыт можно сбросить в «любой»', () => {
  const state = {};
  applyCallback('set:experience:3', config, state);
  assert.equal(state.settings.maxExperienceYears, 3);
  applyCallback('set:experience:0', config, state);
  assert.equal(state.settings.maxExperienceYears, null);
});

test('открытие раздела не меняет настройки', () => {
  const state = {};
  const result = applyCallback('open:salary', config, state);
  assert.match(result.screen.text, /Минимальная зарплата/);
  assert.deepEqual(state.settings ?? {}, {});
});

test('в каждом разделе есть кнопка «Назад»', () => {
  for (const name of ['sources', 'salary', 'experience', 'remote', 'schedules', 'age', 'keywords']) {
    const data = flatButtons(buildScreen(name, config, {})).map((b) => b.callback_data);
    assert.ok(data.includes('open:main'), `нет «Назад» на экране ${name}`);
  }
});

test('экран ключевых слов объясняет команду', () => {
  const screen = buildScreen('keywords', config, {});
  assert.match(screen.text, /\/keywords/);
  assert.match(screen.text, /поддержк/);
});

test('кнопка проверки выдачи помечает запуск поиска', () => {
  const result = applyCallback('act:preview', config, {});
  assert.equal(result.preview, true);
});

test('неизвестный callback возвращает в главное меню', () => {
  const result = applyCallback('чепуха', config, {});
  assert.match(result.screen.text, /Настройки поиска/);
});

test('parseCallback разбирает данные кнопки', () => {
  assert.deepEqual(parseCallback('set:salary:3'), { action: 'set', screen: 'salary', index: 3 });
  assert.deepEqual(parseCallback('open:main'), { action: 'open', screen: 'main', index: null });
});

test('настройки из меню реально влияют на поиск', () => {
  const state = {};
  applyCallback('set:salary:1', config, state);
  applyCallback('set:remote:1', config, state);

  const active = effectiveConfig(config, state);
  assert.equal(active.filters.minSalary, 40000);
  assert.equal(active.filters.remoteOnly, true);
});
