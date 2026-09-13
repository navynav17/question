// Discover all chapter and subchapter URLs from the site.
// Use this as a separate Apify request handler before running the extractor.

async function discoverChapterUrls({ page, log }) {
    const base = 'https://pandeyramu.com.np';

    const urls = await page.evaluate((base) => {
        const found = new Set();

        document.querySelectorAll('a[href]').forEach(a => {
            try {
                const u = new URL(a.href, base);
                if (u.origin !== base) return;

                // Covers /chapter/<slug>/ and nested chapter/subchapter links.
                if (/^\/chapter\//.test(u.pathname)) {
                    found.add(u.href.split('#')[0]);
                }
            } catch {}
        });

        return [...found];
    }, base);

    log.info(`Discovered ${urls.length} chapter URLs`);
    return urls;
}

export { discoverChapterUrls };
