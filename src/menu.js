/**
 * Меню настроек на инлайн-кнопках. Работает через long-polling: нажатия
 * приходят как callback_query в тот же getUpdates, что и команды.
 *
 * В callback_data влезает 64 байта, а варианты вроде
 * «Неполный рабочий день/неполная рабочая неделя» длиннее, поэтому
 * передаём индекс варианта, а не его текст.
 */

import {
  SALARY_OPTIONS,
  EXPERIENCE_OPTIONS,
  SCHEDULE_OPTIONS,
  AGE_OPTIONS,
  effectiveConfig,
  currentValue,
  updateSetting,
  toggleInList,
  describeSettings,
} from './settings.js';
import { sourceNames, sourceLabel } from './sources/index.js';

const MARK = '✓ ';

function button(text, data) {
  return { text, callback_data: data };
}

/** Разбирает callback_data вида «set:salary:3». */
export function parseCallback(data) {
  const [action, screen, rawIndex] = String(data ?? '').split(':');
  return { action, screen, index: rawIndex === undefined ? null : Number(rawIndex) };
}

function rows(buttons, perRow = 2) {
  const result = [];
  for (let i = 0; i < buttons.length; i += perRow) result.push(buttons.slice(i, i + perRow));
  return result;
}

/** Экран выбора одного значения из списка. */
function singleChoiceScreen(screen, title, options, active) {
  const buttons = options.map((option, index) =>
    button(`${option.value === active ? MARK : ''}${option.label}`, `set:${screen}:${index}`),
  );
  return {
    text: `<b>${title}</b>\n\nВыберите один вариант.`,
    keyboard: [...rows(buttons), [button('‹ Назад', 'open:main')]],
  };
}

/** Экран, где можно отметить несколько значений. */
function multiChoiceScreen(screen, title, options, active, hint) {
  const selected = new Set(active ?? []);
  const buttons = options.map((option, index) =>
    button(`${selected.has(option.value) ? MARK : ''}${option.label}`, `set:${screen}:${index}`),
  );
  return {
    text: `<b>${title}</b>\n\n${hint}`,
    keyboard: [...rows(buttons), [button('‹ Назад', 'open:main')]],
  };
}

function mainScreen(config, state) {
  const summary = describeSettings(config, state);
  const text = [
    '<b>⚙️ Настройки поиска</b>',
    '',
    `📚 Источники: ${summary.sources}`,
    `💰 Зарплата: ${summary.salary}`,
    `🎓 Опыт: ${summary.experience}`,
    `🏠 Формат: ${summary.remote}`,
    `🕒 График: ${summary.schedules}`,
    `📅 Свежесть: ${summary.age}`,
    `🔍 Ключевые слова: ${summary.keywords}`,
    '',
    'Нажмите, что хотите изменить.',
  ].join('\n');

  return {
    text,
    keyboard: [
      [button('📚 Источники', 'open:sources'), button('💰 Зарплата', 'open:salary')],
      [button('🎓 Опыт', 'open:experience'), button('🏠 Формат', 'open:remote')],
      [button('🕒 График', 'open:schedules'), button('📅 Свежесть', 'open:age')],
      [button('🔍 Ключевые слова', 'open:keywords')],
      [button('🔎 Проверить выдачу', 'act:preview')],
    ],
  };
}

function sourcesScreen(config, state) {
  const options = sourceNames().map((name) => ({ value: name, label: sourceLabel(name) }));
  return multiChoiceScreen(
    'sources',
    '📚 Источники вакансий',
    options,
    currentValue(config, state, 'sources'),
    'Можно включить оба. У «Хабр Карьеры» нет контактов работодателя — отклик там только на сайте.',
  );
}

function remoteScreen(config, state) {
  const active = currentValue(config, state, 'remoteOnly') ?? false;
  const options = [
    { value: false, label: 'любой формат' },
    { value: true, label: 'только удалённо' },
  ];
  const buttons = options.map((option, index) =>
    button(`${option.value === active ? MARK : ''}${option.label}`, `set:remote:${index}`),
  );
  return {
    text: [
      '<b>🏠 Формат работы</b>',
      '',
      'Источники указывают удалёнку не всегда, поэтому фильтр строгий:',
      'подходящих вакансий будет заметно меньше.',
    ].join('\n'),
    keyboard: [buttons, [button('‹ Назад', 'open:main')]],
  };
}

