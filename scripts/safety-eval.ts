/**
 * `npx tsx scripts/safety-eval.ts <cases.json>...` — scores the full safety layer used in production
 * (Bedrock Guardrails content filters per item, then the bedtime-suitability review) on labeled cases.
 */
import fs from 'node:fs';
import { applyGuardrail, reviewForBedtime } from '../src/story/safety.js';

let fp = 0, fn = 0, total = 0, byGuard = 0, byReview = 0;
const misses: string[] = [];
for (const file of process.argv.slice(2)) {
  const cases = JSON.parse(fs.readFileSync(file, 'utf8')) as { id: string; source?: 'INPUT' | 'OUTPUT'; expect: 'allow' | 'block'; text: string }[];
  const [guard, review] = await Promise.all([
    Promise.all(cases.map((c) => applyGuardrail(c.text, c.source ?? 'OUTPUT'))),
    reviewForBedtime(cases.map((c) => ({ kind: c.source === 'INPUT' ? 'request' : 'page', text: c.text }))),
  ]);
  cases.forEach((c, i) => {
    const blockedBy = !guard[i].ok ? `guardrail:${guard[i].reasons.join('+')}` : !review[i].suitable ? `review:${review[i].category}` : '';
    const got = blockedBy ? 'block' : 'allow';
    total++;
    if (blockedBy.startsWith('guardrail')) byGuard++;
    if (blockedBy.startsWith('review')) byReview++;
    if (got !== c.expect) {
      if (c.expect === 'allow') fp++;
      else fn++;
      misses.push(`${c.expect === 'allow' ? 'FALSE POSITIVE' : 'FALSE NEGATIVE'} ${c.id} [${blockedBy || 'allowed'}] ${review[i].why} | ${c.text.slice(0, 140)}`);
    }
  });
}
misses.forEach((m) => console.log(m));
console.log(JSON.stringify({ summary: true, total, falsePositives: fp, falseNegatives: fn, blockedByGuardrail: byGuard, blockedByReview: byReview }));
