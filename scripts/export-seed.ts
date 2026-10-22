/** `npm run export-seed [storyId]` — bundle a generated story into seed/ so AI_MODE=mock works without AWS. */
import fs from 'node:fs';
import path from 'node:path';
const dataDir = process.env.DATA_DIR ?? 'data';
const db = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
const stories = Object.values(db.stories as Record<string, any>).filter((s) => s.status === 'ready').sort((a, b) => b.createdAt.localeCompare(a.createdAt));
const story = process.argv[2] ? db.stories[process.argv[2]] : stories[0];
if (!story) throw new Error('No ready story to export');
const strip = (u?: string) => (u ? u.split('/').pop() : u);
const page = (p: any) => ({ ...p, _cast: undefined, imageUrl: strip(p.imageUrl), audioUrl: strip(p.audioUrl) });
const out = {
  ...story,
  pages: story.pages.map(page),
  choice: { ...story.choice, questionAudioUrl: strip(story.choice.questionAudioUrl), options: story.choice.options.map((o: any) => ({ ...o, pages: o.pages.map(page) })) },
  wordOfTheNight: { ...story.wordOfTheNight, audioUrl: strip(story.wordOfTheNight.audioUrl) },
  playback: { pageIndex: 0, wordsExplored: [], pagesHeard: 0 },
};
fs.rmSync('seed', { recursive: true, force: true });
fs.mkdirSync('seed/media', { recursive: true });
fs.writeFileSync('seed/story.json', JSON.stringify(out, null, 2));
fs.cpSync(path.join(dataDir, 'media', story.id), 'seed/media', { recursive: true });
console.log(`Exported “${story.title}” (${story.id}) → seed/`);
