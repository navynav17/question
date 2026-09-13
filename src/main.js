// Apify actor page.evaluate() extraction for submitted CEE MCQs.
// Extracts question, options, marked correct answer, and solution/explanation.

async function pageFunction({ request, log }) {
    const results = await request.page.evaluate(() => {
        return [...document.querySelectorAll('.question-block')].map(q => {
            const number = q.dataset.questionNumber || '';
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
                number: Number(number),
                question: question.replace(/^\d+\.\s*/, ''),
                A: opts.A || '',
                B: opts.B || '',
                C: opts.C || '',
                D: opts.D || '',
                answer,
                explanation
            };
        });
    });

    log.info(`Extracted ${results.length} MCQs`);

    return results;
}
