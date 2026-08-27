/** Оформление ответов бота: описание вакансии, избранное, сводка по рынку. */

export function escapeHtml(text) {
  return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function money(value) {
  return `${value.toLocaleString('ru-RU')} ₽`;
}

export function formatSalaryRange(entry) {
  const min = entry.salaryMin ?? 0;
  const max = entry.salaryMax ?? 0;
  if (!min && !max) return 'не указана';
  if (min && max && min !== max) return `${money(min)} – ${money(max)}`;
  return min ? `от ${money(min)}` : `до ${money(max)}`;
}

/**
 * Убирает разметку и служебные абзацы, оставляя читаемый текст.
 *
 * Служебные строки вырезаются по абзацам исходной разметки, а не по тексту:
 * шаблон вида «Регион:[^.]*\.» проглатывал бы описание до первой точки.
 */
export function cleanDescription(raw) {
  const SERVICE_LINE = /^\s*(Вакансия компании|Создана|Регион|Предполагаемый уровень месячного дохода)\s*:/i;

  const html = String(raw ?? '');
  // Разбиваем по закрывающим тегам абзацев и переводам строк.
  const chunks = html
    .split(/<\/p>|<br\s*\/?>|\n/i)
    .map((chunk) =>
      chunk
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&amp;/g, '&')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter((chunk) => chunk && !SERVICE_LINE.test(chunk));

  return chunks.join(' ').replace(/\s+/g, ' ').trim();
}

/**
 * Сколько дней вакансия висит. Долгий срок — сигнал: работодатель не спешит
 * либо с вакансией что-то не так.
 */
export function daysListed(entry, now = new Date()) {
  const added = Date.parse(entry.addedAt ?? '');
  if (Number.isNaN(added)) return null;
  return Math.floor((now.getTime() - added) / 86_400_000);
}

/** Полное описание вакансии — чтобы решать не по одному названию. */
export function renderVacancy(entry, code, { now = new Date() } = {}) {
  const lines = [
    `<b>${escapeHtml(entry.title)}</b>`,
    `🏢 ${escapeHtml(entry.company)}`,
    `💰 ${escapeHtml(formatSalaryRange(entry))}`,
  ];

  if (entry.region) lines.push(`📍 ${escapeHtml(entry.region)}`);
  if (entry.experienceYears) lines.push(`🎓 опыт от ${entry.experienceYears} лет`);
  if (entry.schedule) lines.push(`🕒 ${escapeHtml(entry.schedule)}`);
  if (entry.employment) lines.push(`🏠 ${escapeHtml(entry.employment)}`);

  const days = daysListed(entry, now);
  if (days !== null && days >= 7) {
    lines.push(`⏳ висит ${days} дней — работодатель не спешит`);
  }

  const text = cleanDescription(entry.description);
  if (text.length > 30) {
    lines.push('', '<b>Описание</b>', escapeHtml(text.length > 900 ? `${text.slice(0, 900)}…` : text));
  } else if (entry.source === 'hh') {
    // В RSS поиска hh описания нет — только название, компания и зарплата.
    lines.push('', 'hh.ru не отдаёт описание в фиде — откройте вакансию на сайте.');
  } else {
    lines.push('', 'Описание источник не отдал — смотрите на сайте.');
  }

  if (entry.url) lines.push('', `<a href="${escapeHtml(entry.url)}">Открыть на сайте</a>`);
  if (entry.email) lines.push(`✍️ отклик: <code>/apply ${escapeHtml(code)}</code>`);
  else lines.push('✍️ отклик — только на сайте');
  lines.push(`⭐ в избранное: <code>/save ${escapeHtml(code)}</code>`);

  return lines.join('\n');
}

export function renderSaved(catalog, savedCodes, { now = new Date() } = {}) {
  if (savedCodes.length === 0) {
    return 'Избранное пусто. Добавить — <code>/save A1</code>';
  }

  const lines = ['⭐ <b>Избранное</b>', ''];
  for (const code of savedCodes.slice(-25).reverse()) {
    const entry = catalog[code];
    if (!entry) continue;
    const days = daysListed(entry, now);
    const age = days !== null && days >= 7 ? ` — висит ${days} дн.` : '';
    lines.push(`<code>${code}</code> ${escapeHtml(entry.title)}`);
    lines.push(`      ${escapeHtml(entry.company)}, ${escapeHtml(formatSalaryRange(entry))}${age}`);
  }
  lines.push('', 'Подробнее — <code>/show КОД</code>');
  return lines.join('\n');
}

/** Медиана устойчивее среднего: одна вакансия за 400 000 не задирает картину. */
function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[middle - 1] + sorted[middle]) / 2) : sorted[middle];
}

/**
 * Сводка по рынку: не список вакансий, а картина целиком.
 * Считается по всему каталогу, то есть по тому, что бот видел за две недели.
 */
export function renderStats(catalog, { now = new Date() } = {}) {
  const entries = Object.values(catalog);
  if (entries.length === 0) {
    return 'Данных пока нет — вакансии появятся после первого поиска.';
  }

  const salaries = entries
    .map((entry) => Math.max(entry.salaryMax || 0, entry.salaryMin || 0))
    .filter((value) => value > 0);

  const withSalary = salaries.length;
  const remote = entries.filter((entry) => entry.employment).length;
  const withEmail = entries.filter((entry) => entry.email).length;

  const bySource = {};
  for (const entry of entries) {
    const source = entry.source ?? 'trudvsem';
    bySource[source] = (bySource[source] ?? 0) + 1;
  }

  const fresh = entries.filter((entry) => {
    const days = daysListed(entry, now);
    return days !== null && days <= 1;
  }).length;

  const stale = entries.filter((entry) => {
    const days = daysListed(entry, now);
    return days !== null && days >= 7;
  }).length;

  const lines = [
    '📊 <b>Сводка по рынку</b>',
    `За последние две недели бот видел ${entries.length} подходящих вакансий.`,
    '',
    '<b>Зарплата</b>',
    withSalary > 0
      ? `Указана у ${withSalary} из ${entries.length}. Медиана — ${money(median(salaries))}.`
      : 'Ни в одной вакансии не указана.',
  ];

  if (withSalary > 0) {
    lines.push(`Разброс: ${money(Math.min(...salaries))} – ${money(Math.max(...salaries))}.`);
  }

  lines.push(
    '',
    '<b>Условия</b>',
    `Удалённо: ${remote} (${Math.round((remote / entries.length) * 100)}%).`,
    `Можно откликнуться письмом из бота: ${withEmail}.`,
    '',
    '<b>Источники</b>',
  );

  for (const [source, count] of Object.entries(bySource).sort((a, b) => b[1] - a[1])) {
    lines.push(`${source}: ${count}`);
  }

  lines.push('', '<b>Свежесть</b>', `Появились за сутки: ${fresh}. Висят больше недели: ${stale}.`);

  if (stale > entries.length / 2) {
    lines.push('', 'Больше половины вакансий залежались — рынок в вашей нише вялый.');
  }

  return lines.join('\n');
}
