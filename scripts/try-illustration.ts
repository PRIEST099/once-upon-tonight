/** `npx tsx scripts/try-illustration.ts <storyId> <pageId>` — re-illustrate one page to tune prompts. */
import fs from 'node:fs';
import { illustrate, illustrationPrompt } from '../src/story/illustrator.js';
const db = JSON.parse(fs.readFileSync('data/db.json', 'utf8'));
const story = db.stories[process.argv[2]] ?? Object.values(db.stories)[0];
const all = [...story.pages, ...story.choice.options.flatMap((o: any) => o.pages)];
const page = all.find((p: any) => p.id === (process.argv[3] ?? 'p1'));
const child = db.children[story.childId];
const prompt = illustrationPrompt(page.illustrationPrompt, page._cast ?? [], [{ name: child.name, description: child.appearance }, child.world.sidekick]);
console.log(prompt, '\n', prompt.length, 'chars');
const outFile = process.env.OUT ?? `data/try-${page.id}.jpg`; fs.writeFileSync(outFile, await illustrate(prompt, 1234));
console.log(`→ ${outFile}`);
