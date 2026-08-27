/**
 * Каталог отправленных вакансий: короткий код → данные для отклика.
 * UUID вакансии в чат не набрать, поэтому каждой присваивается код вида A7, B3.
 *
 * Код закрепляется за вакансией навсегда и никогда не выдаётся другой:
 * иначе ответ /apply на старое сообщение отправил бы письмо не тому работодателю.
 */

/** Без похожих на цифры I и O, чтобы код нельзя было прочитать двояко. */
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

/** Каталог хранит вакансии на время, пока отклик ещё осмыслен. */
const CATALOG_TTL_DAYS = 14;

export function normalizeCode(input) {
  return String(input ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Код по порядковому номеру: A1..A9, B1..B9, ... Z9, затем AA1..AA9 и так далее.
 * Номера не кончаются, поэтому переиспользовать код никогда не требуется.
 */
export function codeForIndex(index) {
  const digit = (index % 9) + 1;
  let letterIndex = Math.floor(index / 9);
  let letters = '';

  // Когда одиночные буквы кончились, добавляем ещё одну: AA, AB, ... ZZ, AAA.
  do {
    letters = LETTERS[letterIndex % LETTERS.length] + letters;
    letterIndex = Math.floor(letterIndex / LETTERS.length) - 1;
  } while (letterIndex >= 0);

  return `${letters}${digit}`;
}

/**
 * Регистрирует вакансии в каталоге и возвращает их же с полем code.
 * catalog — объект из state.json, изменяется на месте.
 * nextIndex хранится в state и только растёт.
 */
export function registerVacancies(catalog, vacancies, now = new Date(), counter = {}) {
  const byId = new Map(Object.entries(catalog).map(([code, entry]) => [entry.id, code]));
  // Счётчик продолжается с максимального выданного номера: так код не повторится
  // даже после чистки каталога по TTL.
  let next = counter.nextCodeIndex ?? Object.keys(catalog).length;

  const result = vacancies.map((vacancy) => {
    const existing = byId.get(vacancy.id);
    if (existing) return { ...vacancy, code: existing };

    const code = codeForIndex(next);
    next += 1;
    byId.set(vacancy.id, code);

    catalog[code] = {
      id: vacancy.id,
      title: vacancy.title,
      company: vacancy.company,
      email: vacancy.email,
      url: vacancy.url,
      contactPerson: vacancy.contactPerson ?? '',
      region: vacancy.region ?? '',
      salaryMin: vacancy.salaryMin ?? 0,
      salaryMax: vacancy.salaryMax ?? 0,
      schedule: vacancy.schedule ?? '',
      employment: vacancy.employment ?? '',
      experienceYears: vacancy.experienceYears ?? 0,
      description: (vacancy.description ?? '').slice(0, 1500),
      source: vacancy.source ?? 'trudvsem',
      addedAt: now.toISOString(),
    };

    return { ...vacancy, code };
  });

  counter.nextCodeIndex = next;
  return result;
}

export function findByCode(catalog, code) {
  return catalog[normalizeCode(code)] ?? null;
}

/**
 * Убирает записи старше TTL, чтобы состояние не разрасталось.
 * Избранное и вакансии с отправленным откликом не удаляются: к ним ещё вернутся.
 */
export function pruneCatalog(catalog, now = new Date(), { keepCodes = [] } = {}) {
  const cutoff = now.getTime() - CATALOG_TTL_DAYS * 86_400_000;
  const keep = new Set(keepCodes);

  for (const [code, entry] of Object.entries(catalog)) {
    if (keep.has(code)) continue;
    const addedAt = Date.parse(entry.addedAt ?? '');
    if (Number.isNaN(addedAt) || addedAt < cutoff) delete catalog[code];
  }
  return catalog;
}
