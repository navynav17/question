import crypto from 'node:crypto';
import { Actor } from 'apify';
import { PlaywrightCrawler, RequestQueue, Dataset } from 'crawlee';

await Actor.init();
const INPUT = await Actor.getInput() ?? {};
const startUrls = (INPUT.startUrls?.length ? INPUT.startUrls : [
  'https://pandeyramu.com.np/mcq/',
]).map(x => typeof x === 'string' ? { url: x } : x);

const queue = await RequestQueue.open();
const dataset = await Dataset.open();
const kv = await Actor.openKeyValueStore();
const seen = (await kv.getValue('SEEN_QUESTIONS')) ?? {};

for (const x of startUrls) await queue.addRequest({
  url: x.url, uniqueKey: 'seed:' + x.url, userData: { type: 'discover' }
});

const crawler = new PlaywrightCrawler({
  requestQueue: queue,
  maxConcurrency: Number(INPUT.maxConcurrency ?? 2),
  maxRequestsPerCrawl: Number(INPUT.maxRequests ?? 2000),
  navigationTimeoutSecs: 60,
  requestHandlerTimeoutSecs: 180,
  maxRequestRetries: 3,

  async requestHandler({ page, request, log }) {
    const mcqUrls = await page.evaluate(() => {
      const out = new Set();
      for (const a of document.querySelectorAll('a[href]')) {
        try {
          const u = new URL(a.href, location.href);
          if (u.origin === location.origin && /^\/mcq\/[^/]+\/?$/i.test(u.pathname)) {
            out.add(u.href.split('#')[0]);
          }
        } catch {}
      }
      return [...out];
    });

    for (const url of mcqUrls) await queue.addRequest({
      url, uniqueKey: 'mcq:' + url, userData: { type: 'mcq' }
    });

    if (request.userData?.type !== 'mcq') {
      log.info('Discovered ' + mcqUrls.length + ' MCQ collection URLs from ' + request.url);
      return;
    }

    // The /mcq/<slug>/ page exposes the same quiz form used in Chrome.
    const before = await page.evaluate(() => ({
      hasForm: !!document.querySelector('form.quiz-form'),
      submitted: !!document.querySelector('form.quiz-form.submitted'),
      questions: document.querySelectorAll('.question-block').length
    }));

    if (before.hasForm && !before.submitted) {
      const username = 'Collector_' + crypto.randomUUID().replaceAll('-', '').slice(0, 12);
      await page.evaluate((username) => {
        const form = document.querySelector('form.quiz-form');
        if (!form) return;
        let input = form.querySelector('input[name="name"]');
        if (!input) {
          input = document.createElement('input');
          input.type = 'hidden';
          input.name = 'name';
          form.appendChild(input);
        }
        input.value = username;
        form.submit();
      }, username);
      await page.waitForLoadState('networkidle').catch(() => {});
      await page.waitForTimeout(700);
    }

    const result = await page.evaluate(() => ({
      submitted: !!document.querySelector('form.quiz-form.submitted'),
      questions: document.querySelectorAll('.question-block').length,
      answers: document.querySelectorAll('.question-block label.correct').length,
      explanations: document.querySelectorAll('.question-block .solution-text').length
    }));

    const items = await page.evaluate(() => [...document.querySelectorAll('.question-block')].map(q => {
      const opts = {};
      q.querySelectorAll('input[type="radio"]').forEach(input => {
        opts[input.value] = input.closest('label')?.querySelector('.option-text')?.textContent.trim() || '';
      });
      return {
        sourceUrl: location.href,
        mcqUrl: location.href,
        questionId: q.dataset.questionId || '',
        number: Number(q.dataset.questionNumber || 0),
        question: (q.querySelector('strong')?.textContent || '').trim().replace(/^\d+\.\s*/, ''),
        A: opts.A || '', B: opts.B || '', C: opts.C || '', D: opts.D || '',
        answer: q.querySelector('label.correct input[type="radio"]')?.value || '',
        explanation: q.querySelector('.solution-text')?.textContent.trim() || ''
      };
    }));

    let fresh = 0, duplicate = 0, incomplete = 0;
    for (const item of items) {
      if (!item.question) continue;
      const key = item.questionId
        ? 'qid:' + item.questionId
        : 'sha:' + crypto.createHash('sha256').update(item.mcqUrl + '|' + item.question.toLowerCase().replace(/\s+/g, ' ')).digest('hex');

      if (seen[key]) { duplicate++; continue; }
      if (!item.answer || !item.explanation || !item.A || !item.B || !item.C || !item.D) {
        incomplete++; continue;
      }

      seen[key] = 1;
      await dataset.pushData({
        ...item,
        dedupeKey: key,
        collectedAt: new Date().toISOString()
      });
      fresh++;
    }

    log.info('MCQ ' + request.url + ': ' + items.length + ' questions, ' +
      fresh + ' new, ' + duplicate + ' duplicates, ' + incomplete + ' incomplete; ' +
      'submitted=' + result.submitted);
  }
});

await crawler.run();
await kv.setValue('SEEN_QUESTIONS', seen);
await Actor.setValue('RUN_STATS', {
  completedAt: new Date().toISOString(),
  message: 'MCQ collection cycle completed; persistent question-ID deduplication enabled.'
});
await Actor.exit();