function keywordsScreen(config, state) {
  const keywords = currentValue(config, state, 'titleKeywords') ?? [];
  return {
    text: [
      '<b>🔍 Ключевые слова</b>',
      '',
      keywords.length > 0 ? `Сейчас: <code>${keywords.join(', ')}</code>` : 'Сейчас фильтра нет.',
      '',
      'Вакансия проходит, если одно из слов есть в её названии.',
      'Достаточно корня слова: <code>поддержк</code> совпадёт и с «поддержки», и с «поддержке».',
      '',
      'Изменить — командой:',
      '<code>/keywords поддержк, helpdesk</code>',
      'Убрать фильтр — <code>/keywords</code> без слов.',
    ].join('\n'),
    keyboard: [[button('‹ Назад', 'open:main')]],
  };
}

/** Собирает экран по имени. */
export function buildScreen(name, config, state) {
  switch (name) {
    case 'sources':
      return sourcesScreen(config, state);
    case 'salary':
      return singleChoiceScreen('salary', '💰 Минимальная зарплата', SALARY_OPTIONS, currentValue(config, state, 'minSalary') ?? 0);
    case 'experience':
      return singleChoiceScreen('experience', '🎓 Требуемый опыт', EXPERIENCE_OPTIONS, currentValue(config, state, 'maxExperienceYears') ?? null);
    case 'age':
      return singleChoiceScreen('age', '📅 Свежесть вакансий', AGE_OPTIONS, currentValue(config, state, 'maxAgeDays') ?? 3);
    case 'remote':
      return remoteScreen(config, state);
    case 'schedules':
      return multiChoiceScreen(
        'schedules',
        '🕒 График работы',
        SCHEDULE_OPTIONS,
        currentValue(config, state, 'schedules'),
        'Отметьте подходящие. Если не выбрано ничего — подходит любой график.',
      );
    case 'keywords':
      return keywordsScreen(config, state);
    default:
      return mainScreen(config, state);
  }
}

/**
 * Применяет нажатие. Возвращает экран для перерисовки и короткий ответ
 * для всплывающей подсказки. state изменяется на месте.
 */
export function applyCallback(data, config, state) {
  const { action, screen, index } = parseCallback(data);

  if (action === 'open') {
    return { screen: buildScreen(screen, config, state), notice: '' };
  }

  if (action === 'act' && screen === 'preview') {
    return { screen: null, notice: 'Проверяю выдачу...', preview: true };
  }

  if (action !== 'set') {
    return { screen: buildScreen('main', config, state), notice: '' };
  }

  switch (screen) {
    case 'sources': {
      const name = sourceNames()[index];
      const next = toggleInList(currentValue(config, state, 'sources') ?? [], name);
      // Пустой список источников означал бы поиск в никуда.
      if (next.length === 0) {
        return { screen: buildScreen('sources', config, state), notice: 'Нужен хотя бы один источник' };
      }
      updateSetting(state, 'sources', next);
      break;
    }
    case 'salary':
      updateSetting(state, 'minSalary', SALARY_OPTIONS[index].value);
      break;
    case 'experience':
      updateSetting(state, 'maxExperienceYears', EXPERIENCE_OPTIONS[index].value);
      break;
    case 'age':
      updateSetting(state, 'maxAgeDays', AGE_OPTIONS[index].value);
      break;
    case 'remote':
      updateSetting(state, 'remoteOnly', index === 1);
      break;
    case 'schedules': {
      const value = SCHEDULE_OPTIONS[index].value;
      updateSetting(state, 'schedules', toggleInList(currentValue(config, state, 'schedules') ?? [], value));
      break;
    }
    default:
      return { screen: buildScreen('main', config, state), notice: '' };
  }

  return { screen: buildScreen(screen, config, state), notice: 'Сохранено' };
}

export { effectiveConfig };
