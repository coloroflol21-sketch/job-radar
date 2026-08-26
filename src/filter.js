/** Отбор вакансий по правилам из config.json. */

function daysSince(dateString) {
  if (!dateString) return Infinity;
  const parsed = Date.parse(dateString);
  if (Number.isNaN(parsed)) return Infinity;
  return (Date.now() - parsed) / 86_400_000;
}

/** Верхняя граница вилки, если она есть, иначе нижняя: «от 90000» тоже проходит порог. */
function effectiveSalary(vacancy) {
  return Math.max(vacancy.salaryMax || 0, vacancy.salaryMin || 0);
}

const REMOTE_PATTERN = /удал[её]н|дистанцион|remote|на дому/i;

/**
 * Удалённая работа. Поле employment у источника заполнено лишь у трети вакансий,
 * поэтому проверяем ещё название и описание — иначе фильтр отсёк бы почти всё.
 */
export function isRemote(vacancy) {
  const employment = vacancy.employment ?? '';
  if (REMOTE_PATTERN.test(employment)) return true;
  return REMOTE_PATTERN.test(`${vacancy.title ?? ''} ${vacancy.description ?? ''}`);
}

/**
 * Ключевые слова ищутся только в названии вакансии: в описании слово «поддержка»
 * встречается у половины вакансий подряд и фильтр перестаёт работать.
 * Совпадение по любому из слов, регистр не важен.
 */
export function matchesTitle(vacancy, keywords = []) {
  if (keywords.length === 0) return true;
  const title = (vacancy.title ?? '').toLowerCase();
  return keywords.some((word) => word && title.includes(word.toLowerCase()));
}

export function matchesFilters(vacancy, filters = {}) {
  const {
    minSalary = 0,
    excludeKeywords = [],
    requireSalary = false,
    maxAgeDays = Infinity,
    titleKeywords = [],
    maxExperienceYears = null,
    remoteOnly = false,
    schedules = [],
  } = filters;

  const salary = effectiveSalary(vacancy);
  if (requireSalary && salary === 0) return false;
  if (minSalary > 0 && salary > 0 && salary < minSalary) return false;

  if (daysSince(vacancy.modifiedAt || vacancy.createdAt) > maxAgeDays) return false;

  const haystack = `${vacancy.title} ${vacancy.description}`.toLowerCase();
  if (excludeKeywords.some((word) => word && haystack.includes(word.toLowerCase()))) return false;

  if (!matchesTitle(vacancy, titleKeywords)) return false;

  if (maxExperienceYears !== null && (vacancy.experienceYears ?? 0) > maxExperienceYears) return false;

  if (remoteOnly && !isRemote(vacancy)) return false;

  // Графики сверяем по подстроке: в данных они записаны длинными формулировками
  // вроде «Неполный рабочий день/неполная рабочая неделя».
  if (schedules.length > 0) {
    const schedule = (vacancy.schedule ?? '').toLowerCase();
    if (!schedules.some((wanted) => wanted && schedule.includes(wanted.toLowerCase()))) return false;
  }

  return true;
}

/** Сначала свежие, при равной дате — с более высокой вилкой. */
function byRelevance(a, b) {
  const dateDiff = Date.parse(b.modifiedAt || b.createdAt || 0) - Date.parse(a.modifiedAt || a.createdAt || 0);
  if (dateDiff) return dateDiff;
  return effectiveSalary(b) - effectiveSalary(a);
}

/**
 * Убирает повторы внутри выдачи и всё, что уже отправлялось ранее.
 * seenIds — Set идентификаторов из state.json.
 */
export function selectNew(vacancies, seenIds, filters, limit = Infinity) {
  const unique = new Map();

  for (const vacancy of vacancies) {
    if (!vacancy.id || seenIds.has(vacancy.id) || unique.has(vacancy.id)) continue;
    if (!matchesFilters(vacancy, filters)) continue;
    unique.set(vacancy.id, vacancy);
  }

  return [...unique.values()].sort(byRelevance).slice(0, limit);
}
