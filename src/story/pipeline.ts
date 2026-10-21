import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import * as store from '../store.js';
import { saveMedia, mediaDir, mediaUrl } from '../media.js';
import type { Character, Child, Page, Story, StoryRequest } from '../types.js';
import { writeStory, type DraftPage, type StoryDraft } from './writer.js';
import { illustrate, illustrationPrompt } from './illustrator.js';
import { narrate } from './narrator.js';
import { checkParentInput, checkStoryText, moderateImage } from './safety.js';
import { CostMeter, metered } from './cost.js';
import { withRetry } from './retry.js';

/**
 * The agentic story pipeline. A tool call only enqueues work (Alexa+ expects sub-500 ms tool
 * responses); the multi-step generation runs in the background and reports progress on the story
 * record, which the Studio view polls:
 *   1. write   — Claude Sonnet on Amazon Bedrock (Converse + forced tool call) writes a branching
 *                story from today's moments and the child's persistent story world
 *   2. check   — the parent's avoid-list, then Amazon Bedrock Guardrails and a Claude Haiku
 *                bedtime-suitability review on every page (the parent's request is screened first)
 *   3. draw    — Stability AI SD3.5 Large on Bedrock illustrates every page with a shared seed and
 *                cast descriptions; Amazon Rekognition moderates each picture before it is kept
 *   4. narrate — Amazon Polly reads every page, returning word timings for read-along highlighting
 *   5. remember — the episode is folded into the child's story world for tomorrow night
 * Every AWS call reports its usage to a per-story meter, so a finished story carries an estimate
 * of what it cost to make (story.cost) and how long it took (story.generationMs).
 */
export function createStory(child: Child, request: StoryRequest): Story {
  const story: Story = {
    id: store.newId('story'),
    familyId: child.familyId,
    childId: child.id,
    createdAt: new Date().toISOString(),
    status: 'queued',
    progress: { step: 'Getting the story studio ready', done: 0, total: 1, log: [] },
    request,
    pages: [],
    playback: { pageIndex: 0, wordsExplored: [], pagesHeard: 0 },
  };
  store.putStory(story);
  const meter = new CostMeter();
  const run = config.aiMode === 'mock' ? runMock : runBedrock;
  metered(meter, () => run(story, child, meter)).catch((err) => {
    if (err instanceof Cancelled || !store.getStory(story.id)) {
      // The parent deleted the story world mid-generation: stop, and remove anything written since.
      console.log(`[pipeline] ${story.id} stopped: deleted while being made`);
      fs.rm(path.join(mediaDir(), story.id), { recursive: true, force: true }).catch(() => {});
      return;
    }
    console.error(`[pipeline] ${story.id} failed`, err);
    update(story, { status: 'failed', error: friendlyError(err), ...spent(story, meter) }, `Something went wrong: ${friendlyError(err)}`);
  });
  return story;
}

/** What the story cost so far, and how long since it was asked for. No AWS is called in mock mode. */
const spent = (story: Story, meter: CostMeter): Pick<Story, 'cost' | 'generationMs'> => ({
  ...(config.aiMode !== 'mock' && { cost: meter.summary() }),
  generationMs: Date.now() - Date.parse(story.createdAt),
});

/** Thrown to stop a pipeline whose story was deleted (forget_story_world) while it was being made. */
class Cancelled extends Error {}
/** Never write a deleted story back: that would resurrect it after the parent asked to forget it. */
function ensureAlive(story: Story) {
  if (!store.getStory(story.id)) throw new Cancelled(`story ${story.id} was deleted`);
}

function update(story: Story, patch: Partial<Story>, logLine?: string) {
  ensureAlive(story);
  Object.assign(story, patch);
  if (logLine) {
    story.progress.step = logLine;
    story.progress.log.push(logLine);
  }
  store.putStory(story);
}

const tick = (story: Story, n = 1) => {
  ensureAlive(story);
  story.progress.done += n;
  store.putStory(story);
};

