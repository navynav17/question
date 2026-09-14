import crypto from 'node:crypto';
import { Actor } from 'apify';
import { PuppeteerCrawler, RequestQueue, Dataset } from 'crawlee';

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

const crawler = new PuppeteerCrawler({
  requestQueue: queue,
  launchContext: {
    launchOptions: {
      executablePath: process.env.APIFY_CHROME_EXECUTABLE_PATH || '/usr/bin/google-chrome',
    },
  },
  maxConcurrency: Number(INPUT.maxConcurrency ?? 1),
  maxRequestsPerCrawl: Number(INPUT.maxRequests ?? 3000),
  navigationTimeoutSecs: 60,
  requestHandlerTimeoutSecs: 180,
  maxRequestRetries: 3,

  async requestHandler({ page, request, log }) {
    if (request.userData?.type === 'mcq') {
      const username = String(INPUT.username ?? '').trim() || 'Abcdefgh';

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

        await new Promise(resolve => setTimeout(resolve, 1500));
        await page.waitForLoadState('networkidle').catch(() => {});
        await new Promise(resolve => setTimeout(resolve, 1500));
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

      let state = await page.evaluate(() => ({
        questionBlocks: document.querySelectorAll('.question-block').length,
        correct: document.querySelectorAll('.question-block label.correct').length,
        solutions: document.querySelectorAll('.question-block .solution-text').length
      }));

      if (state.questionBlocks > 0 && (state.correct === 0 || state.solutions === 0)) {
        const buttonTexts = await page.locator('button, input[type="submit"], input[type="button"]').allTextContents();
        log.info('Submit candidates: ' + JSON.stringify(buttonTexts.map(x => x.trim()).filter(Boolean)));
        const prepared = await page.evaluate(() => {
          const blocks = [...document.querySelectorAll('.question-block')];
          let selected = 0;
          for (const q of blocks) {
            const input = q.querySelector('input[type="radio"]:checked') ||
              q.querySelector('input[type="radio"]');
            if (!input) continue;
            if (!input.checked) {
              const label = input.closest('label');
              if (label) label.click();
              else input.click();
              input.dispatchEvent(new Event('input', { bubbles: true }));
              input.dispatchEvent(new Event('change', { bubbles: true }));
            }
            if (input.checked) selected++;
          }
          return {
            questionBlocks: blocks.length,
            selected,
            checked: document.querySelectorAll('.question-block input[type="radio"]:checked').length
          };
        });
        log.info('MCQ answers prepared: ' + JSON.stringify(prepared));


        // Match the browser-console behavior: search the rendered DOM for the
        // exact visible "Submit Now" text, then invoke the element's native click.
        // Do not restrict this to <button>; the site can use another clickable element.
        const clickSubmitNowFromDom = await page.evaluate(() => {
          const visible = el => {
            if (!el) return false;
            const s = getComputedStyle(el);
            const r = el.getBoundingClientRect();
            return s.display !== 'none' && s.visibility !== 'hidden' &&
              s.opacity !== '0' && r.width > 0 && r.height > 0;
          };
          const candidates = [...document.querySelectorAll('button, input, a, [role="button"], [onclick], div, span')]
            .filter(el => visible(el) &&
              (el.innerText || el.value || '').trim().toLowerCase() === 'submit now');
          const el = candidates.find(x => {
            const p = x.parentElement;
            return !p || !visible(p) || (p.innerText || '').trim().toLowerCase() !== 'submit now';
          }) || candidates[0];
          if (!el) return { clicked: false, count: candidates.length };
          el.click();
          return {
            clicked: true,
            tag: el.tagName,
            id: el.id || '',
            className: String(el.className || ''),
            count: candidates.length
          };
        });
        log.info('DOM Submit Now click: ' + JSON.stringify(clickSubmitNowFromDom));

        const submitNow = page.getByRole('button', { name: /^submit now$/i });
        const submitTest = page.getByRole('button', { name: /^submit test$/i });

        async function clickVisible(locator, timeout = 10000) {
          const count = await locator.count();
          for (let i = 0; i < count; i++) {
            const candidate = locator.nth(i);
            if (await candidate.isVisible().catch(() => false)) {
              await candidate.click({ timeout });
              return true;
            }
          }
          return false;
        }

        let submitResult = { clicked: false, text: '', confirmation: false };

        if (clickSubmitNowFromDom.clicked) {
          submitResult = { clicked: true, text: 'Submit Now', confirmation: true };
        } else if (await clickVisible(submitNow)) {
          submitResult = { clicked: true, text: 'Submit Now', confirmation: true };
        } else if (await clickVisible(submitTest)) {
          submitResult = { clicked: true, text: 'Submit Test', confirmation: false };
        } else {
          const generic = page.getByRole('button', { name: /^(finish|show answers|check answers|view result|see result|reveal)$/i });
          if (await clickVisible(generic)) {
            submitResult = { clicked: true, text: 'generic submit', confirmation: false };
          }
        }

        log.info('Submit action: ' + JSON.stringify(submitResult));

        if (submitResult.clicked) {
          // The site's own Chrome-console behavior is driven by DOM click handlers.
          // Use a native DOM click as a fallback/confirmation path, matching Chrome.
          await new Promise(resolve => setTimeout(resolve, 1200));

          if (submitResult.confirmation) {
            const nativeSubmitTest = await page.evaluate(() => {
              const visible = el => {
                if (!el) return false;
                const s = getComputedStyle(el);
                const r = el.getBoundingClientRect();
                return s.display !== 'none' && s.visibility !== 'hidden' &&
                  r.width > 0 && r.height > 0;
              };
              const buttons = [...document.querySelectorAll('button, input[type="submit"], input[type="button"]')];
              const btn = buttons.find(el => visible(el) &&
                /^submit test$/i.test((el.innerText || el.value || '').trim()));
              if (!btn) return false;
              btn.click();
              return true;
            });
            log.info('Native Submit Test click: ' + JSON.stringify({ clicked: nativeSubmitTest }));
          } else {
            const nativeSubmit = await page.evaluate(() => {
              const visible = el => {
                if (!el) return false;
                const s = getComputedStyle(el);
                const r = el.getBoundingClientRect();
                return s.display !== 'none' && s.visibility !== 'hidden' &&
                  r.width > 0 && r.height > 0;
              };
              const buttons = [...document.querySelectorAll('button, input[type="submit"], input[type="button"]')];
              const btn = buttons.find(el => visible(el) &&
                /^(submit test|finish|show answers|check answers|view result|see result|reveal)$/i.test(
                  (el.innerText || el.value || '').trim()
                ));
              if (!btn) return false;
              btn.click();
              return true;
            });
            log.info('Native submit click: ' + JSON.stringify({ clicked: nativeSubmit }));
          }

          // The site updates the result DOM asynchronously after Submit Test.
          // Chrome DevTools shows the final answers with label.correct and
          // .solution-text, so poll the exact same DOM until the result is ready.
          await new Promise(resolve => setTimeout(resolve, 3000));

          const resultReady = await page.waitForFunction(
            () => {
              const blocks = document.querySelectorAll('.question-block');
              if (!blocks.length) return false;

              const correct = document.querySelectorAll('.question-block label.correct').length;
              const solutions = document.querySelectorAll('.question-block .solution-text').length;

              // Require at least one answer/solution marker rather than assuming
              // the page is ready immediately after the click.
              return correct > 0 || solutions > 0;
            },
            { timeout: 90000 }
          ).then(() => true).catch(() => false);

          log.info('MCQ result DOM ready: ' + JSON.stringify({
            resultReady,
            correct: await page.locator('.question-block label.correct').count(),
            solutions: await page.locator('.question-block .solution-text').count()
          }));

          // Give the page a final render cycle so classes/text inserted by
          // JavaScript are visible to the same document.querySelector calls
          // used successfully in Chrome DevTools.
          await new Promise(resolve => setTimeout(resolve, 2000));
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

      log.info('Post-submit DOM state: ' + JSON.stringify(await page.evaluate(() => ({ questionBlocks: document.querySelectorAll('.question-block').length, correct: document.querySelectorAll('.question-block label.correct').length, solutions: document.querySelectorAll('.question-block .solution-text').length, checked: document.querySelectorAll('.question-block input[type="radio"]:checked').length }))));
      const postDebug = await page.evaluate(() => {
        const blocks = [...document.querySelectorAll('.question-block')].slice(0, 2);
        return blocks.map((q, i) => ({
          index: i + 1,
          className: q.className,
          text: (q.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 1500),
          inputs: [...q.querySelectorAll('input')].map(x => ({
            type: x.type,
            value: x.value,
            checked: x.checked,
            className: x.className,
            parentClass: x.parentElement?.className || '',
            parentText: (x.parentElement?.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 300)
          })),
          labels: [...q.querySelectorAll('label')].map(x => ({
            className: x.className,
            text: (x.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 300)
          })),
          descendantsWithAnswerClass: [...q.querySelectorAll('[class*=correct i],[class*=answer i],[class*=solution i],[class*=explanation i]')]
            .slice(0, 20).map(x => ({ tag: x.tagName, className: x.className, text: (x.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 300) }))
        }));
      });
      log.info('MCQ extraction debug: ' + JSON.stringify(postDebug));

      // Compactly inspect the actual answer-bearing DOM after submission.
      // The site keeps the 50 question blocks but does not mark answers with
      // the selectors used above, so expose attributes/classes/data fields
      // without dumping the entire HTML into the log.
      const answerDebug = await page.evaluate(() => {
        const clean = s => (s || '').replace(/\\s+/g, ' ').trim();
        return [...document.querySelectorAll('.question-block')].slice(0, 2).map((q, i) => ({
          index: i + 1,
          blockAttrs: [...q.attributes].map(a => [a.name, a.value]),
          inputAttrs: [...q.querySelectorAll('input')].map(x => ({
            type: x.type,
            value: x.value,
            checked: x.checked,
            attrs: [...x.attributes].map(a => [a.name, a.value])
          })),
          labelAttrs: [...q.querySelectorAll('label')].map(x => ({
            text: clean(x.innerText).slice(0, 120),
            className: String(x.className || ''),
            attrs: [...x.attributes].map(a => [a.name, a.value])
          })),
          childSummary: [...q.querySelectorAll('*')]
            .filter(x => /answer|correct|solution|explanation|result|feedback/i.test(String(x.className || '') + ' ' + String(x.id || '')))
            .slice(0, 30)
            .map(x => ({tag: x.tagName, id: x.id || '', className: String(x.className || ''), text: clean(x.innerText).slice(0, 200)})),
          formData: [...q.querySelectorAll('input,select,textarea')].map(x => ({name:x.name||'',value:x.value||'',type:x.type||x.tagName}))
        }));
      });
      log.info('MCQ answer DOM debug: ' + JSON.stringify(answerDebug));

      // Extract from the post-submit DOM using the same selectors proven in Chrome DevTools.
      // Important: keep this as executable code (not on the same line as the comments).
      const items = await page.evaluate((meta) => {
        const clean = s => (s || '').replace(/\\s+/g, ' ').trim();

        return [...document.querySelectorAll('.question-block')].map(q => {
          const number = q.dataset.questionNumber;
          const question = q.querySelector('strong')?.textContent.trim() || '';

          const opts = {};
          q.querySelectorAll('input[type="radio"]').forEach(input => {
            const label = input.closest('label');
            const text = label?.querySelector('.option-text')?.textContent.trim() || '';
            opts[input.value] = text;
          });

          const correctInput = q.querySelector('label.correct input[type="radio"]');
          const answer = correctInput?.value || '';

          const explanation =
            q.querySelector('.solution-text')?.textContent.trim() || '';

          return {
            subject: meta.subject,
            chapter: meta.chapter,
            subchapter: meta.subchapter,
            sourceUrl: location.href,
            mcqUrl: location.href,
            mcqSlug: meta.mcqSlug,
            questionId: q.dataset.questionId || '',
            number: Number(number || 0),
            question: question.replace(/^\\d+\\.\\s*/, ''),
            A: opts.A || '',
            B: opts.B || '',
            C: opts.C || '',
            D: opts.D || '',
            answer,
            explanation
          };
        });
      }, pageMeta);

      log.info('MCQ extracted: ' + JSON.stringify({
        questions: items.length,
        withQuestion: items.filter(x => x.question).length,
        withAnswer: items.filter(x => x.answer).length,
        withExplanation: items.filter(x => x.explanation).length
      }));
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
