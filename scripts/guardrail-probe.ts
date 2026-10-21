/**
 * `npx tsx scripts/guardrail-probe.ts <cases.json> [--guardrail <id> --version <v>]`
 * Runs each case through the Bedrock Guardrail and reports pass/fail against the expectation.
 * cases.json: [{ "id": "swim-1", "source": "OUTPUT" | "INPUT", "expect": "allow" | "block", "text": "…" }]
 * Prints one JSON line per case plus a summary line (machine-readable for review agents).
 */
import fs from 'node:fs';
import { config } from '../src/config.js';

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
if (arg('guardrail')) config.guardrailId = arg('guardrail');
if (arg('version')) config.guardrailVersion = arg('version')!;
const { applyGuardrail } = await import('../src/story/safety.js');

const cases = JSON.parse(fs.readFileSync(process.argv[2], 'utf8')) as { id: string; source?: 'INPUT' | 'OUTPUT'; expect: 'allow' | 'block'; text: string }[];
let falsePositives = 0;
let falseNegatives = 0;
for (const c of cases) {
  const v = await applyGuardrail(c.text, c.source ?? 'OUTPUT');
  const got = v.ok ? 'allow' : 'block';
  const correct = got === c.expect;
  if (!correct && c.expect === 'allow') falsePositives++;
  if (!correct && c.expect === 'block') falseNegatives++;
  console.log(JSON.stringify({ id: c.id, expect: c.expect, got, correct, reasons: v.reasons }));
  await new Promise((r) => setTimeout(r, 120)); // stay well under ApplyGuardrail rate limits
}
console.log(JSON.stringify({ summary: true, guardrail: `${config.guardrailId}:${config.guardrailVersion}`, total: cases.length, falsePositives, falseNegatives }));
