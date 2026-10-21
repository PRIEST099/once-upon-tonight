/**
 * `npx tsx scripts/refresh-demo-stories.ts` — after the bundled story (seed/) changes, update stories already
 * made from it (in demo mode) to the new narration: copy its MP3s and take its word timings and voice lines.
 * Run it while the server is stopped (the server keeps the database in memory).
 */
import fs from 'node:fs';
import path from 'node:path';
import * as store from '../src/store.js';
import { mediaDir } from '../src/media.js';
import type { Page, Story } from '../src/types.js';

store.loadDb();
const seed = JSON.parse(fs.readFileSync('seed/story.json', 'utf8')) as Story;
const seedPages = new Map<string, Page>([...seed.pages, ...seed.choice!.options.flatMap((o) => o.pages)].map((p) => [p.id, p]));
let n = 0;
for (const child of store.childrenOf(store.DEMO_FAMILY_ID)) {
  for (const story of store.storiesFor(child.id).filter((s) => s.title === seed.title && s.status === 'ready')) {
    const dir = path.join(mediaDir(), story.id);
    for (const page of [...story.pages, ...story.choice!.options.flatMap((o) => o.pages)]) {
      const from = seedPages.get(page.id);
      if (!from) continue;
      fs.copyFileSync(path.join('seed/media', `${page.id}.mp3`), path.join(dir, `${page.id}.mp3`));
      page.marks = from.marks;
      page.voices = from.voices;
    }
    store.putStory(story);
    n++;
  }
}
store.save();
console.log(`refreshed ${n} demo ${n === 1 ? 'story' : 'stories'}`);
