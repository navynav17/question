import crypto from 'node:crypto';
import { Actor } from 'apify';
import { PlaywrightCrawler, RequestQueue, Dataset } from 'crawlee';

await Actor.init();
const INPUT = await Actor.getInput() ?? {};
const configuredUrls = (INPUT.startUrls?.length ? INPUT.startUrls : []).map(x => typeof x === 'string' ? x : x.url);
const startUrls = [...new Set([
  ...configuredUrls,
  'https://pandeyramu.com.np/',
  'https://pandeyramu.com.np/mcq/',
  'https://pandeyramu.com.np/mcq/environmental-pollution/'
].filter(Boolean))].map(url => ({ url }));

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
    const discovered = await page.evaluate(() => {
      const mcq = new Set();
      const index = new Set();
      for (const a of document.querySelectorAll('a[href]')) {
        try {
          const u = new URL(a.href, location.href);
          if (u.origin !== location.origin) continue;
          u.hash = '';
          const path = u.pathname.replace(/\/+/g, '/');
          if (/^\/mcq\/[^/]+\/?$/i.test(path)) mcq.add(u.href);
          // Subject/chapter/index pages are useful because the home page may not expose MCQ URLs directly.
          if (/^\/(subject|chapter)\//i.test(path)) index.add(u.href);
        } catch {}
      }
      return { mcq: [...mcq], index: [...index] };
    });

    for (const url of discovered.mcq) await queue.addRequest({
      url, uniqueKey: 'mcq:' + url, userData: { type: 'mcq' }
    });
    for (const url of discovered.index) await queue.addRequest({
      url, uniqueKey: 'index:' + url, userData: { type: 'discover' }
    });

    if (request.userData?.type !== 'mcq') {
      log.info('From ' + request.url + ': discovered ' + discovered.mcq.length +
        ' MCQ URLs and ' + discovered.index.length + ' index/chapter URLs');
      return;
    }

    // The /mcq/<slug>/ page exposes the same quiz form used in Chrome.
    const before = await page.evaluate(() => ({
      hasForm: !!document.querySelector('form.quiz-form'),
      submitted: !!document.querySelector('form.quiz-form.submitted'),
      questions: document.querySelectorAll('.question-block').length
    }));

    if (before.hasForm && !before.submitted) {
      const username = 'Collector';
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

    const pageMeta = await page.evaluate(() => {
      const clean = (s) => (s || '').replace(/\\s+/g, ' ').trim();
      const crumbs = [...document.querySelectorAll(
        'nav a, .breadcrumb a, .breadcrumbs a, [aria-label*="breadcrumb" i] a'
      )].map(a => ({
        text: clean(a.textContent),
        href: a.href || ''
      })).filter(x => x.text);

      const pathParts = location.pathname.split('/').filter(Boolean);
      const mcqIndex = pathParts.indexOf('mcq');
      const mcqSlug = mcqIndex >= 0 ? pathParts[mcqIndex + 1] : '';

      let subject = '';
      let chapter = '';
      let subchapter = '';

      for (const b of crumbs) {
        const p = (() => { try { return new URL(b.href, location.href).pathname; } catch { return ''; } })();
        if (/\\/subject\\//i.test(p)) subject = b.text;
        if (/\\/chapter\\//i.test(p)) chapter = b.text;
        if (/\\/subchapter\\//i.test(p)) subchapter = b.text;
      }

      // Some pages expose hierarchy only as plain breadcrumb text.
      if (!chapter) {
        const plain = crumbs.map(x => x.text).filter(x => !/^home$/i.test(x));
        const mcqPos = plain.findIndex(x => /^mcq$/i.test(x));
        if (mcqPos > 0) chapter = plain[mcqPos - 1];
      }

      // The MCQ slug itself is the safest chapter fallback for /mcq/<slug>/ pages.
      if (!chapter && mcqSlug) {
        chapter = mcqSlug
          .replace(/[-_]+/g, ' ')
          .replace(/\\b\\w/g, m => m.toUpperCase());
      }

      // If a page has an explicit heading matching the chapter, prefer it.
      const headings = [...document.querySelectorAll('h1, h2, .page-title, .chapter-title')]
        .map(x => clean(x.textContent))
        .filter(Boolean);
      if (!chapter && headings[0]) chapter = headings[0];

      return { subject, chapter, subchapter, mcqSlug };
    });

    const items = await page.evaluate((pageMeta) => [...document.querySelectorAll('.question-block')].map(q => {
      const opts = {};
      q.querySelectorAll('input[type="radio"]').forEach(input => {
        opts[input.value] = input.closest('label')?.querySelector('.option-text')?.textContent.trim() || '';
      });
      return {
        subject: pageMeta.subject || '',
        chapter: pageMeta.chapter || '',
        subchapter: pageMeta.subchapter || '',
        sourceUrl: location.href,
        mcqUrl: location.href,
        questionId: q.dataset.questionId || '',
        number: Number(q.dataset.questionNumber || 0),
        question: (q.querySelector('strong')?.textContent || '').trim().replace(/^\\d+\\.\\s*/, ''),
        A: opts.A || '', B: opts.B || '', C: opts.C || '', D: opts.D || '',
        answer: q.querySelector('label.correct input[type="radio"]')?.value || '',
        explanation: q.querySelector('.solution-text')?.textContent.trim() || ''
      };
    }), pageMeta);

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
