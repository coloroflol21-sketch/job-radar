import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  effectiveConfig,
  currentValue,
  updateSetting,
  toggleInList,
  describeSettings,
  SALARY_OPTIONS,
  SCHEDULE_OPTIONS,
} from '../src/settings.js';

const config = {
  sources: ['trudvsem'],
  queries: [{ text: 'поддержка' }],
  filters: { minSalary: 80000, maxAgeDays: 3, titleKeywords: ['поддержк'], schedules: [] },
  limits: { maxNotificationsPerRun: 12 },
};

test('без правок действуют значения из config.json', () => {
  const active = effectiveConfig(config, {});
  assert.equal(active.filters.minSalary, 80000);
  assert.deepEqual(active.sources, ['trudvsem']);
});

test('правки из состояния перекрывают config.json', () => {
  const state = { settings: { minSalary: 40000 } };
  assert.equal(effectiveConfig(config, state).filters.minSalary, 40000);
});

test('правки не портят исходный config', () => {
  const state = { settings: { minSalary: 0 } };
  effectiveConfig(config, state);
  assert.equal(config.filters.minSalary, 80000, 'config.json остаётся источником значений по умолчанию');
});

test('источники тоже перекрываются', () => {
  const state = { settings: { sources: ['habr'] } };
  assert.deepEqual(effectiveConfig(config, state).sources, ['habr']);
});

test('незаданные настройки берутся из config, а не сбрасываются', () => {
  const state = { settings: { minSalary: 0 } };
  const active = effectiveConfig(config, state);
  assert.equal(active.filters.maxAgeDays, 3);
  assert.deepEqual(active.filters.titleKeywords, ['поддержк']);
});

test('updateSetting пишет в состояние', () => {
  const state = {};
  updateSetting(state, 'minSalary', 60000);
  assert.equal(state.settings.minSalary, 60000);
});

test('updateSetting отклоняет настройки не из белого списка', () => {
  assert.throws(() => updateSetting({}, 'queries', []), /не меняется кнопками/);
});

test('currentValue отдаёт действующее значение', () => {
  assert.equal(currentValue(config, {}, 'minSalary'), 80000);
  assert.equal(currentValue(config, { settings: { minSalary: 0 } }, 'minSalary'), 0);
  assert.deepEqual(currentValue(config, {}, 'sources'), ['trudvsem']);
});

test('toggleInList добавляет и убирает', () => {
  assert.deepEqual(toggleInList([], 'habr'), ['habr']);
  assert.deepEqual(toggleInList(['habr'], 'habr'), []);
  assert.deepEqual(toggleInList(['trudvsem'], 'habr'), ['trudvsem', 'habr']);
});

test('toggleInList не создаёт повторов', () => {
  assert.deepEqual(toggleInList(['a', 'a'], 'b'), ['a', 'b']);
});

test('сводка настроек читается человеком', () => {
  const summary = describeSettings(config, {});
  assert.equal(summary.sources, 'Работа в России');
  assert.equal(summary.salary, 'от 80 000 ₽');
  assert.equal(summary.experience, 'любой опыт');
  assert.equal(summary.remote, 'любой формат');
  assert.equal(summary.schedules, 'любой график');
  assert.equal(summary.keywords, 'поддержк');
});

test('сводка отражает выбранные графики', () => {
  const state = { settings: { schedules: ['полный', 'гибк'] } };
  assert.equal(describeSettings(config, state).schedules, 'Полный день, Гибкий график');
});

test('сводка показывает удалёнку и пустые ключевые слова', () => {
  const state = { settings: { remoteOnly: true, titleKeywords: [] } };
  const summary = describeSettings(config, state);
  assert.equal(summary.remote, 'только удалённо');
  assert.equal(summary.keywords, 'без фильтра');
});

test('нестандартное значение зарплаты показывается как есть', () => {
  const summary = describeSettings({ ...config, filters: { ...config.filters, minSalary: 123456 } }, {});
  assert.match(summary.salary, /123456/);
});

test('варианты зарплаты и графиков не пустые', () => {
  assert.ok(SALARY_OPTIONS.length >= 4);
  assert.ok(SCHEDULE_OPTIONS.length >= 4);
  assert.ok(SALARY_OPTIONS.every((o) => typeof o.label === 'string'));
});
