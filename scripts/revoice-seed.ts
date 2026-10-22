/**
 * `npx tsx scripts/revoice-seed.ts` — re-narrate the bundled demo story (seed/) with the current narration
 * settings (character voices, bedtime pace), so AI_MODE=mock (and the hosted demo) plays them too: every page,
 * the choice question and the word of the night. Pages keep their voice casting; uncast pages get one Claude
 * Haiku casting call. Polly per page (a few cents).
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
const uncast = pages.filter((p) => !p.voices);
const plan = uncast.length ? await castVoices(uncast, child) : {};
const save = (file: string, audio: Uint8Array) => fs.writeFileSync(path.join('seed/media', file), audio);
for (const page of pages) {
  const lines = page.voices ?? plan[page.id];
  const { audio, marks } = await narrate(page.text, lines);
  save(`${page.id}.mp3`, audio);
  page.marks = marks;
  page.voices = lines;
  console.log(`${page.id}: ${lines ? lines.map((l) => (l.speaker === 'narrator' ? 'narrator' : `${l.speaker} (${l.voice})`)).join(', ') : 'narrator only'}`);
}
save('choice.mp3', (await narrate(story.choice!.question)).audio);
const w = story.wordOfTheNight!;
save('word.mp3', (await narrate(`${w.word}. ${w.meaning} For example: ${w.example}`)).audio);
console.log('choice and word of the night: re-narrated');
fs.writeFileSync('seed/story.json', JSON.stringify(story, null, 2));
