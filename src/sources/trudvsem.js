/**
 * Источник вакансий: открытое API «Работа в России» (trudvsem).
 * Ключи и регистрация не нужны. Документация: https://opendata.trudvsem.ru/csv/
 */

const API_ROOT = 'https://opendata.trudvsem.ru/api/v1/vacancies';
const USER_AGENT = 'job-radar/1.0 (+https://github.com/)';

/** API молча обрезает выдачу до 100 записей на страницу. */
const MAX_PAGE_SIZE = 100;

function buildUrl({ text, region }, { limit, offset, modifiedFrom }) {
  const base = region ? `${API_ROOT}/region/${region}` : API_ROOT;
  const params = new URLSearchParams({
    limit: String(Math.min(limit, MAX_PAGE_SIZE)),
    offset: String(offset),
  });
  if (text) params.set('text', text);
  if (modifiedFrom) params.set('modifiedFrom', modifiedFrom);
  return `${base}?${params}`;
}

async function fetchJson(url, { retries = 3, fetchImpl = fetch } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT } });
      if (response.status === 429 || response.status >= 500) {
        throw new Error(`HTTP ${response.status}`);
      }
      if (!response.ok) {
        throw Object.assign(new Error(`HTTP ${response.status}`), { fatal: true });
      }
      return await response.json();
    } catch (error) {
      lastError = error;
      if (error.fatal || attempt === retries) break;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Адрес для отклика. Контакт вакансии приоритетнее адреса компании:
 * в контактах обычно рекрутёр, у компании — общий ящик вида zakupki@ или info@.
 */
function pickEmail(v) {
  const fromContacts = (v.contact_list ?? [])
    .map((contact) => (contact.contact_value ?? '').trim())
    .find((value) => EMAIL_PATTERN.test(value));
  if (fromContacts) return fromContacts;

  const fromCompany = (v.company?.email ?? '').trim();
  return EMAIL_PATTERN.test(fromCompany) ? fromCompany : '';
}

/** Приводит запись API к плоскому виду, на который опирается остальной код. */
function normalize(raw, query) {
  const v = raw.vacancy ?? raw;
  let requirement = v.requirement;
  if (typeof requirement === 'string') {
    try {
      requirement = JSON.parse(requirement);
    } catch {
      requirement = {};
    }
  }
  const salaryMin = Number(v.salary_min) || 0;
  const salaryMax = Number(v.salary_max) || 0;

  return {
    id: v.id,
    title: v['job-name'] ?? '',
    company: v.company?.name ?? 'не указана',
    region: v.region?.name ?? '',
    url: v.vac_url ?? '',
    salaryMin,
    salaryMax,
    salaryText: v.salary ?? '',
    email: pickEmail(v),
    contactPerson: (v.contact_person ?? '').trim(),
    schedule: v.schedule ?? '',
    experienceYears: Number(requirement?.experience) || 0,
    description: v.duty ?? '',
    createdAt: v['creation-date'] ?? '',
    modifiedAt: v.date_modify ?? '',
    matchedQuery: query.text ?? '',
  };
}

/** Забирает все страницы по одному запросу, пока API отдаёт полные страницы. */
export async function fetchVacancies(query, { perQuery = 100, modifiedFrom, fetchImpl = fetch } = {}) {
  const collected = [];
  let offset = 0;

  while (collected.length < perQuery) {
    const pageSize = Math.min(MAX_PAGE_SIZE, perQuery - collected.length);
    const url = buildUrl(query, { limit: pageSize, offset, modifiedFrom });
    const payload = await fetchJson(url, { fetchImpl });
    const page = payload?.results?.vacancies ?? [];

    collected.push(...page.map((item) => normalize(item, query)));
    if (page.length < pageSize) break;
    offset += page.length;
  }

  return collected;
}
