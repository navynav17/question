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

const discoveredMcq = new Map();
const dataset = await Dataset.open();
const kv = await Actor.openKeyValueStore();
const seen = (await kv.getValue('SEEN_QUESTIONS')) ?? {};
const runOutput = { quizCount: 0, newQuestionCount: 0, quizzes: [] };
const clean = value => (value || '').replace(/\s+/g, ' ').trim();

function dedupeKey(question) {
  return crypto.createHash('sha256').update(String(question || '').replace(/\s+/g, ' ').trim().toLowerCase()).digest('hex');
}

async function saveState() {
  await kv.setValue('SEEN_QUESTIONS', seen);
}



function normalizeMcqUrl(raw) {
  try {
    const u = new URL(raw);
    if (u.origin !== 'https://pandeyramu.com.np') return null;
    if (!/^\/mcq\/[^/]+\/?$/i.test(u.pathname)) return null;
    return u.origin + u.pathname.replace(/\/$/, '') + (u.search || '');
  } catch {
    return null;
  }
}

async function discoverFromHtml(page, url, log) {
  const links = await page.$$eval('a[href]', els => els.map(a => a.href).filter(Boolean));
  let added = 0;
  for (const href of links) {
    const mcq = normalizeMcqUrl(href);
    if (mcq && !discoveredMcq.has(mcq)) {
      discoveredMcq.set(mcq, true);
      added++;
    }
  }
  log.info('MCQ slug discovery page: ' + JSON.stringify({
    page: url,
    linksFound: links.length,
    newMcqSlugs: added,
    totalMcqSlugs: discoveredMcq.size
  }));
}

