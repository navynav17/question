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
        await new Promise(resolve => setTimeout(resolve, 1500));
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
        const buttonTexts = await page.evaluate(() => [...document.querySelectorAll('button, input[type="submit"], input[type="button"]')]
          .map(el => (el.innerText || el.value || '').trim()));
        log.info('Submit candidates: ' + JSON.stringify(buttonTexts.filter(Boolean)));
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

        async function clickVisibleByText(regex) {
          const handles = await page.$('button, input[type="submit"], input[type="button"]');
          for (const handle of handles) {
            const match = await handle.evaluate((el, source) => {
              const text = (el.innerText || el.value || '').trim();
              const r = el.getBoundingClientRect();
              const s = getComputedStyle(el);
              return new RegExp(source, 'i').test(text) && s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
            }, regex.source);
            if (match) {
              await handle.click();
              return true;
            }
          }
          return false;
        }

        let submitResult = { clicked: false, text: '', confirmation: false };

        if (clickSubmitNowFromDom.clicked) {
          submitResult = { clicked: true, text: 'Submit Now', confirmation: true };
        } else if (await clickVisibleByText(/^submit now$/i)) {
          submitResult = { clicked: true, text: 'Submit Now', confirmation: true };
        } else if (await clickVisibleByText(/^submit test$/i)) {
          submitResult = { clicked: true, text: 'Submit Test', confirmation: false };
        } else if (await clickVisibleByText(/^(finish|show answers|check answers|view result|see result|reveal)$/i)) {
          submitResult = { clicked: true, text: 'generic submit', confirmation: false };
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

          const resultCounts = await page.evaluate(() => ({
            correct: document.querySelectorAll('.question-block label.correct').length,
            solutions: document.querySelectorAll('.question-block .solution-text').length
          }));
          log.info('MCQ result DOM ready: ' + JSON.stringify({ resultReady, ...resultCounts }));

          // Give the page a final render cycle so classes/text inserted by
          // JavaScript are visible to the same document.querySelector calls
          // used successfully in Chrome DevTools.
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    } else {
      const links = await page.$$eval('a[href]', els =>
        els.map(a => a.href).filter(Boolean)
      );
      for (const url of links) {
        try {
          const u = new URL(url);
          if (u.origin !== 'https://pandeyramu.com.np') continue;
          if (/^\/mcq\/[^/]+\/?$/i.test(u.pathname)) {
            await queue.addRequest({
              url,
              uniqueKey: 'mcq:' + url,
              userData: { type: 'mcq' }
            });
          }
        } catch {}
      }
    }
  },

  async failedRequestHandler({ request, log }) {
    log.error('Request permanently failed: ' + request.url);
  }
});

await crawler.run();
await saveSeen();
await Actor.exit();
