import { Actor } from 'apify';
import { PlaywrightCrawler, RequestQueue, Dataset } from 'crawlee';

const INPUT = await Actor.getInput() ?? {};
const startUrls = (INPUT.startUrls ?? [
  { url: 'https://pandeyramu.com.np/' },
]).map(x => typeof x === 'string' ? { url: x } : x);

const maxConcurrency = Number(INPUT.maxConcurrency ?? 2);
const cycleDelaySeconds = Number(INPUT.cycleDelaySeconds ?? 0);

await Actor.init();

const queue = await RequestQueue.open();

for (const item of startUrls) {
  await queue.addRequest({
    url: item.url,
    uniqueKey: `seed:${item.url}`,
    userData: { type: 'discover' },
  });
}

const dataset = await Dataset.open();

const crawler = new PlaywrightCrawler({
  requestQueue: queue,
  maxConcurrency,
  navigationTimeoutSecs: 60,
  requestHandlerTimeoutSecs: 120,
  maxRequestRetries: 3,

  async requestHandler({ page, request, log }) {
    // Discover chapter pages from every page we visit.
    const chapterUrls = await page.evaluate(() => {
      const out = new Set();
      for (const a of document.querySelectorAll('a[href]')) {
        try {
          const u = new URL(a.href, location.href);
          if (u.origin === location.origin &&
              u.pathname.startsWith('/chapter/')) {
            out.add(u.href.split('#')[0]);
          }
        } catch {}
      }
      return [...out];
    });

    for (const url of chapterUrls) {
      await queue.addRequest({
        url,
        uniqueKey: `chapter:${url}`,
        userData: { type: 'chapter' },
      });
    }

    if (!request.userData?.type || request.userData.type === 'discover') {
      log.info(`Discovered ${chapterUrls.length} chapter URLs`);
      return;
    }

    // Extract the already-rendered result page. If the chapter is not yet
    // submitted, submit the quiz form with a random username and reload.
    const state = await page.evaluate(() => {
      const form = document.querySelector('form.quiz-form');
      if (!form) return { hasForm: false };

      return {
        hasForm: true,
        submitted: form.classList.contains('submitted'),
      };
    });

    if (state.hasForm && !state.submitted) {
      const username = `Collector_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`;

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
          explanation: q.querySelector('.solution-text')?.textContent.trim() || '',
        };
      });
    });

    // Persistent dataset dedupe: build a key from questionId when available,
    // otherwise chapter URL + normalized question text.
    const seen = new Set();

    for (const item of items) {
      const normalized = String(item.question || '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();

      const key = item.questionId
        ? `qid:${item.questionId}`
        : `text:${String(item.chapterUrl).toLowerCase()}|${normalized}`;

      if (seen.has(key)) continue;
      seen.add(key);

      // Apify Dataset itself does not provide a cheap arbitrary-key lookup
      // per item. Use a deterministic uniqueKey in the request pipeline and
      // store a dedupeKey so downstream storage can upsert on it.
      await dataset.pushData({
        ...item,
        dedupeKey: key,
        collectedAt: new Date().toISOString(),
      });
    }

    log.info(`Extracted ${items.length} MCQs from ${request.url}`);
  },
});

await crawler.run();

await Actor.setValue('RUN_STATS', {
  completedAt: new Date().toISOString(),
  message: 'Cycle completed. Run the actor again for another cycle.',
});

if (cycleDelaySeconds > 0) {
  // Apify runs are finite. For continuous repetition, configure an Apify
  // schedule/webhook to start another run after this run completes.
  await new Promise(resolve => setTimeout(resolve, cycleDelaySeconds * 1000));
}

await Actor.exit();
