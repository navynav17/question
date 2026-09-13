import crypto from 'node:crypto';
import { Actor } from 'apify';
import { PlaywrightCrawler, RequestQueue, Dataset } from 'crawlee';

await Actor.init();

const INPUT = await Actor.getInput() ?? {};
const configuredUrls = (INPUT.startUrls ?? [])
  .map(x => typeof x === 'string' ? x : x?.url)
  .filter(Boolean);

const startUrls = [...new Set(configuredUrls.length ? configuredUrls : ['https://pandeyramu.com.np/'])];

const queue = await RequestQueue.open();
const dataset = await Dataset.open();
const kv = await Actor.openKeyValueStore();
const seen = (await kv.getValue('SEEN_QUESTIONS')) ?? {};

for (const url of startUrls) {
  const isMcq = (() => {
    try {
      const u = new URL(url);
      return u.origin === 'https://pandeyramu.com.np' && /^\/mcq\/[^/]+\/?$/i.test(u.pathname);
    } catch { return false; }
  })();

  await queue.addRequest({
    url,
    uniqueKey: (isMcq ? 'mcq:' : 'seed:') + url,
    userData: { type: isMcq ? 'mcq' : 'discover' }
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
      const username = String(INPUT.username ?? 'Apify Collector').trim() || 'Apify Collector';

      const started = await page.evaluate((username) => {
        const clean = s => (s || '').replace(/\s+/g, ' ').trim();
        const visible = el => {
          if (!el) return false;
          const s = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
        };

        const text = clean(document.body.innerText);
        const nameInput = [...document.querySelectorAll(
          'input[type="text"], input:not([type]), input[name*="name" i], input[id*="name" i], input[placeholder*="name" i]'
        )].find(visible);

        const startButton = [...document.querySelectorAll(
          'button, input[type="submit"], input[type="button"]'
        )].find(el => visible(el) && /start\s+mcq\s+test/i.test(clean(el.innerText || el.value)));

        if (!/enter your name to begin the test/i.test(text) && !startButton) {
          return { startScreen: false, filled: false, clicked: false };
        }

        if (nameInput) {
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(nameInput, username);
          else nameInput.value = username;
          nameInput.dispatchEvent(new Event('input', { bubbles: true }));
          nameInput.dispatchEvent(new Event('change', { bubbles: true }));
          nameInput.dispatchEvent(new Event('blur', { bubbles: true }));
        }

        if (startButton) {
          startButton.click();
          return { startScreen: true, filled: !!nameInput, clicked: true, username };
        }

        const form = nameInput?.closest('form');
        if (form) {
          if (typeof form.requestSubmit === 'function') form.requestSubmit();
          else form.submit();
          return { startScreen: true, filled: true, clicked: true, username };
        }

        return { startScreen: true, filled: !!nameInput, clicked: false, username };
      }, username);

      if (started.startScreen) {
        log.info('MCQ start screen: ' + JSON.stringify(started));
        if (!started.clicked) throw new Error('Could not start MCQ test.');

        await page.waitForTimeout(1500);
        await page.waitForLoadState('networkidle').catch(() => {});
        await page.waitForTimeout(1500);
      }

      await page.waitForFunction(
        () => document.querySelectorAll('.question-block').length > 0,
        { timeout: 30000 }
      );

      const initial = await page.evaluate(() => ({
        url: location.href,
        questionBlocks: document.querySelectorAll('.question-block').length,
        forms: document.querySelectorAll('form').length,
        buttons: [...document.querySelectorAll('button, input[type="submit"], input[type="button"]')]
          .map(x => (x.innerText || x.value || x.getAttribute('aria-label') || '').trim())
          .filter(Boolean)
      }));

      log.info('MCQ page ' + request.url + ': forms=' + initial.forms +
        ', buttons=' + JSON.stringify(initial.buttons) +
        ', questionBlocks=' + initial.questionBlocks);

      // Submit only when the page is still in the unanswered test state.
      let state = await page.evaluate(() => ({
        questionBlocks: document.querySelectorAll('.question-block').length,
        correct: document.querySelectorAll('.question-block label.correct').length,
        solutions: document.querySelectorAll('.question-block .solution-text').length
      }));

      if (state.questionBlocks > 0 && (state.correct === 0 || state.solutions === 0)) {
        const submitResult = await page.evaluate(() => {
          const clean = s => (s || '').replace(/\s+/g, ' ').trim();
          const visible = el => {
            if (!el) return false;
            const s = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
          };

          const candidates = [...document.querySelectorAll(
            'button, input[type="submit"], input[type="button"]'
          )];

          // Prefer the final "Submit Test" control. "Submit Now" can open
          // the confirmation dialog, so if that is what the site shows,
          // click it first and then click the confirmation.
          const findButton = re => candidates.find(el =>
            visible(el) && re.test(clean(el.innerText || el.value || el.getAttribute('aria-label')))
          );

          const finalButton = findButton(/^submit\s+test$/i) ||
            findButton(/^(finish|show answers|check answers|view result|see result|reveal)$/i);

          if (finalButton) {
            finalButton.click();
            return { clicked: true, text: clean(finalButton.innerText || finalButton.value) };
          }

          const submitNow = findButton(/^submit\s+now$/i);
          if (submitNow) {
            submitNow.click();
            return { clicked: true, text: clean(submitNow.innerText || submitNow.value), confirmation: true };
          }

          return { clicked: false, text: '' };
        });

        log.info('Submit action: ' + JSON.stringify(submitResult));

        if (submitResult.clicked) {
          await page.waitForTimeout(1200);

          // If "Submit Now" opened a confirmation modal, click the actual
          // "Submit Test" button now.
          if (submitResult.confirmation) {
            const confirmed = await page.evaluate(() => {
              const clean = s => (s || '').replace(/\s+/g, ' ').trim();
              const visible = el => {
                if (!el) return false;
                const s = getComputedStyle(el);
                const r = el.getBoundingClientRect();
                return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
              };
              const btn = [...document.querySelectorAll('button, input[type="submit"], input[type="button"]')]
                .find(el => visible(el) && /^submit\s+test$/i.test(clean(el.innerText || el.value)));
              if (!btn) return false;
              btn.click();
              return true;
            });
            log.info('Submit confirmation: ' + JSON.stringify({ clicked: confirmed }));
          }

          // Do not assume navigation means submission is complete.
          // Wait specifically for the selectors used by the working browser
          // extraction script.
          await page.waitForFunction(
            () =>
              document.querySelectorAll('.question-block label.correct').length > 0 ||
              document.querySelectorAll('.question-block .solution-text').length > 0 ||
              /submitted|result|score|review/i.test(document.body.innerText),
            { timeout: 30000 }
          ).catch(() => {});

          await page.waitForTimeout(1000);
        }

        state = await page.evaluate(() => ({
          questionBlocks: document.querySelectorAll('.question-block').length,
          correct: document.querySelectorAll('.question-block label.correct').length,
          solutions: document.querySelectorAll('.question-block .solution-text').length,
          checked: document.querySelectorAll('.question-block input[type="radio"]:checked').length
        }));
      }

      const pageMeta = await page.evaluate(() => {
        const clean = s => (s || '').replace(/\s+/g, ' ').trim();
        const path = location.pathname.replace(/\/+$/, '');
        const parts = path.split('/').filter(Boolean);
        const i = parts.findIndex(x => x.toLowerCase() === 'mcq');
        const mcqSlug = i >= 0 ? (parts[i + 1] || '') : '';

        let chapter = '';
        let subject = '';

        for (const a of document.querySelectorAll('a[href]')) {
          const text = clean(a.textContent);
          if (!text) continue;
          try {
            const p = new URL(a.href, location.href).pathname;
            if (/\/chapter\//i.test(p)) chapter = text;
            if (/\/subject\//i.test(p)) subject = text;
          } catch {}
        }

        if (!chapter && mcqSlug) {
          chapter = mcqSlug.replace(/[-_]+/g, ' ').replace(/\b\w/g, m => m.toUpperCase());
        }

        return { subject, chapter, subchapter: '', mcqSlug };
      });

      const items = await page.evaluate((meta) => {
        const clean = s => (s || '').replace(/\s+/g, ' ').trim();

        return [...document.querySelectorAll('.question-block')].map(q => {
          const opts = {};
          q.querySelectorAll('input[type="radio"]').forEach(input => {
            const label = input.closest('label');
            opts[input.value] = clean(label?.querySelector('.option-text')?.textContent);
          });

          const question = clean(q.querySelector('strong')?.textContent)
            .replace(/^\d+\.\s*/, '');

          return {
            subject: meta.subject,
            chapter: meta.chapter,
            subchapter: meta.subchapter,
            sourceUrl: location.href,
            mcqUrl: location.href,
            mcqSlug: meta.mcqSlug,
            questionId: q.dataset.questionId || '',
            number: Number(q.dataset.questionNumber || 0),
            question,
            A: opts.A || '',
            B: opts.B || '',
            C: opts.C || '',
            D: opts.D || '',
            answer: q.querySelector('label.correct input[type="radio"]')?.value || '',
            explanation: clean(q.querySelector('.solution-text')?.textContent)
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
              .update(item.mcqUrl + '|' + item.question.toLowerCase().replace(/\s+/g, ' '))
              .digest('hex');

        if (seen[key]) {
          duplicate++;
          continue;
        }

        if (!item.answer || !item.A || !item.B || !item.C || !item.D || !item.explanation) {
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

      await saveSeen();

      log.info(
        'MCQ ' + request.url +
        ': ' + items.length + ' questions, ' +
        fresh + ' new, ' + duplicate + ' duplicates, ' +
        incomplete + ' incomplete; submittedState=' +
        JSON.stringify(state)
      );

      return;
    }

    // Discovery mode: follow subject/chapter indexes and direct /mcq/{slug}/ pages.
    const discovered = await page.evaluate(() => {
      const mcq = new Set();
      const other = new Set();

      for (const a of document.querySelectorAll('a[href]')) {
        try {
          const u = new URL(a.href, location.href);
          if (u.origin !== location.origin) continue;
          u.hash = '';
          const path = u.pathname.replace(/\/{2,}/g, '/');

          if (/^\/mcq\/[^/]+\/?$/i.test(path)) mcq.add(u.href);
          if (/^\/(chapter|subject)\//i.test(path) || /^\/mcq\/?$/i.test(path)) other.add(u.href);
        } catch {}
      }

      return { mcq: [...mcq], other: [...other] };
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
  message: 'MCQ collection completed with persistent question deduplication.'
});

await Actor.exit();
