/**
 * Источник вакансий: RSS поиска hh.ru. Ключи и регистрация не нужны.
 *
 * API hh (api.hh.ru/vacancies) закрыт за одобренным OAuth-приложением и отдаёт
 * анонимным клиентам 403, а RSS поиска доступен и в robots.txt не запрещён.
 *
 * Контактов работодателя в фиде нет — откликаться можно только на сайте.
 */

const RSS_URL = 'https://hh.ru/search/vacancy/rss';
// Фид отдаёт нормальный ответ только браузерному User-Agent.
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)';

/**
 * limit — единственный работающий способ получить больше 20 вакансий:
 * per_page, count и items_on_page фид игнорирует. На 500 он ломается
 * и молча возвращает 20, поэтому 200 — практический потолок.
 */
const MAX_LIMIT = 200;

function decodeXml(text) {
  return String(text)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .trim();
}

function tag(item, name) {
  const match = item.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`));
  return match ? decodeXml(match[1]) : '';
}

function parseAmount(raw) {
  return Number(String(raw).replace(/[^\d]/g, '')) || 0;
}

/**
 * Описание в фиде — набор абзацев:
 * «Вакансия компании: X», «Создана: 27.08.2026», «Регион: Москва»,
 * «Предполагаемый уровень месячного дохода: от 120 000 до 140 000 ₽».
 */
export function parseDescription(description) {
  const text = String(description).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  const company = (text.match(/Вакансия компании:\s*([^]*?)\s*(?:Создана:|Регион:|Предполагаемый|$)/) ?? [])[1] ?? '';
  const region = (text.match(/Регион:\s*([^]*?)\s*(?:Предполагаемый|Создана:|$)/) ?? [])[1] ?? '';

  let salaryMin = 0;
  let salaryMax = 0;
  const income = text.match(/дохода:\s*([^]*?)(?:$|\s{2,})/);
  if (income) {
    const raw = income[1];
    const range = raw.match(/от\s+([\d\s]+)\s*до\s+([\d\s]+)/i);
    if (range) {
      salaryMin = parseAmount(range[1]);
      salaryMax = parseAmount(range[2]);
    } else {
      const from = raw.match(/от\s+([\d\s]+)/i);
      const upTo = raw.match(/до\s+([\d\s]+)/i);
      if (from) salaryMin = parseAmount(from[1]);
      if (upTo) salaryMax = parseAmount(upTo[1]);
    }
  }

  return { company: company.trim(), region: region.trim(), salaryMin, salaryMax };
}

/** Признаки удалёнки и графика приходится брать из названия: полей для них нет. */
function parseTitleHints(title) {
  return {
    remote: /удал[её]н|дистанцион|remote|на дому/i.test(title),
    partTime: /неполн|част[ьи]чн|подработ/i.test(title),
    shift: /смен|\d\/\d/i.test(title),
  };
}

function normalize(item, query) {
  const title = tag(item, 'title');
  const description = tag(item, 'description');
  const parsed = parseDescription(description);
  const hints = parseTitleHints(title);
  const published = tag(item, 'pubDate');
  const publishedIso = published && !Number.isNaN(Date.parse(published))
    ? new Date(published).toISOString()
    : '';

  const link = tag(item, 'link');
  const vacancyId = (link.match(/vacancy\/(\d+)/) ?? [])[1] ?? link;

  let schedule = '';
  if (hints.partTime) schedule = 'Неполный рабочий день';
  else if (hints.shift) schedule = 'Сменная работа';

  return {
    // Префикс источника: номера у разных источников свои и могут совпасть.
    id: `hh-${vacancyId}`,
    title,
    company: parsed.company || 'не указана',
    region: parsed.region,
    url: link,
    salaryMin: parsed.salaryMin,
    salaryMax: parsed.salaryMax,
    salaryText: '',
    // Контактов в фиде нет — отклик только на сайте.
    email: '',
    contactPerson: '',
    schedule,
    employment: hints.remote ? 'Дистанционная (удаленная) работа' : '',
    // Требуемый опыт в фиде не указан вовсе.
    experienceYears: 0,
    description,
    createdAt: publishedIso,
    modifiedAt: publishedIso,
    matchedQuery: query.text ?? '',
    source: 'hh',
  };
}

async function fetchFeed(url, { retries = 3, fetchImpl = fetch } = {}) {
  let lastError;
  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const response = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT } });
      if (response.status === 429 || response.status >= 500) throw new Error(`HTTP ${response.status}`);
      if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { fatal: true });
      return await response.text();
    } catch (error) {
      lastError = error;
      if (error.fatal || attempt === retries) break;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** (attempt - 1)));
    }
  }
  throw lastError;
}

export async function fetchVacancies(query, { perQuery = MAX_LIMIT, fetchImpl = fetch } = {}) {
  const params = new URLSearchParams({ limit: String(Math.min(perQuery, MAX_LIMIT)) });
  if (query.text) params.set('text', query.text);
  if (query.hhArea) params.set('area', String(query.hhArea));
  // order_by=publication_time и period сортируют всю базу по дате и выбрасывают
  // релевантность: по запросу «поддержка» приходят полицейские и водители.
  // Поэтому свежесть отсекается уже своим фильтром maxAgeDays.

  const xml = await fetchFeed(`${RSS_URL}?${params}`, { fetchImpl });
  const items = xml.split('<item>').slice(1);

  return items.slice(0, perQuery).map((item) => normalize(item, query));
}
