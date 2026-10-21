import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import * as store from '../store.js';
import { saveMedia, mediaDir, mediaUrl } from '../media.js';
import type { Character, Child, Page, Story, StoryRequest } from '../types.js';
import { writeStory, type DraftPage, type StoryDraft } from './writer.js';
import { illustrate, illustrationPrompt } from './illustrator.js';
import { narrate } from './narrator.js';
import { checkParentInput, checkStoryText } from './safety.js';

/**
 * The agentic story pipeline. A tool call only enqueues work (Alexa+ expects sub-500 ms tool
 * responses); the multi-step generation runs in the background and reports progress on the story
 * record, which the Studio view polls:
 *   1. write   — Amazon Bedrock (Converse + forced tool call) writes a branching story from today's
 *                moments and the child's persistent story world
 *   2. check   — Amazon Bedrock Guardrails + the parent's avoid-list
 *   3. draw    — Amazon Nova Canvas illustrates every page with a shared seed and cast descriptions
 *   4. narrate — Amazon Polly reads every page, returning word timings for read-along highlighting
 *   5. remember — the episode is folded into the child's story world for tomorrow night
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
  const run = config.aiMode === 'mock' ? runMock : runBedrock;
  run(story, child).catch((err) => {
    console.error(`[pipeline] ${story.id} failed`, err);
    update(story, { status: 'failed', error: friendlyError(err) }, `Something went wrong: ${friendlyError(err)}`);
  });
  return story;
}

function update(story: Story, patch: Partial<Story>, logLine?: string) {
  Object.assign(story, patch);
  if (logLine) {
    story.progress.step = logLine;
    story.progress.log.push(logLine);
  }
  store.putStory(story);
}

const tick = (story: Story, n = 1) => {
  story.progress.done += n;
  store.putStory(story);
};

async function runBedrock(story: Story, child: Child) {
  update(story, { status: 'writing' }, `Writing a story about ${child.name}'s day`);
  const input = await checkParentInput(`${story.request.todaysMoments} ${story.request.theme ?? ''}`);
  if (!input.ok) throw new Error(input.message ?? 'That request needs to be a little gentler for bedtime.');
  // Write, then check with the guardrail; if a draft is flagged, rewrite it once, gentler.
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
  story.safety = { checked: true, provider: safety.provider };
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
  // Image models have low on-demand rate limits: paint one page at a time, backing off when throttled.
  await pool(allPages, 1, async (page, i) => {
    const prompt = illustrationPrompt(page.illustrationPrompt, sceneCast(page), cast);
    try {
      page.imageUrl = await saveMedia(story.id, `${page.id}.jpg`, await withRetry(() => illustrate(prompt, seed)));
    } catch (err) {
      // Never lose the whole story over one picture: reuse the previous page's illustration.
      console.warn(`[pipeline] illustration ${i} failed; reusing the previous picture`, err);
      page.imageUrl = allPages[i - 1]?.imageUrl ?? allPages.find((p) => p.imageUrl)?.imageUrl;
    }
    tick(story);
  });

  update(story, { status: 'narrating' }, 'Recording the narration');
  await narration;
  const q = await narrate(story.choice!.question);
  story.choice!.questionAudioUrl = await saveMedia(story.id, 'choice.mp3', q.audio);
  tick(story);
  const w = story.wordOfTheNight!;
  const wa = await narrate(`${w.word}. ${w.meaning} For example: ${w.example}`);
  w.audioUrl = await saveMedia(story.id, 'word.mp3', wa.audio);
  tick(story);

  remember(child, story);
  story.progress.done = story.progress.total;
  update(story, { status: 'ready' }, `Tonight's story is ready: “${story.title}”`);
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

async function runMock(story: Story, child: Child) {
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
    await new Promise((r) => setTimeout(r, 1200));
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
  update(story, { status: 'ready' }, `Tonight's story is ready: “${story.title}”`);
}

// ---- helpers ---------------------------------------------------------------------------------

/** Retry AWS calls, backing off exponentially when Bedrock/Polly throttle us. */
async function withRetry<T>(fn: () => Promise<T>, tries = 5): Promise<T> {
  let delay = 4000;
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (err: any) {
      const throttled = err?.name === 'ThrottlingException' || err?.$metadata?.httpStatusCode === 429;
      if (attempt >= tries || (!throttled && attempt >= 2)) throw err;
      await new Promise((r) => setTimeout(r, throttled ? delay : 1000));
      delay *= 2;
    }
  }
}

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
