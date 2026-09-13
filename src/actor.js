import crypto from 'node:crypto';
import { Actor } from 'apify';
import { PlaywrightCrawler, RequestQueue, Dataset } from 'crawlee';

await Actor.init();

const INPUT = await Actor.getInput() ?? {};

const defaultStartUrls = [
  'https://pandeyramu.com.np/all-subjects/',
  'https://pandeyramu.com.np/subject/physics/',
  'https://pandeyramu.com.np/subject/chemistry/',
  'https://pandeyramu.com.np/subject/botany/',
  'https://pandeyramu.com.np/subject/zoology/',
  'https://pandeyramu.com.np/subject/mat/',
];

const startUrls = (INPUT.startUrls?.length ? INPUT.startUrls : defaultStartUrls)
  .map(x => typeof x === 'string' ? { url: x } : x);

const maxConcurrency = Number(INPUT.maxConcurrency ?? 2);
const maxRequests = Number(INPUT.maxRequests ?? 1000);

const queue = await RequestQueue.open();
const dataset = await Dataset.open();
const kvStore = await Actor.openKeyValueStore();

// Persistent across Actor runs. This prevents the same questionId from being
// inserted again when a later run selects the same MCQ.
const seen = (await kvStore.getValue('SEEN_QUESTIONS')) ?? {};

for (const item of startUrls) {
  await queue.addRequest({
    url: item.url,
    uniqueKey: 'seed:' + item.url,
    userData: { type: 'discover' },
  });
}

const crawler = new PlaywrightCrawler({
  requestQueue: queue,
  maxConcurrency,
  maxRequestsPerCrawl: maxRequests,
  navigationTimeoutSecs: 60,
  requestHandlerTimeoutSecs: 180,
  maxRequestRetries: 3,

  async requestHandler({ page, request, log }) {
    const chapterUrls = await page.evaluate(() => {
      const out = new Set();

      for (const a of document.querySelectorAll('a[href]')) {
        try {
          const u = new URL(a.href, location.href);
          if (u.origin !== location.origin) continue;

          if (/^\/chapter\/[^/]+\/?$/i.test(u.pathname)) {
            out.add(u.href.split('#')[0]);
          }
        } catch {}
      }

      return [...out];
    });

    for (const url of chapterUrls) {
      await queue.addRequest({
        url,
        uniqueKey: 'chapter:' + url,
        userData: { type: 'chapter' },
      });
    }

    if (request.userData?.type !== 'chapter') {
      log.info('Discovered ' + chapterUrls.length + ' chapter URLs from ' + request.url);
      return;
    }

    // Submit the quiz in the browser, exactly like the working Chrome workflow.
    const state = await page.evaluate(() => {
      const form = document.querySelector('form.quiz-form');
      return form
        ? {
            hasForm: true,
            submitted: form.classList.contains('submitted'),
            questionCount: document.querySelectorAll('.question-block').length,
          }
        : {
            hasForm: false,
            submitted: false,
            questionCount: document.querySelectorAll('.question-block').length,
          };
    });

    if (state.hasForm && !state.submitted) {
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
      await page.waitForTimeout(500);
    }

    const resultState = await page.evaluate(() => ({
      submitted: !!document.querySelector('form.quiz-form.submitted'),
      questionCount: document.querySelectorAll('.question-block').length,
      answers: document.querySelectorAll('.question-block label.correct').length,
      explanations: document.querySelectorAll('.question-block .solution-text').length,
    }));

    if (!resultState.submitted) {
      log.warning('Quiz was not submitted successfully: ' + request.url);
    }

    const items = await page.evaluate(() => {
      return [...document.querySelectorAll('.question-block')].map(q => {
        const opts = {};

        for (const input of q.querySelectorAll('input[type="radio"]')) {
          const label = input.closest('label');
          opts[input.value] =
            label?.querySelector('.option-text')?.textContent.trim() || '';
        }

        return {
          sourceUrl: location.href,
          chapterUrl: location.href,
          questionId: q.dataset.questionId || '',
          number: Number(q.dataset.questionNumber || 0),
          question: (q.querySelector('strong')?.textContent || '')
            .trim()
            .replace(/^\d+\.\s*/, ''),
          A: opts.A || '',
          B: opts.B || '',
          C: opts.C || '',
          D: opts.D || '',
          answer: q.querySelector('label.correct input[type="radio"]')?.value || '',
          explanation:
            q.querySelector('.solution-text')?.textContent.trim() || '',
        };
      });
    });

    let newCount = 0;
    let duplicateCount = 0;
    let incompleteCount = 0;

    for (const item of items) {
      const normalizedQuestion = String(item.question || '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();

      if (!normalizedQuestion) continue;

      const dedupeKey = item.questionId
        ? 'qid:' + item.questionId
        : 'sha:' + crypto
            .createHash('sha256')
            .update(item.chapterUrl + '|' + normalizedQuestion)
            .digest('hex');

      if (seen[dedupeKey]) {
        duplicateCount++;
        continue;
      }

      // Retry incomplete items on a future run instead of permanently marking them.
      if (!item.answer || !item.explanation) {
        incompleteCount++;
        continue;
      }

      seen[dedupeKey] = 1;

      await dataset.pushData({
        ...item,
        dedupeKey,
        collectedAt: new Date().toISOString(),
      });

      newCount++;
    }

    log.info(
      'Chapter ' + request.url +
      ': ' + items.length +
      ' questions, ' + newCount +
      ' new, ' + duplicateCount +
      ' duplicates, ' + incompleteCount +
      ' incomplete'
    );
  },
});

await crawler.run();

await kvStore.setValue('SEEN_QUESTIONS', seen);

await Actor.setValue('RUN_STATS', {
  completedAt: new Date().toISOString(),
  startUrls: startUrls.map(x => x.url),
  message: 'Chapter cycle completed. Run again to collect newly available questions; duplicates are skipped.',
});

await Actor.exit();
