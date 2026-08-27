/** Состояние между запусками: какие вакансии уже отправлены. */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * История отправленного должна с запасом перекрывать окно поиска, иначе вакансия
 * успеет вытесниться и придёт повторно. При трёх источниках это до 500 вакансий
 * за прогон, поэтому 3000 не хватало — памяти было меньше суток при окне в трое.
 */
const MAX_REMEMBERED_IDS = 50_000;

/** Журнал откликов тоже нельзя растить бесконечно. */
const MAX_SENT_LOG = 500;

const EMPTY_STATE = {
  sentIds: [],
  lastRunAt: null,
  totalSent: 0,
  catalog: {},
  sentLog: [],
  lastUpdateId: 0,
  nextCodeIndex: 0,
  saved: [],
  pendingApply: null,
  // На какую вакансию ждём текст письма: между нажатием кнопки и ответом
  // может пройти запуск по расписанию, поэтому поле обязано сохраняться.
  awaitingLetter: null,
  sourceHealth: {},
};

export async function loadState(path) {
  try {
    const parsed = JSON.parse(await readFile(path, 'utf8'));
    return {
      sentIds: Array.isArray(parsed.sentIds) ? parsed.sentIds : [],
      lastRunAt: parsed.lastRunAt ?? null,
      totalSent: parsed.totalSent ?? 0,
      catalog: parsed.catalog ?? {},
      sentLog: Array.isArray(parsed.sentLog) ? parsed.sentLog : [],
      lastUpdateId: parsed.lastUpdateId ?? 0,
      // Счётчик кодов: только растёт, чтобы код не достался другой вакансии.
      nextCodeIndex: parsed.nextCodeIndex ?? Object.keys(parsed.catalog ?? {}).length,
      saved: Array.isArray(parsed.saved) ? parsed.saved : [],
      pendingApply: parsed.pendingApply ?? null,
      awaitingLetter: parsed.awaitingLetter ?? null,
      sourceHealth: parsed.sourceHealth ?? {},
      settings: parsed.settings,
    };
  } catch (error) {
    if (error.code === 'ENOENT') return structuredClone(EMPTY_STATE);
    throw error;
  }
}

export async function saveState(path, state) {
  await mkdir(dirname(path), { recursive: true });
  const payload = {
    ...state,
    sentIds: state.sentIds.slice(-MAX_REMEMBERED_IDS),
    sentLog: (state.sentLog ?? []).slice(-MAX_SENT_LOG),
  };
  await writeFile(path, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

/**
 * Окно выборки для modifiedFrom: с прошлого запуска минус нахлёст,
 * чтобы не терять вакансии, попавшие в API с задержкой.
 */
export function windowStart(lastRunAt, { overlapHours = 6, fallbackDays = 3 } = {}) {
  const fallback = Date.now() - fallbackDays * 86_400_000;
  const previous = lastRunAt ? Date.parse(lastRunAt) : NaN;
  const from = Number.isNaN(previous) ? fallback : previous - overlapHours * 3_600_000;
  return new Date(from).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
