// Deduplication helpers for repeated Apify crawl cycles.
// The canonical key is stable across runs and does not depend on the
// random username or attempt reference.

function normalize(value) {
    return String(value ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function questionKey(item) {
    // Prefer the source question ID when available; otherwise use a stable
    // content key so the same question is not inserted twice.
    if (item.questionId) {
        return `qid:${item.questionId}`;
    }

    return [
        normalize(item.chapterUrl),
        normalize(item.question)
    ].join('|');
}

function buildSeenSet(items) {
    return new Set(items.map(questionKey));
}

function dedupeItems(items, seen = new Set()) {
    const output = [];

    for (const item of items) {
        const key = questionKey(item);
        if (!key || seen.has(key)) continue;
        seen.add(key);
        output.push(item);
    }

    return output;
}

export { normalize, questionKey, buildSeenSet, dedupeItems };
