/** `npx tsx scripts/explain-guardrail.ts <storyId>` — show which guardrail policy fires on a story's pages. */
import fs from 'node:fs';
import { ApplyGuardrailCommand } from '@aws-sdk/client-bedrock-runtime';
import { bedrock } from '../src/story/aws.js';
import { config } from '../src/config.js';
const db = JSON.parse(fs.readFileSync('data/db.json', 'utf8'));
const s = db.stories[process.argv[2]] ?? Object.values(db.stories as Record<string, any>).sort((a: any, b: any) => b.createdAt.localeCompare(a.createdAt))[0];
const pages = [...s.pages, ...(s.choice?.options.flatMap((o: any) => o.pages) ?? [])];
console.log(`“${s.title}” (${s.status})`);
for (const p of pages) {
  const r = await bedrock.send(new ApplyGuardrailCommand({ guardrailIdentifier: config.guardrailId!, guardrailVersion: config.guardrailVersion, source: 'OUTPUT', content: [{ text: { text: p.text } }] }));
  const a = r.assessments?.[0];
  const hits = [
    ...(a?.contentPolicy?.filters ?? []).filter((f) => f.action === 'BLOCKED').map((f) => `content:${f.type}(${f.confidence})`),
    ...(a?.topicPolicy?.topics ?? []).filter((t) => t.action === 'BLOCKED').map((t) => `topic:${t.name}`),
    ...(a?.wordPolicy?.managedWordLists ?? []).map((w) => `word:${w.match}`),
  ];
  console.log(`${r.action === 'GUARDRAIL_INTERVENED' ? '🚫' : '✅'} ${p.id} ${hits.join(', ')} | ${p.text.slice(0, 110)}`);
}
