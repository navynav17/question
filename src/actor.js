import crypto from 'node:crypto';
import { Actor } from 'apify';
import { PuppeteerCrawler, RequestQueue, Dataset } from 'crawlee';

await Actor.init();

const INPUT = await Actor.getInput() ?? {};
const configuredUrls = (INPUT.startUrls ?? [])
  .map(x => typeof x === 'string' ? x : x?.url)
  .filter(Boolean);

const startUrls = [...new Set(configuredUrls.length ? configuredUrls : [
  'https://pandeyramu.com.np/',
  'https://pandeyramu.com.np/all-subjects/',
  'https://pandeyramu.com.np/sitemap.xml'
])];

const queue = await RequestQueue.open();
const dataset = await Dataset.open();
const kv = await Actor.openKeyValueStore();

const seen = (await kv.getValue('SEEN_QUESTIONS')) ?? {};
const runOutput = {
  scrapedAt: new Date().toISOString(),
  quizCount: 0,
  newQuestionCount: 0,
  quizzes: []
};

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function dedupeKey(value) {
  return crypto.createHash('sha256')
    .update(clean(value).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim())
    .digest('hex');
}

async function saveState() {
  await kv.setValue('SEEN_QUESTIONS', seen);
  await Actor.setValue('OUTPUT', Buffer.from(JSON.stringify(runOutput, null, 2), 'utf8'), {
    contentType: 'application/json'
  });
}

for (const url of startUrls) {
  const isMcq = (() => {
    try {
      const u = new URL(url);
      return u.origin === 'https://pandeyramu.com.np' && /^\/mcq\/[^/]+\/?$/i.test(u.pathname);
    } catch {
      return false;
    }
  })();

  await queue.addRequest({
    url,
    uniqueKey: (isMcq ? 'mcq:' : 'discover:') + url.replace(/\/$/, ''),
    userData: { type: isMcq ? 'mcq' : 'discover' }
  });
}