async function runBedrock(story: Story, child: Child, meter: CostMeter) {
  update(story, { status: 'writing' }, `Writing a story about ${child.name}'s day`);
  const input = await checkParentInput(`${story.request.todaysMoments} ${story.request.theme ?? ''}`);
  if (!input.ok) throw new Error(input.message ?? 'That request needs to be a little gentler for bedtime.');
  // Write, then check every page; if a draft is flagged, rewrite it once, gentler.
  let request = story.request;
  let safety: Awaited<ReturnType<typeof checkStoryText>> = { ok: false, provider: '' };
  for (let attempt = 1; attempt <= 2; attempt++) {
    const draft = await writeStory(child, request);
    assemble(story, draft);
    update(story, { status: 'checking' }, `“${draft.title}” is written. Checking it's just right for bedtime`);
    safety = await checkStoryText(child, [...allPagesOf(story).map((p) => p.text), story.choice!.question]);
    if (safety.ok) break;
    console.warn(`[pipeline] draft ${attempt} flagged by ${safety.provider}: ${safety.notes}`);
    if (attempt === 2) throw new Error(`Safety check (${safety.provider}) flagged the story twice: ${safety.notes}`);
    update(story, { status: 'writing' }, 'Making the story a little gentler');
    request = { ...request, todaysMoments: `${request.todaysMoments}\n(Write this version extra gentle and calm. The previous draft was flagged for bedtime: ${safety.notes ?? 'too intense'})` };
  }
  const allPages = allPagesOf(story);
  const narrationItems = allPages.length + 2; // + choice question + word of the night
  story.progress.total = 2 + allPages.length + narrationItems + 1;
  story.progress.done = 2;
  const checks = (story.safety = { checked: true, provider: safety.provider, imagesChecked: 0, imagesRegenerated: 0, imagesReplaced: 0, imagesUnchecked: 0 });
  tick(story);

  update(story, { status: 'illustrating' }, `Painting ${allPages.length} illustrations`);
  const cast: Character[] = [
    { name: child.name, description: child.appearance },
    child.world.sidekick,
    ...child.world.recurringCharacters,
    ...(story.newCharacters ?? []),
  ];
  const seed = Math.floor(Math.random() * 2_000_000);
  // Narration doesn't depend on the pictures, so record it while the (rate-limited) painter works.
  const narration = pool(allPages, 3, async (page) => {
    const { audio, marks } = await withRetry(() => narrate(page.text));
    page.audioUrl = await saveMedia(story.id, `${page.id}.mp3`, audio);
    page.marks = marks;
    tick(story);
  });
  // Awaited after painting; until then, an early failure must not become an unhandled rejection.
  narration.catch(() => {});
  // Image models have low on-demand rate limits: paint one page at a time, backing off when throttled.
  await pool(allPages, 1, async (page, i) => {
    const prompt = illustrationPrompt(page.illustrationPrompt, sceneCast(page), cast);
    try {
      page.imageUrl = await saveMedia(story.id, `${page.id}.jpg`, await paintChecked(prompt, seed, checks));
    } catch (err) {
      // Never lose the whole story over one picture: reuse the previous page's illustration.
      console.warn(`[pipeline] illustration ${i} failed or was flagged; reusing the previous picture`, err);
      checks.imagesReplaced++;
      page.imageUrl = allPages[i - 1]?.imageUrl ?? allPages.find((p) => p.imageUrl)?.imageUrl;
    }
    tick(story);
  });

  update(story, { status: 'narrating' }, 'Recording the narration');
  await narration;
  const q = await withRetry(() => narrate(story.choice!.question));
  story.choice!.questionAudioUrl = await saveMedia(story.id, 'choice.mp3', q.audio);
  tick(story);
  const w = story.wordOfTheNight!;
  const wa = await withRetry(() => narrate(`${w.word}. ${w.meaning} For example: ${w.example}`));
  w.audioUrl = await saveMedia(story.id, 'word.mp3', wa.audio);
  tick(story);

  remember(child, story);
  story.progress.done = story.progress.total;
  update(story, { status: 'ready', ...spent(story, meter) }, `Tonight's story is ready: “${story.title}”`);
}

/** Repaints (each with a fresh seed) allowed after Rekognition flags an illustration. */
const MAX_REPAINTS = 2;

/**
 * Paint one page, then let Amazon Rekognition look at the actual pixels before we keep them. A
 * flagged picture is repainted with a new seed. If the repaints are flagged too, this throws and
 * the caller reuses the previous page's picture. If the check itself is unavailable, the picture is
 * kept and counted as unchecked (it has still passed the image model's built-in filter).
 */
async function paintChecked(prompt: string, seed: number, checks: { imagesChecked: number; imagesRegenerated: number; imagesUnchecked?: number }) {
  for (let attempt = 0; ; attempt++) {
    const image = await withRetry(() => illustrate(prompt, attempt ? Math.floor(Math.random() * 2_000_000) : seed));
    let verdict: Awaited<ReturnType<typeof moderateImage>>;
    try {
      verdict = await moderateImage(image);
    } catch (err) {
      // Rekognition unavailable (permissions, outage): keep the picture, which already passed the image
      // model's own safety filter, and record that it went unchecked rather than losing every illustration.
      console.warn('[pipeline] Rekognition check unavailable; keeping the illustration unchecked', err);
      checks.imagesUnchecked = (checks.imagesUnchecked ?? 0) + 1;
      return image;
    }
    checks.imagesChecked++;
    if (verdict.ok) return image;
    if (attempt >= MAX_REPAINTS) throw new Error(`Rekognition flagged the picture ${attempt + 1} times (${verdict.labels.join(', ')})`);
    console.warn(`[pipeline] Rekognition flagged an illustration (${verdict.labels.join(', ')}); repainting with a new seed`);
    checks.imagesRegenerated++;
  }
}