async function discoverMcqSlugs(log) {
  log.info('MCQ SLUG DISCOVERY START');

  const browser = await (await import('puppeteer')).launch({
    headless: true,
    executablePath: process.env.APIFY_CHROME_EXECUTABLE_PATH || '/usr/bin/google-chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const page = await browser.newPage();
  const visited = new Set();
  const pending = [...startUrls];

  const maxDiscoveryPages = Number(INPUT.maxDiscoveryPages ?? 0); // 0 = unlimited

  while (pending.length && (!maxDiscoveryPages || visited.size < maxDiscoveryPages)) {
    const url = pending.shift();
    if (!url || visited.has(url)) continue;
    visited.add(url);

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

      if (/sitemap[^/]*\.xml$/i.test(url)) {
        const xml = await page.content();
        for (const match of xml.matchAll(/<loc>\s*(https?:\/\/[^<]+)\s*<\/loc>/gi)) {
          const found = match[1].trim();
          const mcq = normalizeMcqUrl(found);
          if (mcq) discoveredMcq.set(mcq, true);
          else if (new URL(found).origin === 'https://pandeyramu.com.np' &&
                   !/\.(?:jpg|jpeg|png|gif|webp|svg|css|js|pdf|zip)$/i.test(new URL(found).pathname)) {
            if (!maxDiscoveryPages || visited.size + pending.length < maxDiscoveryPages) pending.push(found);
          }
        }
      } else {
        await discoverFromHtml(page, url, log);
        const links = await page.$$eval('a[href]', els => els.map(a => a.href).filter(Boolean));
        for (const href of links) {
          try {
            const u = new URL(href);
            if (u.origin !== 'https://pandeyramu.com.np') continue;
            if (normalizeMcqUrl(href)) continue;
            if (u.pathname.includes('/wp-admin/') || u.pathname.includes('/feed/')) continue;
            if (/\.(?:jpg|jpeg|png|gif|webp|svg|css|js|xml|pdf|zip)$/i.test(u.pathname)) continue;
            const normalized = u.origin + u.pathname.replace(/\/$/, '') + (u.search || '');
            if (!visited.has(normalized) && (!maxDiscoveryPages || visited.size + pending.length < maxDiscoveryPages)) {
              pending.push(normalized);
            }
          } catch {}
        }
      }
    } catch (err) {
      log.warning('Discovery failed: ' + JSON.stringify({ url, error: String(err?.message || err) }));
    }
  }

  await browser.close();

  const slugs = [...discoveredMcq.keys()].sort();
  await kv.setValue('MCQ_SLUGS', slugs);
  log.info('MCQ SLUG DISCOVERY COMPLETE: ' + JSON.stringify({
    pagesVisited: visited.size,
    mcqSlugs: slugs.length,
    discoveryLimit: maxDiscoveryPages || 'unlimited'
  }));
  log.info('ALL DISCOVERED MCQ SLUGS: ' + JSON.stringify(slugs));
  return slugs;
}

// Fixed MCQ source list extracted from the completed discovery log.
// Exactly 172 slugs; no live discovery is performed for the crawl.
const FIXED_MCQ_SLUGS = [
  "https://pandeyramu.com.np/mcq/physical-quantities-vectors-and-scalars",
  "https://pandeyramu.com.np/mcq/acoustic-phenomena",
  "https://pandeyramu.com.np/mcq/adaptations",
  "https://pandeyramu.com.np/mcq/alcohols-and-phenols",
  "https://pandeyramu.com.np/mcq/aldehydes-and-ketones",
  "https://pandeyramu.com.np/mcq/algae",
  "https://pandeyramu.com.np/mcq/alphabet-series",
  "https://pandeyramu.com.np/mcq/alternating-currents",
  "https://pandeyramu.com.np/mcq/amines",
  "https://pandeyramu.com.np/mcq/analogy-2",
  "https://pandeyramu.com.np/mcq/analogy",
  "https://pandeyramu.com.np/mcq/analytic-reasoning-test",
  "https://pandeyramu.com.np/mcq/anatomy-of-monocot-and-dicot-root-stem-and-leaf",
  "https://pandeyramu.com.np/mcq/angiosperms",
  "https://pandeyramu.com.np/mcq/animal-behavior",
  "https://pandeyramu.com.np/mcq/animal-diversity-from-protozoa-to-chordata",
  "https://pandeyramu.com.np/mcq/applications-of-non-metals-metals-and-compounds",
  "https://pandeyramu.com.np/mcq/applied-microbiology",
  "https://pandeyramu.com.np/mcq/arithmetical-operation",
  "https://pandeyramu.com.np/mcq/aromatic-hydrocarbons",
  "https://pandeyramu.com.np/mcq/atomic-structure",
  "https://pandeyramu.com.np/mcq/averages",
  "https://pandeyramu.com.np/mcq/basic-concepts-in-chemistry",
  "https://pandeyramu.com.np/mcq/bio-inorganic-chemistry",
  "https://pandeyramu.com.np/mcq/biofertilizers-and-food-security",
  "https://pandeyramu.com.np/mcq/biogeochemical-cycles-and-ecological-imbalances",
  "https://pandeyramu.com.np/mcq/blood-relations",
  "https://pandeyramu.com.np/mcq/bryophytes",
  "https://pandeyramu.com.np/mcq/capacitors",
  "https://pandeyramu.com.np/mcq/carbohydrates-lipids-and-minerals",
  "https://pandeyramu.com.np/mcq/carboxylic-acid-and-its-derivatives",
  "https://pandeyramu.com.np/mcq/cell-cycle-and-cell-division",
  "https://pandeyramu.com.np/mcq/cell-organelles",
  "https://pandeyramu.com.np/mcq/chemical-bonding-and-shape-of-molecules",
  "https://pandeyramu.com.np/mcq/chemical-equilibrium",
  "https://pandeyramu.com.np/mcq/chemical-kinetics",
  "https://pandeyramu.com.np/mcq/chemical-tests",
  "https://pandeyramu.com.np/mcq/chemical-thermodynamics",
  "https://pandeyramu.com.np/mcq/chemistry-in-service-to-mankind",
  "https://pandeyramu.com.np/mcq/chemistry-of-metals",
  "https://pandeyramu.com.np/mcq/chemistry-of-non-metals",
  "https://pandeyramu.com.np/mcq/circular-and-periodic-motion",
  "https://pandeyramu.com.np/mcq/circulatory-system",
  "https://pandeyramu.com.np/mcq/classification-of-elements-and-periodicity",
  "https://pandeyramu.com.np/mcq/classification-test",
  "https://pandeyramu.com.np/mcq/classification",
  "https://pandeyramu.com.np/mcq/coding-and-decoding",
  "https://pandeyramu.com.np/mcq/common-properties",
  "https://pandeyramu.com.np/mcq/conservation-biology",
  "https://pandeyramu.com.np/mcq/construction-of-figure",
  "https://pandeyramu.com.np/mcq/continuous-patterns-and-positional-series",
  "https://pandeyramu.com.np/mcq/cube-and-dice",
  "https://pandeyramu.com.np/mcq/diffraction-and-polarization",
  "https://pandeyramu.com.np/mcq/digestive-system",
  "https://pandeyramu.com.np/mcq/distance-and-direction",
  "https://pandeyramu.com.np/mcq/dot-situation",
  "https://pandeyramu.com.np/mcq/dynamics",
  "https://pandeyramu.com.np/mcq/earthworm-pheretima",
  "https://pandeyramu.com.np/mcq/economic-importance-of-plant-groups",
  "https://pandeyramu.com.np/mcq/ecosystem-ecology",
  "https://pandeyramu.com.np/mcq/elasticity",
  "https://pandeyramu.com.np/mcq/electric-charge-and-electric-field",
  "https://pandeyramu.com.np/mcq/electric-field-strength-potential-and-potential-energy",
  "https://pandeyramu.com.np/mcq/electrical-circuits",
  "https://pandeyramu.com.np/mcq/electrical-quantities",
  "https://pandeyramu.com.np/mcq/electrochemistry",
  "https://pandeyramu.com.np/mcq/electromagnetic-induction",
  "https://pandeyramu.com.np/mcq/electron",
  "https://pandeyramu.com.np/mcq/embedded-figure",
  "https://pandeyramu.com.np/mcq/embryo-and-endosperm",
  "https://pandeyramu.com.np/mcq/endocrinology",
  "https://pandeyramu.com.np/mcq/environmental-pollution",
  "https://pandeyramu.com.np/mcq/ethers",
  "https://pandeyramu.com.np/mcq/evidences-of-evolution",
  "https://pandeyramu.com.np/mcq/excretory-system",
  "https://pandeyramu.com.np/mcq/figure-formation",
  "https://pandeyramu.com.np/mcq/first-law-of-thermodynamics",
  "https://pandeyramu.com.np/mcq/fluid-statics-and-dynamics",
  "https://pandeyramu.com.np/mcq/frog-rana",
  "https://pandeyramu.com.np/mcq/fungi-and-lichens",
  "https://pandeyramu.com.np/mcq/general-organic-chemistry",
  "https://pandeyramu.com.np/mcq/genetic-engineering",
  "https://pandeyramu.com.np/mcq/genetic-material-dna-and-rna",
  "https://pandeyramu.com.np/mcq/gravity",
  "https://pandeyramu.com.np/mcq/grouping-figure",
  "https://pandeyramu.com.np/mcq/gymnosperms",
  "https://pandeyramu.com.np/mcq/haloalkanes-and-haloarenes",
  "https://pandeyramu.com.np/mcq/human-evolution",
  "https://pandeyramu.com.np/mcq/hydrocarbons",
  "https://pandeyramu.com.np/mcq/ideal-gas",
  "https://pandeyramu.com.np/mcq/immunity",
  "https://pandeyramu.com.np/mcq/interference",
  "https://pandeyramu.com.np/mcq/introduction-and-classification-systems",
  "https://pandeyramu.com.np/mcq/ionic-equilibrium",
  "https://pandeyramu.com.np/mcq/kinematics",
  "https://pandeyramu.com.np/mcq/logical-sequence-of-words",
  "https://pandeyramu.com.np/mcq/logical-venn-diagram",
  "https://pandeyramu.com.np/mcq/magnetic-field",
  "https://pandeyramu.com.np/mcq/magnetic-properties-of-materials",
  "https://pandeyramu.com.np/mcq/manufacturing-processes",
  "https://pandeyramu.com.np/mcq/matrix-and-missing-characters",
  "https://pandeyramu.com.np/mcq/matrix",
  "https://pandeyramu.com.np/mcq/medical-technology",
  "https://pandeyramu.com.np/mcq/medicinal-plants-of-nepal",
  "https://pandeyramu.com.np/mcq/mendelian-genetics-and-linkage",
  "https://pandeyramu.com.np/mcq/microbial-diseases",
  "https://pandeyramu.com.np/mcq/monera-and-virus",
  "https://pandeyramu.com.np/mcq/mutation-polyploidy-and-genetic-disorders",
  "https://pandeyramu.com.np/mcq/nervous-system",
  "https://pandeyramu.com.np/mcq/nitro-compounds",
  "https://pandeyramu.com.np/mcq/nuclear-chemistry",
  "https://pandeyramu.com.np/mcq/nuclear-physics",
  "https://pandeyramu.com.np/mcq/number-series",
  "https://pandeyramu.com.np/mcq/organometallic-compounds",
  "https://pandeyramu.com.np/mcq/origin-of-life",
  "https://pandeyramu.com.np/mcq/paper-folding",
  "https://pandeyramu.com.np/mcq/particle-physics-and-recent-trends",
  "https://pandeyramu.com.np/mcq/partnership",
  "https://pandeyramu.com.np/mcq/percentage",
  "https://pandeyramu.com.np/mcq/permutation-and-combination",
  "https://pandeyramu.com.np/mcq/photon-and-photoelectric-effect",
  "https://pandeyramu.com.np/mcq/photosynthesis",
  "https://pandeyramu.com.np/mcq/plant-growth-and-seed-germination",
  "https://pandeyramu.com.np/mcq/plant-tissue-culture",
  "https://pandeyramu.com.np/mcq/plant-tissues-and-vascular-bundles",
  "https://pandeyramu.com.np/mcq/plasmodium",
  "https://pandeyramu.com.np/mcq/problem-on-ages",
  "https://pandeyramu.com.np/mcq/profit-and-loss",
  "https://pandeyramu.com.np/mcq/prokaryotic-and-eukaryotic-cells",
  "https://pandeyramu.com.np/mcq/proteins-and-enzymes",
  "https://pandeyramu.com.np/mcq/pteridophytes",
  "https://pandeyramu.com.np/mcq/quantity-of-heat",
  "https://pandeyramu.com.np/mcq/radioactivity",
  "https://pandeyramu.com.np/mcq/ranking-order",
  "https://pandeyramu.com.np/mcq/ratio-and-proportion",
  "https://pandeyramu.com.np/mcq/redox-reaction",
  "https://pandeyramu.com.np/mcq/reflection-refraction-and-dispersion",
  "https://pandeyramu.com.np/mcq/reproduction-and-sporogenesis-in-angiosperms",
  "https://pandeyramu.com.np/mcq/reproductive-system",
  "https://pandeyramu.com.np/mcq/respiration",
  "https://pandeyramu.com.np/mcq/respiratory-system",
  "https://pandeyramu.com.np/mcq/rotational-dynamics",
  "https://pandeyramu.com.np/mcq/second-law-of-thermodynamics",
  "https://pandeyramu.com.np/mcq/sense-organs",
  "https://pandeyramu.com.np/mcq/separation-techniques",
  "https://pandeyramu.com.np/mcq/series",
  "https://pandeyramu.com.np/mcq/sex-linked-inheritance",
  "https://pandeyramu.com.np/mcq/simple-interest-and-compound-interest",
  "https://pandeyramu.com.np/mcq/solid-and-semiconductor-devices",
  "https://pandeyramu.com.np/mcq/statement-and-reasons",
  "https://pandeyramu.com.np/mcq/states-of-matter",
  "https://pandeyramu.com.np/mcq/stationary-waves",
  "https://pandeyramu.com.np/mcq/stoichiometry",
  "https://pandeyramu.com.np/mcq/synonym-and-antonym",
  "https://pandeyramu.com.np/mcq/theories-of-evolution",
  "https://pandeyramu.com.np/mcq/thermal-energy-heat-temperature-and-thermometers",
  "https://pandeyramu.com.np/mcq/thermal-expansion",
  "https://pandeyramu.com.np/mcq/thermoelectric-effect",
  "https://pandeyramu.com.np/mcq/time-and-work",
  "https://pandeyramu.com.np/mcq/time-speed-and-distance",
  "https://pandeyramu.com.np/mcq/types-of-animal-tissues",
  "https://pandeyramu.com.np/mcq/types-of-titration",
  "https://pandeyramu.com.np/mcq/vaccines",
  "https://pandeyramu.com.np/mcq/vegetation-and-adaptation",
  "https://pandeyramu.com.np/mcq/verbal-analogy",
  "https://pandeyramu.com.np/mcq/verbal-classification",
  "https://pandeyramu.com.np/mcq/verbal-puzzle",
  "https://pandeyramu.com.np/mcq/volumetric-analysis",
  "https://pandeyramu.com.np/mcq/water-image-and-mirror-image",
  "https://pandeyramu.com.np/mcq/water-relations",
  "https://pandeyramu.com.np/mcq/wave-motion",
  "https://pandeyramu.com.np/mcq/wave-particle-duality-and-x-rays"
];
if (FIXED_MCQ_SLUGS.length !== 172) {
  throw new Error(`Fixed MCQ slug list must contain exactly 172 entries; got ${FIXED_MCQ_SLUGS.length}`);
}
const discoveredSlugs = FIXED_MCQ_SLUGS;
await kv.setValue('MCQ_SLUGS', discoveredSlugs);

// Run the fixed 172-slug MCQ set repeatedly. The persistent SEEN_QUESTIONS
// store prevents the same MCQ question from being written to the dataset twice,
// even when the cycle repeats or the actor restarts.
const cycles = Number(INPUT.cycles ?? 0); // 0 = repeat forever
let cycleNumber = 0;

while (!cycles || cycleNumber < cycles) {
  cycleNumber++;
  console.log('MCQ CYCLE START: ' + JSON.stringify({ cycle: cycleNumber, totalCycles: cycles || 'unlimited', slugs: FIXED_MCQ_SLUGS.length }));

  const runId = Actor.getEnv()?.actorRunId || Date.now().toString();
  const queue = await RequestQueue.open(`mcq-crawl-${runId}-cycle-${cycleNumber}`);
  // Only the fixed 172 MCQ slugs above are inserted into the SAME RequestQueue
  // that PuppeteerCrawler consumes. No newly discovered MCQ URL is added.
  let queuedMcqSlugs = 0;
  for (const url of discoveredSlugs) {
    const normalized = normalizeMcqUrl(url);
    if (!normalized) continue;
  
    const result = await queue.addRequest({
      url: normalized,
      uniqueKey: 'mcq:' + new URL(normalized).origin + new URL(normalized).pathname.replace(/\/$/, ''),
      userData: {
        type: 'mcq',
        slug: new URL(normalized).pathname.split('/').filter(Boolean).pop()
      }
    });
  
    if (result.wasAlreadyPresent || result.wasAlreadyHandled) continue;
    queuedMcqSlugs++;
  }
  
  console.log('MCQ SLUGS QUEUED: ' + JSON.stringify({
    discovered: discoveredSlugs.length,
    newlyQueued: queuedMcqSlugs
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
      if (request.userData?.type !== 'mcq') {
        if (/sitemap[^/]*\.xml$/i.test(request.url)) {
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
  
        let mcqDiscovered = 0;
        let internalDiscovered = 0;
  
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
              mcqDiscovered++;
            } else {
              await queue.addRequest({
                url: normalized,
                uniqueKey: 'discover:' + normalized,
                userData: { type: 'discover' }
              });
              internalDiscovered++;
            }
          } catch {}
        }
  
        log.info('MCQ discovery: ' + JSON.stringify({
          page: request.url,
          linksFound: links.length,
          mcqDiscovered,
          internalDiscovered
        }));
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
