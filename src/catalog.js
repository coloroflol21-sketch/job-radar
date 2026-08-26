/**
 * Каталог отправленных вакансий: короткий код → данные для отклика.
 * UUID вакансии в чат не набрать, поэтому каждой присваивается код вида A7, B3.
 */

/** Без похожих на цифры I и O, чтобы код нельзя было прочитать двояко. */
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';

/** Каталог хранит вакансии на время, пока отклик ещё осмыслен. */
const CATALOG_TTL_DAYS = 14;

export function normalizeCode(input) {
  return String(input ?? '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Все коды по порядку: A1..A9, B1..B9, далее по алфавиту. */
const ALL_CODES = LETTERS.split('').flatMap((letter) =>
  Array.from({ length: 9 }, (_, i) => `${letter}${i + 1}`),
);

/**
 * Первый код, не занятый в каталоге. Занятые пропускаются, чтобы код
 * из старого сообщения продолжал указывать на ту же вакансию.
 */
function nextFreeCode(takenCodes) {
  return ALL_CODES.find((code) => !takenCodes.has(code)) ?? null;
}

/**
 * Регистрирует вакансии в каталоге и возвращает их же с полем code.
 * catalog — объект из state.json, изменяется на месте.
 */
export function registerVacancies(catalog, vacancies, now = new Date()) {
  const takenCodes = new Set(Object.keys(catalog));
  const byId = new Map(Object.entries(catalog).map(([code, entry]) => [entry.id, code]));

  return vacancies.map((vacancy) => {
    const existing = byId.get(vacancy.id);
    if (existing) return { ...vacancy, code: existing };

    // Каталог заполнен целиком — переиспользуем самую давнюю запись.
    const code =
      nextFreeCode(takenCodes) ??
      Object.entries(catalog).sort(
        (a, b) => Date.parse(a[1].addedAt ?? 0) - Date.parse(b[1].addedAt ?? 0),
      )[0][0];

    takenCodes.add(code);
    byId.set(vacancy.id, code);
    catalog[code] = {
      id: vacancy.id,
      title: vacancy.title,
      company: vacancy.company,
      email: vacancy.email,
      url: vacancy.url,
      contactPerson: vacancy.contactPerson ?? '',
      addedAt: now.toISOString(),
    };

    return { ...vacancy, code };
  });
}

export function findByCode(catalog, code) {
  return catalog[normalizeCode(code)] ?? null;
}

/** Убирает записи старше TTL, чтобы состояние не разрасталось. */
export function pruneCatalog(catalog, now = new Date()) {
  const cutoff = now.getTime() - CATALOG_TTL_DAYS * 86_400_000;
  for (const [code, entry] of Object.entries(catalog)) {
    const addedAt = Date.parse(entry.addedAt ?? '');
    if (Number.isNaN(addedAt) || addedAt < cutoff) delete catalog[code];
  }
  return catalog;
}
