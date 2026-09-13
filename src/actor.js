import crypto from 'node:crypto';
import { Actor } from 'apify';
import { PlaywrightCrawler, RequestQueue, Dataset } from 'crawlee';

await Actor.init();

const INPUT = await Actor.getInput() ?? {};
const configuredUrls = (INPUT.startUrls ?? [])
  .map(x => typeof x === 'string' ? x : x?.url)
  .filter(Boolean);

const startUrls = [...new Set([
  ...configuredUrls,
  'https://pandeyramu.com.np/',
  'https://pandeyramu.com.np/mcq/'
])];

const queue = await RequestQueue.open();
const dataset = await Dataset.open();
const kv = await Actor.openKeyValueStore();

const seen = (await kv.getValue('SEEN_QUESTIONS')) ?? {};

for (const url of startUrls) {
  await queue.addRequest({
    url,
    uniqueKey: 'seed:' + url,
    userData: { type: 'discover' }
  });
}

async function saveSeen() {
  await kv.setValue('SEEN_QUESTIONS', seen);
}

const crawler = new PlaywrightCrawler({
  requestQueue: queue,
  maxConcurrency: Number(INPUT.maxConcurrency ?? 1),
  maxRequestsPerCrawl: Number(INPUT.maxRequests ?? 3000),
  navigationTimeoutSecs: 60,
  requestHandlerTimeoutSecs: 180,
  maxRequestRetries: 3,

  async requestHandler({ page, request, log }) {
    if (request.userData?.type === 'mcq') {
      // Some MCQ pages require the ?new=1 state to start a fresh quiz.
      if (!/[?&]new=1(?:&|$)/i.test(request.url)) {
        const freshUrl = request.url + (request.url.includes('?') ? '&' : '?') + 'new=1';
        await queue.addRequest({
          url: freshUrl,
          uniqueKey: 'mcq-new:' + freshUrl,
          userData: { type: 'mcq' }
        });
        return;
      }

      // The important part: reproduce the browser workflow.
      // Do not call form.submit() because that can bypass the site's submit
      // handler. Click the real submit button/requestSubmit instead.
      const initial = await page.evaluate(() => ({
        url: location.href,
        forms: document.querySelectorAll('form').length,
        buttons: [...document.querySelectorAll('button, input[type="submit"]')]
          .map(x => (x.innerText || x.value || x.getAttribute('aria-label') || '').trim())
          .filter(Boolean),
        questionBlocks: document.querySelectorAll('.question-block').length
      }));

      log.info('MCQ page ' + request.url + ': forms=' + initial.forms +
        ', buttons=' + JSON.stringify(initial.buttons) +
        ', questionBlocks=' + initial.questionBlocks);

      // If the page already contains the submitted/review state, extract it.
      let state = await page.evaluate(() => ({
        questionBlocks: document.querySelectorAll('.question-block').length,
        correct: document.querySelectorAll('.question-block label.correct').length,
        solutions: document.querySelectorAll('.question-block .solution-text').length
      }));

      if (state.questionBlocks === 0 || state.correct === 0) {
        const clicked = await page.evaluate(() => {
          const normalize = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();

          const candidates = [
            ...document.querySelectorAll('button'),
            ...document.querySelectorAll('input[type="submit"]'),
            ...document.querySelectorAll('input[type="button"]')
          ];

          const button = candidates.find(el => {
            const text = normalize(el.innerText || el.value || el.getAttribute('aria-label'));
            return /submit|finish|show answers|check answers|view result|see result|reveal/i.test(text);
          });

          if (button) {
            button.click();
            return {
              clicked: true,
              text: (button.innerText || button.value || '').trim()
            };
          }

          const form = document.querySelector('form');
          if (form) {
            if (typeof form.requestSubmit === 'function') form.requestSubmit();
            else form.submit();
            return { clicked: true, text: 'form.requestSubmit()' };
          }

          return { clicked: false, text: '' };
        });

        log.info('Submit action: ' + JSON.stringify(clicked));

        if (clicked.clicked) {
          await page.waitForLoadState('domcontentloaded').catch(() => {});
          await page.waitForTimeout(1500);
          await page.waitForLoadState('networkidle').catch(() => {});
          await page.waitForTimeout(1000);
        }

        state = await page.evaluate(() => ({
          questionBlocks: document.querySelectorAll('.question-block').length,
          correct: document.querySelectorAll('.question-block label.correct').length,
          solutions: document.querySelectorAll('.question-block .solution-text').length
        }));
      }

      const pageMeta = await page.evaluate(() => {
        const clean = s => (s || '').replace(/\s+/g, ' ').trim();
        const path = location.pathname.replace(/\/+$/, '');
        const parts = path.split('/').filter(Boolean);
        const mcqPos = parts.findIndex(x => x.toLowerCase() === 'mcq');
        const slug = mcqPos >= 0 ? (parts[mcqPos + 1] || '') : '';

        const titleCase = s => s
          .replace(/[-_]+/g, ' ')
          .replace(/\b\w/g, m => m.toUpperCase());

        const links = [...document.querySelectorAll(
          'nav a, .breadcrumb a, .breadcrumbs a, [aria-label*="breadcrumb" i] a'
        )].map(a => ({
          text: clean(a.textContent),
          href: a.href || ''
        })).filter(x => x.text);

        let subject = '';
        let chapter = '';

        for (const item of links) {
          let p = '';
          try { p = new URL(item.href, location.href).pathname; } catch {}
          if (/\/subject\//i.test(p)) subject = item.text;
          if (/\/chapter\//i.test(p)) chapter = item.text;
        }

        if (!chapter && slug) chapter = titleCase(slug);

        const headings = [...document.querySelectorAll(
          'h1, h2, .page-title, .chapter-title'
        )].map(x => clean(x.textContent)).filter(Boolean);

        if (!chapter && headings[0]) chapter = headings[0];

        return {
          subject,
          chapter,
          subchapter: '',
          mcqSlug: slug
        };
      });

      const items = await page.evaluate((meta) => {
        const clean = s => (s || '').replace(/\s+/g, ' ').trim();

        return [...document.querySelectorAll('.question-block')].map(q => {
          const opts = {};

          q.querySelectorAll('input[type="radio"]').forEach(input => {
            const label = input.closest('label');
            opts[input.value] =
              clean(label?.querySelector('.option-text')?.textContent);
          });

          const questionText = clean(
            q.querySelector('strong')?.textContent ||
            q.querySelector('[data-question-text]')?.getAttribute('data-question-text')
          ).replace(/^\d+\.\s*/, '');

          return {
            subject: meta.subject || '',
            chapter: meta.chapter || '',
            subchapter: meta.subchapter || '',
            sourceUrl: location.href,
            mcqUrl: location.href,
            questionId: q.dataset.questionId || '',
            number: Number(q.dataset.questionNumber || 0),
            question: questionText,
            A: opts.A || '',
            B: opts.B || '',
            C: opts.C || '',
            D: opts.D || '',
            answer: q.querySelector(
              'label.correct input[type="radio"]'
            )?.value || '',
            explanation: clean(
              q.querySelector('.solution-text')?.textContent
            )
          };
        });
      }, pageMeta);

      let fresh = 0;
      let duplicate = 0;
      let incomplete = 0;

      for (const item of items) {
        if (!item.question) continue;

        const key = item.questionId
          ? 'qid:' + item.questionId
          : 'sha:' + crypto.createHash('sha256')
              .update(
                item.mcqUrl + '|' +
                item.question.toLowerCase().replace(/\s+/g, ' ')
              )
              .digest('hex');

        if (seen[key]) {
          duplicate++;
          continue;
        }

        if (
          !item.answer ||
          !item.A ||
          !item.B ||
          !item.C ||
          !item.D
        ) {
          incomplete++;
          continue;
        }

        seen[key] = 1;

        await dataset.pushData({
          ...item,
          dedupeKey: key,
          collectedAt: new Date().toISOString()
        });

        fresh++;
      }

      // Persist after every MCQ so a long run can safely resume.
      await saveSeen();

      log.info(
        'MCQ ' + request.url +
        ': ' + items.length + ' questions, ' +
        fresh + ' new, ' +
        duplicate + ' duplicates, ' +
        incomplete + ' incomplete; ' +
        'submittedState=' + JSON.stringify(state)
      );

      return;
    }

    // Discovery mode.
    const discovered = await page.evaluate(() => {
      const mcq = new Set();
      const other = new Set();

      for (const a of document.querySelectorAll('a[href]')) {
        try {
          const u = new URL(a.href, location.href);
          if (u.origin !== location.origin) continue;

          u.hash = '';
          const path = u.pathname.replace(/\/+?/g, '/');

          // All /mcq/<slug>/ pages, including pages not linked from the home page.
          if (/^\/mcq\/[^/]+\/?$/i.test(path)) {
            mcq.add(u.href);
          }

          // Keep crawling site indexes/subject/chapter pages.
          if (
            /^\/(subject|chapter|biology|physics|chemistry|botany|zoology|environmental-science|environmental-studies)\//i.test(path)
          ) {
            other.add(u.href);
          }
        } catch {}
      }

      return {
        mcq: [...mcq],
        other: [...other]
      };
    });

    for (const url of discovered.mcq) {
      await queue.addRequest({
        url,
        uniqueKey: 'mcq:' + url,
        userData: { type: 'mcq' }
      });
    }

    for (const url of discovered.other) {
      await queue.addRequest({
        url,
        uniqueKey: 'discover:' + url,
        userData: { type: 'discover' }
      });
    }

    log.info(
      'From ' + request.url +
      ': discovered ' + discovered.mcq.length +
      ' MCQ URLs and ' + discovered.other.length + ' index URLs'
    );
  }
});

await crawler.run();
await saveSeen();

await Actor.setValue('RUN_STATS', {
  completedAt: new Date().toISOString(),
  message: 'MCQ collection completed. Questions are deduplicated persistently by question ID/hash.'
});

await Actor.exit();
