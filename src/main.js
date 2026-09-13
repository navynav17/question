// Apify/Playwright pageFunction for all CEE chapter pages.
// Input can contain one or more chapter URLs. Each page is submitted first
// when possible, then the rendered result is extracted.
//
// Expected actor input:
// {
//   "startUrls": [{ "url": "https://pandeyramu.com.np/chapter/..." }],
//   "usernamePrefix": "Collector"
// }

async function pageFunction({ request, log }) {
    const page = request.page;

    // If this is an unsubmitted quiz page, submit it with a random username.
    // The site may require its own CSRF/session state, so use the live DOM form.
    const formState = await page.evaluate(() => {
        const form = document.querySelector('form.quiz-form');
        if (!form) return null;

        const submitted = form.classList.contains('submitted');
        const action = form.getAttribute('action') || location.href;
        const csrf = form.querySelector('input[name="csrfmiddlewaretoken"]')?.value || '';
        const attempt = form.querySelector('input[name="attempt_reference"]')?.value || '';
        const questionIds = [...form.querySelectorAll('.question-block')]
            .map(q => q.dataset.questionId)
            .filter(Boolean);

        return { submitted, action, csrf, attempt, questionIds };
    });

    if (formState && !formState.submitted) {
        const username = `Collector_${Math.random().toString(36).slice(2, 10)}`;

        try {
            await page.evaluate(({ username }) => {
                const form = document.querySelector('form.quiz-form');
                if (!form) return;

                let name = form.querySelector('input[name="name"]');
                if (!name) {
                    name = document.createElement('input');
                    name.type = 'hidden';
                    name.name = 'name';
                    form.appendChild(name);
                }
                name.value = username;

                // Submit with no answers. The server/result page is what we
                // need for extracting the correct answer and solution.
                form.submit();
            }, { username });

            await page.waitForLoadState('networkidle').catch(() => {});
        } catch (e) {
            log.warning(`Submit attempt failed: ${e.message}`);
        }
    }

    const results = await page.evaluate(() => {
        return [...document.querySelectorAll('.question-block')].map(q => {
            const number = q.dataset.questionNumber || '';
            const question = q.querySelector('strong')?.textContent.trim() || '';

            const opts = {};
            q.querySelectorAll('input[type="radio"]').forEach(input => {
                const label = input.closest('label');
                const text =
                    label?.querySelector('.option-text')?.textContent.trim() || '';
                opts[input.value] = text;
            });

            const correctInput =
                q.querySelector('label.correct input[type="radio"]');

            return {
                chapterUrl: location.href,
                number: Number(number),
                question: question.replace(/^\\d+\\.\\s*/, ''),
                A: opts.A || '',
                B: opts.B || '',
                C: opts.C || '',
                D: opts.D || '',
                answer: correctInput?.value || '',
                explanation:
                    q.querySelector('.solution-text')?.textContent.trim() || ''
            };
        });
    });

    log.info(`Extracted ${results.length} MCQs from ${page.url()}`);
    return results;
}
