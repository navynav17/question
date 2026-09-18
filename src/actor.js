import crypto from 'node:crypto';
import { Actor } from 'apify';
import { PuppeteerCrawler, RequestQueue, Dataset } from 'crawlee';

await Actor.init();

const INPUT = await Actor.getInput() ?? {};
const configuredUrls = (INPUT.startUrls ?? [])
  .map(x => typeof x === 'string' ? x : x?.url)
  .filter(Boolean);

const DEFAULT_START_URL = 'https://www.examsahayogi.com/quiz/nimabi-basic';
const configuredUrls = (INPUT.startUrls ?? [])
  .map(x => typeof x === 'string' ? x : x?.url)
  .filter(Boolean);

const startUrls = [...new Set(configuredUrls.length ? configuredUrls : [DEFAULT_START_URL])];

const dataset = await Dataset.open();
const kv = await Actor.openKeyValueStore();
const seen = (await kv.getValue('SEEN_QUESTIONS')) ?? {};
const runOutput = { quizCount: 0, newQuestionCount: 0, quizzes: [] };
const clean = value => (value || '').replace(/\s+/g, ' ').trim();

function dedupeKey(question) {
  return crypto.createHash('sha256')
    .update(String(question || '').replace(/\s+/g, ' ').trim().toLowerCase())
    .digest('hex');
}

async function saveState() {
  await kv.setValue('SEEN_QUESTIONS', seen);
}

// This actor is intentionally restricted to ONE source URL.
// It does not discover or crawl any other website/page.
const sourceUrl = 'https://www.examsahayogi.com/quiz/nimabi-basic';
const discoveredSlugs = [sourceUrl];
await kv.setValue('MCQ_SLUGS', discoveredSlugs);

const cycles = Number(INPUT.cycles ?? 0); // 0 = repeat forever
let cycleNumber = 0;

while (!cycles || cycleNumber < cycles) {
  cycleNumber++;
  console.log('MCQ CYCLE START: ' + JSON.stringify({ cycle: cycleNumber, totalCycles: cycles || 'unlimited', slugs: FIXED_MCQ_SLUGS.length }));

  const runId = Actor.getEnv()?.actorRunId || Date.now().toString();
  const queue = await RequestQueue.open(`mcq-crawl-${runId}-cycle-${cycleNumber}`);

  const result = await queue.addRequest({
    url: sourceUrl,
    uniqueKey: 'examsahayogi:nimabi-basic',
    userData: { type: 'mcq', slug: 'nimabi-basic' }
  });

  console.log('EXAMSahayogi URL QUEUED: ' + JSON.stringify({
    url: sourceUrl,
    newlyQueued: !(result.wasAlreadyPresent || result.wasAlreadyHandled)
  }));

  const crawler = new PuppeteerCrawler({
    requestQueue: queue,
    launchContext: {
      launchOptions: {
        executablePath: process.env.APIFY_CHROME_EXECUTABLE_PATH || '/usr/bin/google-chrome'
      }
    },
    maxConcurrency: Number(INPUT.maxConcurrency ?? 1),
    maxRequestsPerCrawl: Number(INPUT.maxRequests ?? 10000),
    navigationTimeoutSecs: 60,
    requestHandlerTimeoutSecs: 180,
    maxRequestRetries: 3,
  
    async requestHandler({ page, request, log }) {
      if (request.url !== sourceUrl) {
        log.warning('Blocked non-target URL: ' + request.url);
        return;
      }

      await page.goto(sourceUrl, { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
      
      const username = String(INPUT.username ?? '').trim() || 'Abcd';
      const contact = String(INPUT.contact ?? '').trim() || '1234';
  
      const started = await page.evaluate(({ username, contact }) => {
        const clean = s => (s || '').replace(/\s+/g, ' ').trim();
        const visible = el => {
          if (!el) return false;
          const s = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
        };
  
        const text = clean(document.body.innerText);
        const inputs = [...document.querySelectorAll('input')].filter(visible);
        const fields = inputs.map(input => ({
          input,
          meta: [input.name, input.id, input.placeholder, input.getAttribute('aria-label') || '', input.type || ''].join(' ').toLowerCase()
        }));
        const nameInput = fields.find(({ meta }) =>
          /name|full.?name|candidate/.test(meta)
        )?.input || inputs.find(input => /text/i.test(input.type || 'text'));
        const contactInput = fields.find(({ input, meta }) =>
          input !== nameInput && /contact|phone|mobile|tel|number/.test(meta)
        )?.input || inputs.find(input => input !== nameInput && /tel|number/i.test(input.type || ''));
  
        const startButton = [...document.querySelectorAll(
          'button, input[type="submit"], input[type="button"]'
        )].find(el => visible(el) && /start\s+mcq\s+test/i.test(clean(el.innerText || el.value)));
  
        if (!/enter your name to begin the test/i.test(text) && !startButton) {
          return { startScreen: false, filled: false, clicked: false };
        }
  
        const setInputValue = (input, value) => {
          if (!input) return false;
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
          if (setter) setter.call(input, value);
          else input.value = value;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          input.dispatchEvent(new Event('blur', { bubbles: true }));
          return true;
        };
        const filledName = setInputValue(nameInput, username);
        const filledContact = setInputValue(contactInput, contact);
  
        if (startButton) {
          startButton.click();
          return { startScreen: true, filled: filledName || filledContact, filledName, filledContact, clicked: true, username, contact };
        }
  
        const form = nameInput?.closest('form');
        if (form) {
          form.requestSubmit ? form.requestSubmit() : form.submit();
          return { startScreen: true, filled: filledName || filledContact, filledName, filledContact, clicked: true, username, contact };
        }
  
        return { startScreen: true, filled: filledName || filledContact, filledName, filledContact, clicked: false, username, contact };
      }, { username, contact });
  
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
  
      const chapter = (title || '').replace(/\s+/g, ' ').trim().replace(/\s+MCQ\s*$/i, '').trim() ||
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
  
      }
  
      // One JSON dataset record per quiz: metadata + every NEW question with
      // its full option list, correct answer and solution. Duplicate questions
      // are excluded using the persistent SEEN_QUESTIONS store.
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
  await dataset.pushData({ type: 'run_summary', quizCount: runOutput.quizCount, newQuestionCount: runOutput.newQuestionCount });
  

  console.log('MCQ CYCLE COMPLETE: ' + JSON.stringify({ cycle: cycleNumber }));
}

await saveState();
await Actor.exit();
