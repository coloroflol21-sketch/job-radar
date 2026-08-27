/**
 * Настройки поиска: значения из config.json — начальные, выбор кнопками в боте
 * перекрывает их и хранится в состоянии. Так настройки действуют и локально,
 * и при запуске по расписанию, где config.json трогать неудобно.
 */

import { sourceNames, sourceLabel } from './sources/index.js';

/** Варианты собраны по живой выдаче источников, а не выдуманы. */
export const SALARY_OPTIONS = [
  { value: 0, label: 'без ограничения' },
  { value: 40000, label: 'от 40 000 ₽' },
  { value: 60000, label: 'от 60 000 ₽' },
  { value: 80000, label: 'от 80 000 ₽' },
  { value: 100000, label: 'от 100 000 ₽' },
  { value: 150000, label: 'от 150 000 ₽' },
];

export const EXPERIENCE_OPTIONS = [
  { value: null, label: 'любой опыт' },
  { value: 0, label: 'без опыта' },
  { value: 1, label: 'до 1 года' },
  { value: 3, label: 'до 3 лет' },
  { value: 5, label: 'до 5 лет' },
];

/** Графики сверяются по корню слова: в данных они записаны длинными фразами. */
export const SCHEDULE_OPTIONS = [
  { value: 'полный', label: 'Полный день' },
  { value: 'гибк', label: 'Гибкий график' },
  { value: 'сменная', label: 'Сменная работа' },
  { value: 'неполный', label: 'Неполный день' },
  { value: 'ненормированный', label: 'Ненормированный' },
];

export const AGE_OPTIONS = [
  { value: 1, label: 'за сутки' },
  { value: 3, label: 'за 3 дня' },
  { value: 7, label: 'за неделю' },
  { value: 30, label: 'за месяц' },
];

/** Что можно менять кнопками. Остальное остаётся в config.json. */
const OVERRIDABLE = ['sources', 'minSalary', 'requireSalary', 'maxAgeDays', 'titleKeywords', 'maxExperienceYears', 'remoteOnly', 'schedules'];

/**
 * Собирает действующие настройки: config.json + правки из состояния.
 * Возвращает объект той же формы, что config, — его ждёт scanVacancies.
 */
export function effectiveConfig(config, state = {}) {
  const overrides = state.settings ?? {};
  const filters = { ...(config.filters ?? {}) };
  let sources = config.sources ?? ['trudvsem'];

  for (const key of OVERRIDABLE) {
    if (overrides[key] === undefined) continue;
    if (key === 'sources') sources = overrides[key];
    else filters[key] = overrides[key];
  }

  return { ...config, sources, filters };
}

/** Читает одно действующее значение — нужно для отметок в меню. */
export function currentValue(config, state, key) {
  const active = effectiveConfig(config, state);
  return key === 'sources' ? active.sources : active.filters[key];
}

/** Записывает правку в состояние. Изменяет state на месте. */
export function updateSetting(state, key, value) {
  if (!OVERRIDABLE.includes(key)) throw new Error(`Настройка ${key} не меняется кнопками`);
  state.settings ??= {};
  state.settings[key] = value;
  return state.settings;
}

/** Переключает элемент в списке-множестве (источники, графики). */
export function toggleInList(list, value) {
  const set = new Set(list);
  if (set.has(value)) set.delete(value);
  else set.add(value);
  return [...set];
}

function describeList(values, options, emptyLabel) {
  if (!values || values.length === 0) return emptyLabel;
  return values
    .map((value) => options.find((option) => option.value === value)?.label ?? value)
    .join(', ');
}

/** Человекочитаемая сводка для главного экрана меню. */
export function describeSettings(config, state) {
  const active = effectiveConfig(config, state);
  const filters = active.filters;

  const salary = SALARY_OPTIONS.find((option) => option.value === (filters.minSalary ?? 0));
  const experience = EXPERIENCE_OPTIONS.find(
    (option) => option.value === (filters.maxExperienceYears ?? null),
  );
  const age = AGE_OPTIONS.find((option) => option.value === (filters.maxAgeDays ?? 3));

  return {
    sources: active.sources.map((name) => sourceLabel(name)).join(', ') || 'ни одного',
    salary: salary?.label ?? `от ${filters.minSalary} ₽`,
    experience: experience?.label ?? `до ${filters.maxExperienceYears} лет`,
    remote: filters.remoteOnly ? 'только удалённо' : 'любой формат',
    schedules: describeList(filters.schedules, SCHEDULE_OPTIONS, 'любой график'),
    age: age?.label ?? `за ${filters.maxAgeDays} дней`,
    keywords: (filters.titleKeywords ?? []).join(', ') || 'без фильтра',
    requireSalary: filters.requireSalary ? 'только с зарплатой' : 'включая без зарплаты',
  };
}

export { sourceNames, sourceLabel };
