import { Actor, Dataset } from 'apify';

await Actor.init();

const INPUT = await Actor.getInput() ?? {};
const API_BASE = 'https://exam-sahayogi.onrender.com/api/v1';
const CATALOG_URL = API_BASE + '/exams/frontend-data';
const OUTPUT_KEY = 'ALL_EXAMSAHAYOGI_MCQS';

const dataset = await Dataset.open();
const kv = await Actor.openKeyValueStore();

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function normalizeQuestion(q, meta) {
  return {
    categoryId: meta.categoryId ?? null,
    category: meta.category ?? '',
    subcategoryId: meta.subcategoryId ?? null,
    subcategory: meta.subcategory ?? '',
    quizId: meta.quizId ?? null,
    quizTitle: meta.quizTitle ?? '',
    partId: q.partId ?? meta.partId ?? null,
    partTitle: q.partTitle ?? meta.partTitle ?? '',
    questionId: q.id ?? null,
    question: clean(q.question),
    options: Array.isArray(q.options) ? q.options : [],
    answer: clean(q.answer),
  };
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0' }
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(url + ' -> HTTP ' + response.status + ': ' + text.slice(0, 500));
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(url + ' returned non-JSON');
  }
}

const catalog = await fetchJson(CATALOG_URL);
if (!Array.isArray(catalog)) throw new Error('Unexpected catalog response');

const all = [];
const stats = {
  categories: 0,
  subcategories: 0,
  quizzes: 0,
  parts: 0,
  questions: 0,
  uniqueQuestions: 0,
  apiQuestions: 0,
};

const questionKeys = new Set();

for (const category of catalog) {
  stats.categories++;

  for (const subcategory of category.subcategories || []) {
    stats.subcategories++;

    for (const quiz of subcategory.quizzes || []) {
      stats.quizzes++;

      for (const part of quiz.parts || []) {
        stats.parts++;

        let questions = Array.isArray(part.questions) ? part.questions : [];

        // frontend-data can return empty question arrays for database-backed parts.
        // Fetch the part endpoint when that happens.
        if (questions.length === 0 && part.id) {
          const candidates = [
            API_BASE + '/user/quiz/' + quiz.id + '/' + part.id,
            API_BASE + '/v1/quizzes/' + quiz.id + '/' + part.id,
            API_BASE + '/v1/questions/' + part.id,
            API_BASE + '/questions/' + part.id,
          ];

          for (const url of candidates) {
            try {
              const data = await fetchJson(url);
              if (Array.isArray(data)) {
                questions = data;
                stats.apiQuestions += questions.length;
                break;
              }
              if (Array.isArray(data?.questions)) {
                questions = data.questions;
                stats.apiQuestions += questions.length;
                break;
              }
              if (Array.isArray(data?.data)) {
                questions = data.data;
                stats.apiQuestions += questions.length;
                break;
              }
            } catch {
              // Try the next known route.
            }
          }
        }

        for (const q of questions) {
          if (!q || typeof q !== 'object') continue;

          const row = normalizeQuestion(q, {
            categoryId: category.id,
            category: category.name,
            subcategoryId: subcategory.id,
            subcategory: subcategory.name,
            quizId: quiz.id,
            quizTitle: quiz.title,
            partId: part.id,
            partTitle: part.title,
          });

          if (!row.question) continue;

          stats.questions++;

          const key = row.question.toLowerCase();
          if (questionKeys.has(key)) continue;
          questionKeys.add(key);

          all.push(row);
        }
      }
    }
  }
}

stats.uniqueQuestions = all.length;

await kv.setValue(OUTPUT_KEY, {
  source: CATALOG_URL,
  extractedAt: new Date().toISOString(),
  stats,
  questions: all,
});

await dataset.pushData({
  type: 'extraction_summary',
  source: CATALOG_URL,
  stats,
});

for (const row of all) {
  await dataset.pushData(row);
}

console.log('ExamSahayogi extraction complete:', JSON.stringify(stats));
console.log('KV OUTPUT:', OUTPUT_KEY);
await Actor.exit();
