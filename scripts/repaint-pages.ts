/**
 * `npx tsx scripts/repaint-pages.ts <storyId> <pageId>...` — repaint chosen pages of a finished story until the
 * picture review passes (up to 4 tries each), keeping the original if no try does better. A page id ending in
 * `!` (a3!) is repainted at least once even if the review passes it, for problems you can see and it can't. For polishing a
 * story before it becomes the bundled seed; new stories are reviewed as they're painted.
 */
import fs from 'node:fs';
import path from 'node:path';
import * as store from '../src/store.js';
import { castIn, illustrate, illustrationPrompt, reviewPicture } from '../src/story/illustrator.js';
import { config } from '../src/config.js';

store.loadDb();
const [storyId, ...pageIds] = process.argv.slice(2);
const story = store.getStory(storyId);
if (!story) throw new Error(`No story ${storyId}`);
const child = store.getChild(story.childId)!;
const cast = [{ name: child.name, description: child.appearance }, child.world.sidekick, ...child.world.recurringCharacters, ...(story.newCharacters ?? [])];
const pages = [...story.pages, ...(story.choice?.options.flatMap((o) => o.pages) ?? [])];

for (const arg of pageIds) {
  const id = arg.replace(/!$/, '');
  const force = arg.endsWith('!');
  const page = pages.find((p) => p.id === id);
  if (!page) throw new Error(`No page ${id}`);
  const inScene: string[] = (page as any)._cast ?? cast.filter((c) => page.text.includes(c.name)).map((c) => c.name);
  const present = castIn(inScene, cast);
  const file = path.join(config.dataDir, 'media', story.id, `${id}.jpg`);
  const review = (img: Uint8Array) => reviewPicture(img, { text: page.text }, present, cast[0]);
  const current: Uint8Array = new Uint8Array(fs.readFileSync(file));
  let best = { img: current, v: await review(current) };
  if (force) best.v = { ...best.v, severity: 2, problems: [...best.v.problems, 'marked for a repaint'] };
  console.log(`${id}: now ${best.v.problems.join('; ') || 'good'}`);
  let fix = best.v.fix;
  for (let n = 1; n <= 4 && best.v.severity; n++) {
    const img = await illustrate(illustrationPrompt(page.illustrationPrompt, inScene, cast, fix), Math.floor(Math.random() * 2_000_000));
    const v = await review(img);
    console.log(`${id}: try ${n} ${v.problems.join('; ') || 'good'}`);
    if (v.severity * 100 + v.problems.length < best.v.severity * 100 + best.v.problems.length) best = { img, v };
    fix = v.fix ?? fix;
  }
  fs.writeFileSync(file, best.img);
}
