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


        // The site exposes "Submit Now" on the question page. Clicking it opens
        // the confirmation UI whose heading is "Submit Test" and whose final
        // action is another "Submit Now". Therefore the real DOM sequence is:
        // 1) click the page-level Submit Now (opens Submit Test confirmation)
        // 2) wait for the Submit Test confirmation UI
        // 3) click the confirmation Submit Now

        // The page-level #submit-now-btn has its own JavaScript click listener.
        // That listener calls window.confirm() and then quizForm.requestSubmit().
        // Puppeteer must explicitly accept the browser dialog; otherwise the
        // click appears to do nothing and the form is never submitted.
        let submitDialogSeen = false;
        const submitDialogHandler = async (dialog) => {
          submitDialogSeen = true;
          log.info('Submit confirmation dialog: ' + JSON.stringify({
            type: dialog.type(),
            message: dialog.message()
          }));
          await dialog.accept();
        };
        page.on('dialog', submitDialogHandler);

        // Click ONLY the page-level Submit Now button. Do not search for or
        // click a second "Submit Now" after this; the site's event handler
        // performs the actual quizForm.requestSubmit() after confirmation.
        const submitNowInitial = await page.evaluate(() => {
          const el = document.querySelector('#submit-now-btn');
          if (!el) return { count: 0, visible: false };
          const r = el.getBoundingClientRect();
          const s = getComputedStyle(el);
          return {
            count: 1,
            visible: s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0,
            disabled: !!el.disabled,
            text: (el.innerText || '').replace(/\\s+/g, ' ').trim()
          };
        });
        log.info('Submit Now button: ' + JSON.stringify(submitNowInitial));

        if (!submitNowInitial.count || !submitNowInitial.visible) {
          page.off('dialog', submitDialogHandler);
          throw new Error('Could not find visible #submit-now-btn.');
        }

        const initialSubmitClicked = await page.evaluate(() => {
          const el = document.querySelector('#submit-now-btn');
          if (!el) return false;
          el.scrollIntoView({ block: 'center', inline: 'center' });
          return true;
        });

        if (initialSubmitClicked) {
          await page.locator('#submit-now-btn').click();
        }
        log.info('Submit Now click: ' + JSON.stringify({ clicked: initialSubmitClicked }));

        // The click handler is synchronous up to requestSubmit(), but allow the
        // resulting submit/navigation/DOM update to settle before inspecting it.
        await new Promise(resolve => setTimeout(resolve, 1500));
        page.off('dialog', submitDialogHandler);
        log.info('Submit Now result: ' + JSON.stringify({ dialogAccepted: submitDialogSeen }));

        if (!initialSubmitClicked) {
          throw new Error('Could not click the page-level Submit Now.');
        }

        await new Promise(resolve => setTimeout(resolve, 3000));

        const resultReady = await page.waitForFunction(
          () => {
            const blocks = document.querySelectorAll('.question-block');
            if (!blocks.length) return false;
            const correct = document.querySelectorAll('.question-block label.correct').length;
            const solutions = document.querySelectorAll('.question-block .solution-text').length;
            return correct > 0 || solutions > 0;
          },
          { timeout: 90000 }
        ).then(() => true).catch(() => false);

        const resultCounts = await page.evaluate(() => ({
          correct: document.querySelectorAll('.question-block label.correct').length,
          solutions: document.querySelectorAll('.question-block .solution-text').length
        }));
        log.info('MCQ result DOM ready: ' + JSON.stringify({ resultReady, ...resultCounts }));

        await new Promise(resolve => setTimeout(resolve, 2000));
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
