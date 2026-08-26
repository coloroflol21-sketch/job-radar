/** Состояние между запусками: какие вакансии уже отправлены. */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/** Держим ограниченную историю, чтобы файл не рос бесконечно. */
const MAX_REMEMBERED_IDS = 3000;

const EMPTY_STATE = {
  sentIds: [],
  lastRunAt: null,
  totalSent: 0,
  catalog: {},
  sentLog: [],
  lastUpdateId: 0,
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
    };
  } catch (error) {
    if (error.code === 'ENOENT') return structuredClone(EMPTY_STATE);
    throw error;
  }
}

export async function saveState(path, state) {
  await mkdir(dirname(path), { recursive: true });
  const payload = { ...state, sentIds: state.sentIds.slice(-MAX_REMEMBERED_IDS) };
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
