/**
 * `npx tsx scripts/revoice-seed.ts` — re-narrate the bundled demo story (seed/) with character voices, so
 * AI_MODE=mock (and the hosted demo) plays them too. Calls Claude Haiku once and Polly per page (a few cents).
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadDb } from '../src/store.js';
import * as store from '../src/store.js';
import { castVoices } from '../src/story/voices.js';
import { narrate } from '../src/story/narrator.js';
import type { Story } from '../src/types.js';

await loadDb();
const story = JSON.parse(fs.readFileSync('seed/story.json', 'utf8')) as Story;
const child = store.childrenOf(store.DEMO_FAMILY_ID)[0];
const pages = [...story.pages, ...story.choice!.options.flatMap((o) => o.pages)];
const plan = await castVoices(pages, child);
for (const page of pages) {
  const lines = plan[page.id];
  if (!lines) {
    console.log(`${page.id}: narrator only, unchanged`);
    continue;
  }
  const { audio, marks } = await narrate(page.text, lines);
  fs.writeFileSync(path.join('seed/media', `${page.id}.mp3`), audio);
  page.marks = marks;
  page.voices = lines;
  console.log(`${page.id}: ${lines.map((l) => (l.speaker === 'narrator' ? 'narrator' : `${l.speaker} (${l.voice})`)).join(', ')}`);
}
fs.writeFileSync('seed/story.json', JSON.stringify(story, null, 2));
