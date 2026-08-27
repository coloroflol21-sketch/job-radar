/** Бот не должен молчать: пустой результат и сбой источника нужно объяснять. */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { emptyResultText, failureText } from '../src/serve.js';

const active = {
  filters: {
    minSalary: 80000,
    titleKeywords: ['поддержк'],
    remoteOnly: false,
    schedules: [],
    maxExperienceYears: null,
  },
};

test('когда источники ничего не вернули — советуем расширить запросы', () => {
  const text = emptyResultText({ collected: 0, matching: 0, active });
  assert.match(text, /Новых вакансий нет/);
  assert.match(text, /Источники ничего не вернули/);
  assert.match(text, /поисковые фразы/);
});

test('когда всё отсеяли фильтры — перечисляем какие именно', () => {
  const text = emptyResultText({ collected: 210, matching: 0, active });
  assert.match(text, /210 вакансий/);
  // Разряды в ru-RU разделяются неразрывным пробелом, поэтому \s.
  assert.match(text, /зарплата от 80\s000\s₽/);
  assert.match(text, /поддержк/);
  assert.match(text, /\/settings/, 'должна быть подсказка, где менять');
});

test('в список причин попадают только включённые фильтры', () => {
  const text = emptyResultText({
    collected: 100,
    matching: 0,
    active: { filters: { minSalary: 0, titleKeywords: [], remoteOnly: true, schedules: ['гибк'] } },
  });
  assert.match(text, /только удалённо/);
  assert.match(text, /гибк/);
  assert.doesNotMatch(text, /зарплата от/, 'порог не задан — не упоминаем');
});

test('фильтр по опыту попадает в причины', () => {
  const text = emptyResultText({
    collected: 50,
    matching: 0,
    active: { filters: { maxExperienceYears: 1 } },
  });
  assert.match(text, /опыт до 1 лет/);
});

test('когда всё подходящее уже присылали — говорим прямо', () => {
  const text = emptyResultText({ collected: 210, matching: 17, active });
  assert.match(text, /уже присылал/);
  assert.doesNotMatch(text, /Ослабить/, 'фильтры тут не виноваты');
});

test('пустой результат не выдумывает причин, если фильтров нет', () => {
  const text = emptyResultText({ collected: 10, matching: 0, active: { filters: {} } });
  assert.match(text, /10 вакансий/);
  assert.doesNotMatch(text, /Сейчас отсекают/);
});

test('сбой источника описан отдельно от «нет вакансий»', () => {
  const text = failureText([{ label: 'hh.ru / поддержка', reason: 'HTTP 503' }]);
  assert.match(text, /Источник недоступен/);
  assert.match(text, /hh\.ru/);
  assert.match(text, /HTTP 503/);
  assert.match(text, /Остальные источники продолжают работать/);
});

test('в сообщении о сбоях не больше пяти строк подробностей', () => {
  const many = Array.from({ length: 12 }, (_, i) => ({ label: `Источник ${i}`, reason: 'таймаут' }));
  const text = failureText(many);
  const mentioned = [...text.matchAll(/Источник \d+/g)].length;
  assert.equal(mentioned, 5, 'иначе сообщение раздуется на весь экран');
});

test('оба сообщения укладываются в лимит Telegram', () => {
  const long = {
    filters: {
      minSalary: 100000,
      titleKeywords: Array.from({ length: 40 }, (_, i) => `слово${i}`),
      schedules: ['полный', 'гибк', 'сменная', 'неполный'],
      remoteOnly: true,
      maxExperienceYears: 3,
    },
  };
  assert.ok(emptyResultText({ collected: 500, matching: 0, active: long }).length <= 4096);
  assert.ok(failureText(Array.from({ length: 20 }, () => ({ label: 'X'.repeat(80), reason: 'Y'.repeat(80) }))).length <= 4096);
});
