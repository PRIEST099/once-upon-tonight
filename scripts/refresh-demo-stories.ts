/**
 * `npx tsx scripts/refresh-demo-stories.ts ["Old seed title"...]` — after the bundled story (seed/) changes,
 * update the stories already made from it in demo mode. Stories with the seed's title get its narration (MP3s,
 * word timings, voice lines); stories with an old seed title named on the command line are replaced outright
 * (text, pictures, narration, choice), and the child's episode memory follows.
 * Run it while the server is stopped (the server keeps the database in memory).
 */
import fs from 'node:fs';
import path from 'node:path';
import * as store from '../src/store.js';
import { mediaDir, mediaUrl } from '../src/media.js';
import type { Page, Story } from '../src/types.js';

store.loadDb();
const seed = JSON.parse(fs.readFileSync('seed/story.json', 'utf8')) as Story;
const oldTitles = new Set(process.argv.slice(2));
const seedPages = new Map<string, Page>([...seed.pages, ...seed.choice!.options.flatMap((o) => o.pages)].map((p) => [p.id, p]));
let renarrated = 0;
let replaced = 0;
for (const child of store.childrenOf(store.DEMO_FAMILY_ID)) {
  for (const story of store.storiesFor(child.id).filter((s) => s.status === 'ready')) {
    const dir = path.join(mediaDir(), story.id);
    if (story.title === seed.title) {
      for (const page of [...story.pages, ...story.choice!.options.flatMap((o) => o.pages)]) {
        const from = seedPages.get(page.id);
        if (!from) continue;
        fs.copyFileSync(path.join('seed/media', `${page.id}.mp3`), path.join(dir, `${page.id}.mp3`));
        page.marks = from.marks;
        page.voices = from.voices;
      }
      renarrated++;
    } else if (story.title && oldTitles.has(story.title)) {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.cpSync('seed/media', dir, { recursive: true });
      const rebase = (u?: string) => (u ? mediaUrl(story.id, u.split('/').pop()!) : u);
      const fix = (p: Page): Page => ({ ...p, imageUrl: rebase(p.imageUrl), audioUrl: rebase(p.audioUrl) });
      Object.assign(story, {
        title: seed.title,
        dedication: seed.dedication,
        pages: seed.pages.map(fix),
        choice: {
          ...seed.choice!,
          questionAudioUrl: rebase(seed.choice!.questionAudioUrl),
          options: seed.choice!.options.map((o) => ({ ...o, pages: o.pages.map(fix) })),
        },
        wordOfTheNight: { ...seed.wordOfTheNight!, audioUrl: rebase(seed.wordOfTheNight!.audioUrl) },
        episodeSummary: seed.episodeSummary,
        newCharacters: seed.newCharacters,
        newPlaces: seed.newPlaces,
        playback: { pageIndex: 0, wordsExplored: [], pagesHeard: 0 },
      });
      const ep = child.world.episodes.find((e) => e.storyId === story.id);
      if (ep) {
        Object.assign(ep, { title: seed.title, summary: seed.episodeSummary ?? '', wordOfTheNight: seed.wordOfTheNight?.word, choiceOptions: seed.choice!.options.map((o) => o.label) });
        delete ep.choiceMade;
      }
      replaced++;
    } else continue;
    store.putStory(story);
  }
  store.updateChild(child);
}
store.save();
console.log(`re-narrated ${renarrated}, replaced ${replaced} demo ${replaced + renarrated === 1 ? 'story' : 'stories'}`);
