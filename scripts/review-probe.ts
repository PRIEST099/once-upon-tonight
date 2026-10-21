/**
 * `npx tsx scripts/review-probe.ts <cases.json>...` — score the bedtime-suitability review (alone)
 * on labeled cases; prints one JSON line per case plus a summary (same format as guardrail-probe).
 */
import fs from 'node:fs';
import { reviewForBedtime } from '../src/story/safety.js';

let fp = 0;
let fn = 0;
let total = 0;
for (const file of process.argv.slice(2)) {
  const cases = JSON.parse(fs.readFileSync(file, 'utf8')) as { id: string; source?: string; expect: 'allow' | 'block'; text: string }[];
  const verdicts = await reviewForBedtime(cases.map((c) => ({ kind: c.source === 'INPUT' ? 'request' : 'page', text: c.text })));
  cases.forEach((c, i) => {
    const got = verdicts[i].suitable ? 'allow' : 'block';
    const correct = got === c.expect;
    total++;
    if (!correct && c.expect === 'allow') fp++;
    if (!correct && c.expect === 'block') fn++;
    console.log(JSON.stringify({ id: c.id, expect: c.expect, got, correct, reasons: [`review:${verdicts[i].category}`], why: verdicts[i].why }));
  });
}
console.log(JSON.stringify({ summary: true, reviewer: 'bedtime review', total, falsePositives: fp, falseNegatives: fn }));
