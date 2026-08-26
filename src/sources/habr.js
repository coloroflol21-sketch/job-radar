/**
 * Источник вакансий: RSS Хабр Карьеры. Ключи и регистрация не нужны.
 *
 * Фид отдаёт только IT-вакансии, но без контактов работодателя: откликнуться
 * можно лишь на сайте. Зарплата и условия лежат текстом в описании, поэтому
 * их приходится разбирать — см. parseDescription.
 */

const RSS_URL = 'https://career.habr.com/vacancies/rss';
const USER_AGENT = 'job-radar/1.0 (+https://github.com/)';

/** Фид отдаёт не больше 50 записей на запрос, страниц нет. */
const FEED_SIZE = 50;

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

/** Разряды в фиде разделены пробелами: «От 62 000 ₽ до 70 000 ₽». */
function parseAmount(raw) {
  return Number(String(raw).replace(/[^\d]/g, '')) || 0;
}

/**
 * Разбирает описание вида:
 * «Компания «X» ищет ... на вакансию «Y». Москва (Россия). От 62 000 ₽ до 70 000 ₽.
 *  Полный рабочий день. Можно удалённо. Требуемые навыки: #junior, #Linux.»
 */
export function parseDescription(description) {
  const text = String(description).replace(/\s+/g, ' ');

  let salaryMin = 0;
  let salaryMax = 0;
  const range = text.match(/От\s+([\d\s]+)\s*₽\s+до\s+([\d\s]+)\s*₽/i);
  if (range) {
    salaryMin = parseAmount(range[1]);
    salaryMax = parseAmount(range[2]);
  } else {
    const from = text.match(/От\s+([\d\s]+)\s*₽/i);
    const upTo = text.match(/До\s+([\d\s]+)\s*₽/i);
    if (from) salaryMin = parseAmount(from[1]);
    if (upTo) salaryMax = parseAmount(upTo[1]);
  }

  // Регион идёт первым в скобках: «Санкт-Петербург (Россия)».
  const regionMatch = text.match(/\.\s*([^.]+?)\s*\((?:Россия|[^)]+)\)\s*\./);
  const region = regionMatch ? regionMatch[1].trim() : '';

  const scheduleMatch = text.match(/(Полный рабочий день|Неполный рабочий день|Гибкий график|Частичная занятость|Стажировка)/i);

  const skills = [...text.matchAll(/#([^\s,.]+)/g)].map((m) => m[1]);

  // Опыт в фиде задан тегом грейда, а не числом лет. Переводим в годы,
  // чтобы фильтр maxExperienceYears работал одинаково для обоих источников.
  const grades = [
    [/#intern\b/i, 0],
    [/#junior\b/i, 1],
    [/#middle\b/i, 3],
    [/#senior\b/i, 5],
    [/#lead\b/i, 6],
  ];
  const grade = grades.find(([pattern]) => pattern.test(text));

  return {
    salaryMin,
    salaryMax,
    region,
    schedule: scheduleMatch ? scheduleMatch[1] : '',
    remote: /Можно удал[её]нно/i.test(text),
    experienceYears: grade ? grade[1] : 0,
    skills,
  };
}

/** Название приходит как «Требуется «X» (Москва)» — оставляем только X. */
export function parseTitle(rawTitle) {
  const quoted = rawTitle.match(/[«"]([^»"]+)[»"]/);
  if (quoted) return quoted[1].trim();
  return rawTitle.replace(/^Требуется\s+/i, '').replace(/\s*\([^)]*\)\s*$/, '').trim();
}

function normalize(item, query) {
  const rawTitle = tag(item, 'title');
  const description = tag(item, 'description');
  const parsed = parseDescription(description);
  const published = tag(item, 'pubDate');
  const publishedIso = published && !Number.isNaN(Date.parse(published))
    ? new Date(published).toISOString()
    : '';

  return {
    // Префикс источника: у двух источников свои нумерации, id не должны совпасть.
    id: `habr-${tag(item, 'guid')}`,
    title: parseTitle(rawTitle),
    company: tag(item, 'author') || 'не указана',
    region: parsed.region,
    url: tag(item, 'link'),
    salaryMin: parsed.salaryMin,
    salaryMax: parsed.salaryMax,
    salaryText: '',
    // Контактов в фиде нет — откликаться только на сайте.
    email: '',
    contactPerson: '',
    schedule: parsed.schedule,
    employment: parsed.remote ? 'Дистанционная (удаленная) работа' : '',
    experienceYears: parsed.experienceYears,
    description,
    createdAt: publishedIso,
    modifiedAt: publishedIso,
    matchedQuery: query.text ?? '',
    source: 'habr',
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

/**
 * Забирает вакансии по одному запросу. perQuery ограничивает выдачу,
 * но фид всё равно не отдаёт больше 50 записей.
 */
export async function fetchVacancies(query, { perQuery = FEED_SIZE, fetchImpl = fetch } = {}) {
  const params = new URLSearchParams({ type: 'all' });
  if (query.text) params.set('q', query.text);
  if (query.remoteOnly) params.set('remote', 'true');

  const xml = await fetchFeed(`${RSS_URL}?${params}`, { fetchImpl });
  const items = xml.split('<item>').slice(1);

  return items.slice(0, perQuery).map((item) => normalize(item, query));
}