const crawler = new PuppeteerCrawler({
  requestQueue: queue,
  launchContext: {
    launchOptions: {
      executablePath: process.env.APIFY_CHROME_EXECUTABLE_PATH || '/usr/bin/google-chrome'
    }
  },
  maxConcurrency: Number(INPUT.maxConcurrency ?? 1),
  maxRequestsPerCrawl: Number(INPUT.maxRequests ?? 3000),
  navigationTimeoutSecs: 60,
  requestHandlerTimeoutSecs: 180,
  maxRequestRetries: 3,

  async requestHandler({ page, request, log }) {
    if (request.userData?.type !== 'mcq') {
      if (/\/sitemap\.xml$/i.test(request.url)) {
        const urls = await page.evaluate(() => {
          const text = document.documentElement?.textContent || '';
          return [...text.matchAll(/<loc>\s*(https?:\/\/[^<]+)\s*<\/loc>/gi)]
            .map(m => m[1].trim());
        }).catch(() => []);

        for (const url of urls) {
          try {
            const u = new URL(url);
            if (u.origin !== 'https://pandeyramu.com.np') continue;
            if (/^\/mcq\/[^/]+\/?$/i.test(u.pathname)) {
              await queue.addRequest({
                url: u.href,
                uniqueKey: 'mcq:' + u.origin + u.pathname.replace(/\/$/, ''),
                userData: { type: 'mcq' }
              });
            } else {
              await queue.addRequest({
                url: u.href,
                uniqueKey: 'discover:' + u.href.replace(/\/$/, ''),
                userData: { type: 'discover' }
              });
            }
          } catch {}
        }

        log.info('Sitemap discovery: ' + JSON.stringify({ urlsFound: urls.length }));
        return;
      }

      // Discovery cycle: traverse all internal HTML pages and continuously harvest
      // every /mcq/<slug>/ URL. The request queue de-duplicates URLs.
      const links = await page.$eval('a[href]', els => els.map(a => a.href).filter(Boolean));

      for (const href of links) {
        try {
          const u = new URL(href);
          if (u.origin !== 'https://pandeyramu.com.np') continue;
          if (u.pathname.includes('/wp-admin/') || u.pathname.includes('/feed/')) continue;
          if (/\.(?:jpg|jpeg|png|gif|webp|svg|css|js|xml|pdf|zip)$/i.test(u.pathname)) continue;

          const normalized = u.origin + u.pathname.replace(/\/$/, '') + (u.search || '');

          if (/^\/mcq\/[^/]+\/?$/i.test(u.pathname)) {
            await queue.addRequest({
              url: normalized,
              uniqueKey: 'mcq:' + u.origin + u.pathname.replace(/\/$/, ''),
              userData: { type: 'mcq' }
            });
          } else {
            await queue.addRequest({
              url: normalized,
              uniqueKey: 'discover:' + normalized,
              userData: { type: 'discover' }
            });
          }
        } catch {}
      }
      return;
    }

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
        form.requestSubmit ? form.requestSubmit() : form.submit();
        return { startScreen: true, filled: true, clicked: true, username };
      }

      return { startScreen: true, filled: !!nameInput, clicked: false, username };
    }, username);

    if (started.startScreen) {
      log.info('MCQ start screen: ' + JSON.stringify(started));
      if (!started.clicked) throw new Error('Could not start MCQ test.');
      await new Promise(resolve => setTimeout(resolve, 4500));
    }

    await page.waitForFunction(
      () => document.querySelectorAll('.question-block').length > 0,
      { timeout: 30000 }
    );

    const preSubmitQuestions = await page.evaluate(() => {
      const clean = value => (value || '').replace(/\s+/g, ' ').trim();

      return [...document.querySelectorAll('.question-block')].map((block, index) => {
        const questionEl =
          block.querySelector('.question-text') ||
          block.querySelector('.question') ||
          block.querySelector('[class*="question-text"]') ||
          block.querySelector('h1, h2, h3, h4, p');

        const nodes = [
          ...block.querySelectorAll(
            'label, .option, .answer-option, [class*="option"], [class*="choice"]'
          )
        ];

        const options = [];
        const seenOptions = new Set();

        for (const node of nodes) {
          const input = node.querySelector?.('input[type="radio"], input[type="checkbox"]');
          const text = clean(
            node.querySelector?.('.option-text')?.innerText ||
            node.querySelector?.('.option-text')?.textContent ||
            node.innerText ||
            node.textContent ||
            input?.value ||
            ''
          );

          if (!text || seenOptions.has(text)) continue;
          seenOptions.add(text);
          options.push({ number: options.length + 1, text });
        }

        return {
          number: index + 1,
          question: clean(questionEl?.innerText || questionEl?.textContent || ''),
          options
        };
      });
    });

    log.info('MCQ questions/options captured: ' + JSON.stringify({
      questionCount: preSubmitQuestions.length,
      optionCounts: preSubmitQuestions.map(q => q.options.length)
    }));

    // Select one answer per question so the site's review/result state is generated.
    await page.evaluate(() => {
      for (const block of document.querySelectorAll('.question-block')) {
        const input = block.querySelector('input[type="radio"]:checked') ||
          block.querySelector('input[type="radio"]');
        if (!input) continue;
        if (!input.checked) {
          const label = input.closest('label');
          if (label) label.click();
          else input.click();
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        }
      }
    });

    let dialogAccepted = false;
    const dialogHandler = async dialog => {
      if (/submit this quiz now/i.test(dialog.message())) {
        dialogAccepted = true;
        log.info('Submit confirmation dialog: ' + JSON.stringify({
          type: dialog.type(),
          message: dialog.message()
        }));
        await dialog.accept();
      } else {
        await dialog.dismiss();
      }
    };
    page.on('dialog', dialogHandler);

    // IMPORTANT: only click the page-level Submit Now. Its own JS listener
    // calls window.confirm() and then quizForm.requestSubmit().
    const clicked = await page.evaluate(() => {
      const el = document.querySelector('#submit-now-btn');
      if (!el || el.disabled) return false;
      el.click();
      return true;
    });

    log.info('Submit Now click: ' + JSON.stringify({ clicked }));

    await new Promise(resolve => setTimeout(resolve, 1500));
    page.off('dialog', dialogHandler);

    if (!clicked || !dialogAccepted) {
      throw new Error('Submit Now was not completed.');
    }

    const resultReady = await page.waitForFunction(
      () => {
        const blocks = document.querySelectorAll('.question-block');
        return blocks.length > 0 &&
          (document.querySelectorAll('.question-block label.correct').length > 0 ||
           document.querySelectorAll('.question-block .solution-text').length > 0 ||
           document.querySelectorAll('.question-block .solution').length > 0);
      },
      { timeout: 90000 }
    ).then(() => true).catch(() => false);

    const resultStats = await page.evaluate(() => ({
      correct: document.querySelectorAll('.question-block label.correct').length,
      solutions: document.querySelectorAll('.question-block .solution-text, .question-block .solution').length
    }));
    log.info('MCQ result DOM ready: ' + JSON.stringify({
      resultReady,
      ...resultStats
    }));

    const postSubmit = await page.evaluate(() => {
      const clean = value => (value || '').replace(/\s+/g, ' ').trim();
      const blocks = [...document.querySelectorAll('.question-block')];

      return blocks.map((block, index) => {
        const correctEl =
          block.querySelector('label.correct') ||
          block.querySelector('.correct-answer') ||
          block.querySelector('[data-correct="true"]') ||
          block.querySelector('.correct');

        const solutionEl =
          block.querySelector('.solution-text') ||
          block.querySelector('.solution') ||
          block.querySelector('[class*="solution"]');

        let correctAnswer = clean(correctEl?.innerText || correctEl?.textContent || '');

        if (!correctAnswer) {
          const body = clean(block.innerText || block.textContent || '');
          const match = body.match(/(?:correct\s+answer|answer)\s*[:\-]\s*([^\n]+)/i);
          if (match) correctAnswer = clean(match[1]);
        }

        return {
          number: index + 1,
          correctAnswer,
          solution: clean(solutionEl?.innerText || solutionEl?.textContent || '')
        };
      });
    });

    const title = await page.$eval('h1', el => (el.innerText || el.textContent || '').trim())
      .catch(() => '');

    const chapter = clean(title).replace(/\s+MCQ\s*$/i, '').trim() ||
      new URL(request.url).pathname.split('/').filter(Boolean).pop()
        ?.replace(/[-_]+/g, ' ')
        .replace(/\b\w/g, c => c.toUpperCase()) || '';

    const questions = preSubmitQuestions.map((before, index) => {
      const after = postSubmit[index] || {};
      const normalizedCorrect = clean(after.correctAnswer).toLowerCase();

      const options = before.options.map(option => {
        const normalizedOption = option.text.toLowerCase();
        const letter = String.fromCharCode(65 + option.number - 1).toLowerCase();

        const isCorrect =
          normalizedCorrect === normalizedOption ||
          normalizedCorrect.startsWith(letter + '.') ||
          normalizedCorrect.startsWith(letter + ')') ||
          normalizedCorrect.startsWith(letter + ' ');

        return { ...option, isCorrect };
      });

      return {
        number: before.number,
        question: before.question,
        options,
        correctAnswer: after.correctAnswer || '',
        solution: after.solution || ''
      };
    });

    const quiz = {
      quizUrl: page.url(),
      chapter,
      questionCount: questions.length,
      questions
    };

    // Persist only genuinely new questions. This survives actor restarts/runs.
    const newQuestions = [];

    for (const question of questions) {
      const key = dedupeKey(question.question);
      if (seen[key]) continue;

      seen[key] = {
        firstSeenQuizUrl: quiz.quizUrl,
        firstSeenAt: new Date().toISOString()
      };

      newQuestions.push(question);

      await dataset.pushData({
        quizUrl: quiz.quizUrl,
        chapter: quiz.chapter,
        questionCount: quiz.questionCount,
        question: question.question,
        options: question.options,
        correctAnswer: question.correctAnswer,
        solution: question.solution
      });
    }

    if (newQuestions.length > 0) {
      await dataset.pushData({
        quizUrl: quiz.quizUrl,
        chapter: quiz.chapter,
        questionCount: quiz.questionCount,
        newQuestionCount: newQuestions.length,
        questions: newQuestions
      });
    }

    runOutput.quizCount += 1;
    runOutput.newQuestionCount += newQuestions.length;
    runOutput.quizzes.push({
      quizUrl: quiz.quizUrl,
      chapter: quiz.chapter,
      questionCount: quiz.questionCount,
      newQuestionCount: newQuestions.length,
      questions: newQuestions
    });

    await saveState();

    log.info('MCQ JSON saved: ' + JSON.stringify({
      quizUrl: quiz.quizUrl,
      chapter: quiz.chapter,
      questionCount: quiz.questionCount,
      newQuestionCount: newQuestions.length
    }));
  },

  async failedRequestHandler({ request, log }) {
    log.error('Request permanently failed: ' + request.url);
  }
});

await crawler.run();
await saveState();
await dataset.pushData(runOutput);
await Actor.exit();