/** Map the model's draft onto our story record with stable page ids. */
function assemble(story: Story, d: StoryDraft) {
  const toPage = (p: DraftPage, id: string): Page => ({
    id,
    text: p.text.trim(),
    illustrationPrompt: p.scene,
    ...({ _cast: p.charactersInScene } as object),
  });
  story.title = d.title;
  story.dedication = d.dedication;
  story.pages = d.sharedPages.map((p, i) => toPage(p, `p${i + 1}`));
  story.choice = {
    question: d.choice.question,
    options: [
      { id: 'a', label: d.choice.options[0].label, pages: d.choice.options[0].pages.map((p, i) => toPage(p, `a${i + 1}`)) },
      { id: 'b', label: d.choice.options[1].label, pages: d.choice.options[1].pages.map((p, i) => toPage(p, `b${i + 1}`)) },
    ],
  };
  story.wordOfTheNight = d.wordOfTheNight;
  story.episodeSummary = d.episodeSummary;
  story.newCharacters = d.newCharacters;
  story.newPlaces = d.newPlaces;
}

const allPagesOf = (s: Story) => [...s.pages, ...(s.choice?.options.flatMap((o) => o.pages) ?? [])];
const sceneCast = (p: Page) => ((p as any)._cast as string[] | undefined) ?? [];

/** Fold tonight's episode into the child's persistent story world (context across sessions). */
function remember(child: Child, story: Story) {
  ensureAlive(story);
  const fresh = store.getChild(child.id) ?? child;
  const known = new Set([fresh.world.sidekick.name, ...fresh.world.recurringCharacters.map((c) => c.name)].map((n) => n.toLowerCase()));
  for (const c of story.newCharacters ?? []) {
    if (!known.has(c.name.toLowerCase()) && c.name.toLowerCase() !== fresh.name.toLowerCase()) fresh.world.recurringCharacters.push(c);
  }
  for (const p of story.newPlaces ?? []) if (!fresh.world.places.includes(p)) fresh.world.places.push(p);
  fresh.world.episodes.push({
    storyId: story.id,
    date: story.createdAt.slice(0, 10),
    title: story.title ?? 'Untitled',
    summary: story.episodeSummary ?? '',
    wordOfTheNight: story.wordOfTheNight?.word,
  });
  store.updateChild(fresh);
}

// ---- mock mode: replay the bundled seed story so the project runs without AWS -------------

async function runMock(story: Story, child: Child, meter: CostMeter) {
  const seedDir = path.resolve('seed');
  const seedStory = JSON.parse(await fs.readFile(path.join(seedDir, 'story.json'), 'utf8')) as Story;
  const steps: [Story['status'], string][] = [
    ['writing', `Writing a story about ${child.name}'s day`],
    ['checking', `“${seedStory.title}” is written. Checking it's just right for bedtime`],
    ['illustrating', 'Painting the illustrations'],
    ['narrating', 'Recording the narration'],
  ];
  story.progress.total = steps.length + 1;
  for (const [status, line] of steps) {
    update(story, { status }, line);
    await new Promise((r) => setTimeout(r, config.mockStepMs));
    tick(story);
  }
  await fs.cp(path.join(seedDir, 'media'), path.join(mediaDir(), story.id), { recursive: true });
  const rebase = (u?: string) => (u ? mediaUrl(story.id, u.split('/').pop()!) : u);
  const fix = (p: Page): Page => ({ ...p, imageUrl: rebase(p.imageUrl), audioUrl: rebase(p.audioUrl) });
  Object.assign(story, {
    title: seedStory.title,
    dedication: seedStory.dedication,
    pages: seedStory.pages.map(fix),
    choice: seedStory.choice && {
      ...seedStory.choice,
      questionAudioUrl: rebase(seedStory.choice.questionAudioUrl),
      options: seedStory.choice.options.map((o) => ({ ...o, pages: o.pages.map(fix) })),
    },
    wordOfTheNight: seedStory.wordOfTheNight && { ...seedStory.wordOfTheNight, audioUrl: rebase(seedStory.wordOfTheNight.audioUrl) },
    episodeSummary: seedStory.episodeSummary,
    newCharacters: seedStory.newCharacters,
    newPlaces: seedStory.newPlaces,
    safety: { checked: true, provider: 'seed story (mock mode)' },
  });
  remember(child, story);
  story.progress.done = story.progress.total;
  update(story, { status: 'ready', ...spent(story, meter) }, `Tonight's story is ready: “${story.title}”`);
}

// ---- helpers ---------------------------------------------------------------------------------

async function pool<T>(items: T[], size: number, fn: (item: T, i: number) => Promise<void>) {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        await fn(items[i], i);
      }
    }),
  );
}

function friendlyError(err: unknown) {
  const msg = err instanceof Error ? err.message : String(err);
  if (/credential/i.test(msg)) return 'AWS credentials are not configured (set AI_MODE=mock to run without AWS)';
  if (/access ?denied|not authorized/i.test(msg)) return 'This AWS account does not have access to the Bedrock model yet';
  return msg.slice(0, 200);
}
