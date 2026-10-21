import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { config } from './config.js';
import * as store from './store.js';
import { createStory } from './story/pipeline.js';
import { rebaseMediaUrl } from './media.js';
import type { Child, Page, Story } from './types.js';

// ---- the MCP App (one self-contained HTML bundle, content-hashed URI so hosts can cache it) ----

const APP_HTML_PATH = path.resolve('app/dist/index.html');
let appHtml = '';
let APP_URI = 'ui://once-upon-tonight/app.html';

export function loadAppBundle() {
  appHtml = fs.existsSync(APP_HTML_PATH)
    ? fs.readFileSync(APP_HTML_PATH, 'utf8')
    : '<!doctype html><p>Run <code>npm run build:app</code> to build the storybook view.</p>';
  APP_URI = `ui://once-upon-tonight/app-${createHash('sha256').update(appHtml).digest('hex').slice(0, 8)}.html`;
}

/** Dev convenience: pick up a rebuilt view without restarting (the URI hash changes with it). */
export function watchAppBundle() {
  fs.watchFile(APP_HTML_PATH, { interval: 1000 }, () => {
    loadAppBundle();
    console.log(`[mcp] storybook view reloaded → ${APP_URI}`);
  });
}

const VIEW_KEY = 'once-upon-tonight/view';
const THEMES = ['bravery', 'kindness', 'friendship', 'trying something new', 'calming big feelings', 'family', 'gratitude', 'adventure'] as const;

type View =
  | { view: 'studio'; story: ReturnType<typeof studioData> }
  | { view: 'storybook'; story: ReturnType<typeof bookData>; position: number }
  | { view: 'library'; hero: string; stories: ReturnType<typeof libraryItem>[] }
  | { view: 'recap'; recap: ReturnType<typeof recapData> }
  | { view: 'world'; hero: ReturnType<typeof heroData> }
  | { view: 'message'; title: string; body: string };

/**
 * Every tool answers in three layers:
 *  - content[0].text      → what the assistant should say (voice-first, no markup, < 30 s)
 *  - structuredContent    → compact facts the assistant can reason over and recall later
 *  - _meta[VIEW_KEY]      → the full payload the storybook view renders (kept out of the model's context)
 * `_meta.ui.resourceUri` is repeated on the result because Alexa+ renders custom visuals when the
 * tool response carries it, while the MCP Apps standard reads it from the tool definition.
 */
function reply(say: string, facts: Record<string, unknown>, view?: View, status?: { invoking: string; invoked: string }) {
  return {
    content: [{ type: 'text' as const, text: say }],
    structuredContent: facts,
    _meta: {
      ...(view && { ui: { resourceUri: APP_URI, ...status }, [VIEW_KEY]: view }),
    },
  };
}

function fail(say: string) {
  return { ...reply(say, { ok: false, message: say }, { view: 'message', title: 'Hmm…', body: say }), isError: true };
}

const uiMeta = (visibility?: ('model' | 'app')[]) => ({ ui: { resourceUri: APP_URI, ...(visibility && { visibility }) } });

// ---- view payloads ---------------------------------------------------------------------------

const media = (p: Page) => ({ ...p, imageUrl: rebaseMediaUrl(p.imageUrl), audioUrl: rebaseMediaUrl(p.audioUrl) });

function studioData(s: Story, child: Child) {
  return {
    id: s.id,
    hero: child.name,
    status: s.status,
    title: s.title,
    step: s.progress.step,
    log: s.progress.log,
    done: s.progress.done,
    total: s.progress.total,
    error: s.error,
    preview: s.pages.filter((p) => p.imageUrl).slice(0, 3).map((p) => rebaseMediaUrl(p.imageUrl)),
  };
}

function bookData(s: Story, child: Child) {
  return {
    id: s.id,
    hero: child.name,
    sidekick: child.world.sidekick.name,
    title: s.title,
    dedication: s.dedication,
    pages: s.pages.map(media),
    choice: s.choice && {
      question: s.choice.question,
      questionAudioUrl: rebaseMediaUrl(s.choice.questionAudioUrl),
      options: s.choice.options.map((o) => ({ id: o.id, label: o.label, pages: o.pages.map(media) })),
    },
    wordOfTheNight: s.wordOfTheNight && { ...s.wordOfTheNight, audioUrl: rebaseMediaUrl(s.wordOfTheNight.audioUrl) },
    branch: s.playback.branch,
  };
}

function libraryItem(s: Story) {
  return { id: s.id, title: s.title, date: s.createdAt.slice(0, 10), cover: rebaseMediaUrl(s.pages[0]?.imageUrl), choiceMade: s.playback.branch && s.choice?.options.find((o) => o.id === s.playback.branch)?.label };
}

function heroData(c: Child) {
  return {
    name: c.name,
    age: c.age,
    readingLevel: c.readingLevel,
    sidekick: c.world.sidekick,
    favoriteThings: c.favoriteThings,
    avoid: c.avoid,
    places: c.world.places,
    characters: c.world.recurringCharacters,
    episodes: c.world.episodes.slice(-5).reverse(),
  };
}

function recapData(s: Story, c: Child) {
  const branch = s.choice?.options.find((o) => o.id === s.playback.branch);
  return {
    hero: c.name,
    title: s.title,
    date: s.createdAt.slice(0, 10),
    finished: Boolean(s.playback.finishedAt),
    pagesHeard: s.playback.pagesHeard,
    totalPages: s.pages.length + (branch?.pages.length ?? s.choice?.options[0].pages.length ?? 0),
    choiceQuestion: s.choice?.question,
    choiceMade: branch?.label,
    wordOfTheNight: s.wordOfTheNight?.word,
    wordsExplored: s.playback.wordsExplored,
    summary: s.episodeSummary,
    cover: rebaseMediaUrl(s.pages[0]?.imageUrl),
    worldSize: { places: c.world.places.length, characters: c.world.recurringCharacters.length + 1, episodes: c.world.episodes.length },
  };
}

// ---- reading position helpers ------------------------------------------------------------------
// Positions: 0..k-1 shared pages · k = the choice · k+1..k+m chosen path · k+m+1 = "The End"

function stepAt(s: Story, pos: number): { kind: 'page'; page: Page; number: number; total: number } | { kind: 'choice' } | { kind: 'end' } {
  const k = s.pages.length;
  const branch = s.choice?.options.find((o) => o.id === s.playback.branch);
  const m = branch?.pages.length ?? s.choice?.options[0].pages.length ?? 0;
  const total = k + m;
  if (pos < k) return { kind: 'page', page: s.pages[pos], number: pos + 1, total };
  if (pos === k) return { kind: 'choice' };
  if (!branch) return { kind: 'choice' };
  if (pos - k - 1 < branch.pages.length) return { kind: 'page', page: branch.pages[pos - k - 1], number: pos, total };
  return { kind: 'end' };
}

function describeStep(s: Story, child: Child, pos: number) {
  const step = stepAt(s, pos);
  if (step.kind === 'page') return { say: step.page.text, facts: { page: step.number, of: step.total, text: step.page.text } };
  if (step.kind === 'choice') {
    const [a, b] = s.choice!.options;
    return {
      say: `${s.choice!.question} Say “${a.label}” or “${b.label}”.`,
      facts: { awaitingChoice: true, question: s.choice!.question, options: [a.label, b.label] },
    };
  }
  return { say: `The end. Goodnight, ${child.name}.`, facts: { finished: true } };
}

function resolveStory(familyId: string, storyId?: string, hero?: string): { story?: Story; child?: Child; problem?: string } {
  if (storyId) {
    const story = store.getStory(storyId);
    if (!story || story.familyId !== familyId) return { problem: "I couldn't find that story." };
    return { story, child: store.getChild(story.childId) };
  }
  const child = store.resolveChild(familyId, hero);
  if (!child) return { problem: hero ? `There's no story hero named ${hero} yet.` : 'No story hero is set up yet.' };
  const story = store.latestReadyStory(child.id);
  if (!story) {
    const pending = store.storiesFor(child.id)[0];
    return {
      child,
      problem:
        pending && pending.status !== 'failed'
          ? `${child.name}'s story is still being made. ${pending.progress.step}.`
          : `There's no story for ${child.name} yet. Ask me to make tonight's story first.`,
    };
  }
  return { story, child };
}

// ---- server factory (stateless: one per request, scoped to the linked family) ----------------

export function createMcpServer(familyId: string) {
  const server = new McpServer(
    { name: 'once-upon-tonight', title: 'Once Upon Tonight', version: '0.1.0' },
    {
      instructions:
        'Once Upon Tonight makes a personalized, illustrated, narrated bedtime story from the day a family just had, then reads it page by page. ' +
        'A parent creates the story (create_tonights_story); at bedtime anyone can open it (open_storybook), turn pages, and choose what happens next. ' +
        'Stories remember earlier nights, so recurring friends and places come back.',
    },
  );

  registerAppResource(
    server,
    'Once Upon Tonight storybook',
    APP_URI,
    { description: 'Storybook, story studio, library and recap views' },
    async () => ({
      contents: [
        {
          uri: APP_URI,
          mimeType: RESOURCE_MIME_TYPE,
          text: appHtml,
          _meta: {
            ui: {
              csp: { resourceDomains: [new URL(config.publicUrl).origin], connectDomains: [new URL(config.publicUrl).origin] },
              prefersBorder: false,
            },
          },
        },
      ],
    }),
  );

  registerAppTool(
    server,
    'create_tonights_story',
    {
      title: "Make tonight's story",
      description:
        "Start making tonight's bedtime story from what happened in the child's day. Use when a parent says things like " +
        '"make tonight\'s story about the zoo trip", "Maya lost her first tooth today, make a story about it", or ' +
        '"she\'s nervous about the dentist tomorrow". Writing, illustrating and narrating takes about a minute and runs in the background; ' +
        'reply that it will be ready by bedtime. Pass everything the parent said about the day in todays_moments.',
      inputSchema: z.object({
        todays_moments: z
          .string()
          .min(3)
          .max(600)
          .describe("What happened today or what's on the child's mind (events, feelings, worries, wins), in the parent's words."),
        theme: z.enum(THEMES).optional().describe('Optional gentle theme or value for the story.'),
        length: z.enum(['short', 'standard']).optional().describe('short ≈ 3 minutes, standard ≈ 5 minutes. Default standard.'),
        hero: z.string().max(40).optional().describe("Which child's story this is, by the nickname the parent set up. Omit if there is only one."),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
      _meta: uiMeta(),
    },
    async ({ todays_moments, theme, length, hero }) => {
      const child = store.resolveChild(familyId, hero);
      if (!child) return fail(hero ? `I don't have a story hero named ${hero}.` : 'No story hero is set up yet.');
      const story = createStory(child, { todaysMoments: todays_moments, theme, length: length ?? 'standard' });
      return reply(
        `I'm making tonight's story for ${child.name} now. It will be ready in about a minute, so it's all set for bedtime.`,
        { storyId: story.id, hero: child.name, status: story.status, readyInSeconds: 60 },
        { view: 'studio', story: studioData(story, child) },
        { invoking: 'Opening the story studio…', invoked: 'Story studio' },
      );
    },
  );

  registerAppTool(
    server,
    'check_story_progress',
    {
      title: 'Check story progress',
      description: 'Check whether tonight\'s story is ready yet ("is the story ready?", "how\'s the story coming along?").',
      inputSchema: z.object({
        story_id: z.string().optional().describe('Story id from create_tonights_story. Omit for the most recent story.'),
        hero: z.string().max(40).optional(),
      }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: uiMeta(['model', 'app']),
    },
    async ({ story_id, hero }) => {
      const child = story_id ? undefined : store.resolveChild(familyId, hero);
      const story = story_id ? store.getStory(story_id) : child && store.storiesFor(child.id)[0];
      if (!story || story.familyId !== familyId) return fail("I couldn't find a story in progress.");
      const kid = store.getChild(story.childId)!;
      const say =
        story.status === 'ready'
          ? `“${story.title}” is ready whenever ${kid.name} is.`
          : story.status === 'failed'
            ? `That story didn't work out: ${story.error}. Want me to try again?`
            : `Still working on it: ${story.progress.step.toLowerCase()}.`;
      return reply(say, { storyId: story.id, status: story.status, title: story.title, step: story.progress.step }, { view: 'studio', story: studioData(story, kid) });
    },
  );

  registerAppTool(
    server,
    'open_storybook',
    {
      title: 'Open the storybook',
      description:
        'Open a bedtime story to read now: tonight\'s newest story by default ("read my bedtime story", "start the story", "continue the story"), ' +
        'or a specific earlier one by story_id from story_library. On screens the storybook narrates each page aloud itself with highlighted words, ' +
        'so do not read page text over it; on voice-only devices read the returned page text.',
      inputSchema: z.object({
        story_id: z.string().optional().describe('Omit for the newest ready story.'),
        hero: z.string().max(40).optional(),
        start_over: z.boolean().optional().describe('true to begin again from page 1; otherwise resume where reading stopped.'),
      }),
      annotations: { readOnlyHint: false, openWorldHint: false },
      _meta: uiMeta(),
    },
    async ({ story_id, hero, start_over }) => {
      const { story, child, problem } = resolveStory(familyId, story_id, hero);
      if (!story || !child) return fail(problem!);
      const finished = stepAt(story, story.playback.pageIndex).kind === 'end';
      if (start_over || finished) story.playback = { pageIndex: 0, wordsExplored: [], pagesHeard: 0 };
      story.playback.startedAt ??= new Date().toISOString();
      store.putStory(story);
      const pos = story.playback.pageIndex;
      const step = describeStep(story, child, pos);
      return reply(
        `“${story.title}”. ${step.say}`,
        { storyId: story.id, title: story.title, hero: child.name, position: pos, narratedOnScreen: true, ...step.facts },
        { view: 'storybook', story: bookData(story, child), position: pos },
        { invoking: 'Opening the storybook…', invoked: story.title ?? 'Storybook' },
      );
    },
  );

  registerAppTool(
    server,
    'turn_page',
    {
      title: 'Turn the page',
      description: 'Move through the open story: "next page", "go back", "read that again", "start from the beginning".',
      inputSchema: z.object({
        story_id: z.string().optional(),
        direction: z.enum(['next', 'previous', 'again', 'first']).describe('next = forward, previous = back, again = repeat this page, first = page 1'),
      }),
      annotations: { readOnlyHint: false, openWorldHint: false },
      _meta: uiMeta(['model', 'app']),
    },
    async ({ story_id, direction }) => {
      const { story, child, problem } = resolveStory(familyId, story_id);
      if (!story || !child) return fail(problem!);
      const cur = story.playback.pageIndex;
      const k = story.pages.length;
      let pos = direction === 'next' ? cur + 1 : direction === 'previous' ? Math.max(0, cur - 1) : direction === 'first' ? 0 : cur;
      if (pos > k && !story.playback.branch) pos = k; // can't pass the choice until one is made
      if (stepAt(story, pos).kind === 'end') story.playback.finishedAt ??= new Date().toISOString();
      story.playback.pageIndex = pos;
      story.playback.pagesHeard = Math.max(story.playback.pagesHeard, Math.min(pos, k + (story.playback.branch ? 99 : 0)));
      store.putStory(story);
      const step = describeStep(story, child, pos);
      return reply(step.say, { storyId: story.id, position: pos, narratedOnScreen: true, ...step.facts }, { view: 'storybook', story: bookData(story, child), position: pos });
    },
  );

  registerAppTool(
    server,
    'choose_path',
    {
      title: 'Choose what happens next',
      description:
        'At the story\'s choice point, pick which way the story goes, using the child\'s words ("the castle!", "the first one", "follow the fish").',
      inputSchema: z.object({
        story_id: z.string().optional(),
        choice: z.string().min(1).max(80).describe('The option label, part of it, or "first"/"second".'),
      }),
      annotations: { readOnlyHint: false, openWorldHint: false },
      _meta: uiMeta(['model', 'app']),
    },
    async ({ story_id, choice }) => {
      const { story, child, problem } = resolveStory(familyId, story_id);
      if (!story || !child || !story.choice) return fail(problem ?? 'This story has no choice to make.');
      const [a, b] = story.choice.options;
      const c = choice.toLowerCase();
      const words = (s: string) => s.toLowerCase().split(/\W+/).filter((w) => w.length > 2);
      const score = (o: typeof a) => words(o.label).filter((w) => c.includes(w)).length;
      const picked =
        c === 'a' || /\b(first|one|1|left)\b/.test(c) ? a : c === 'b' || /\b(second|two|2|right|other)\b/.test(c) ? b : score(a) >= score(b) && score(a) > 0 ? a : score(b) > 0 ? b : undefined;
      if (!picked) return reply(`${story.choice.question} Say “${a.label}” or “${b.label}”.`, { awaitingChoice: true, options: [a.label, b.label] });
      story.playback.branch = picked.id;
      story.playback.pageIndex = story.pages.length + 1;
      store.putStory(story);
      const fresh = store.getChild(child.id)!;
      const ep = fresh.world.episodes.find((e) => e.storyId === story.id);
      if (ep) {
        ep.choiceMade = picked.label;
        store.updateChild(fresh);
      }
      const step = describeStep(story, child, story.playback.pageIndex);
      return reply(
        `${picked.label}! ${step.say}`,
        { storyId: story.id, chose: picked.label, position: story.playback.pageIndex, narratedOnScreen: true, ...step.facts },
        { view: 'storybook', story: bookData(story, child), position: story.playback.pageIndex },
      );
    },
  );

  registerAppTool(
    server,
    'explain_word',
    {
      title: 'What does that word mean?',
      description: 'Explain a word from the story in a kid-friendly way ("what does brave mean?", "what\'s the word of the night?").',
      inputSchema: z.object({ story_id: z.string().optional(), word: z.string().max(40).optional().describe('Defaults to the word of the night.') }),
      annotations: { readOnlyHint: false, openWorldHint: false },
      _meta: uiMeta(['model', 'app']),
    },
    async ({ story_id, word }) => {
      const { story, child, problem } = resolveStory(familyId, story_id);
      if (!story || !child) return fail(problem!);
      const w = story.wordOfTheNight;
      if (!w) return fail("This story doesn't have a word of the night.");
      const asked = (word ?? w.word).toLowerCase();
      if (!story.playback.wordsExplored.includes(asked)) story.playback.wordsExplored.push(asked);
      store.putStory(story);
      if (asked !== w.word.toLowerCase()) {
        return reply(`Tonight's special word is “${w.word}”, but I can explain “${word}” in my own words.`, { word: asked, wordOfTheNight: w.word, explainYourself: true });
      }
      return reply(`“${w.word}”: ${w.meaning} For example: ${w.example}`, { word: w.word, meaning: w.meaning, example: w.example, audioUrl: rebaseMediaUrl(w.audioUrl) });
    },
  );

  registerAppTool(
    server,
    'story_library',
    {
      title: 'Story library',
      description: 'List earlier bedtime stories so the family can re-read a favourite ("what stories do we have?", "read the dragon story again").',
      inputSchema: z.object({ hero: z.string().max(40).optional() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: uiMeta(),
    },
    async ({ hero }) => {
      const child = store.resolveChild(familyId, hero);
      if (!child) return fail('No story hero is set up yet.');
      const stories = store.storiesFor(child.id).filter((s) => s.status === 'ready').slice(0, 5);
      if (!stories.length) return reply(`There are no stories for ${child.name} yet.`, { stories: [] });
      return reply(
        `${child.name} has ${stories.length} ${stories.length === 1 ? 'story' : 'stories'}: ${stories.map((s) => s.title).join('; ')}.`,
        { hero: child.name, stories: stories.map((s) => ({ storyId: s.id, title: s.title, date: s.createdAt.slice(0, 10) })) },
        { view: 'library', hero: child.name, stories: stories.map(libraryItem) },
      );
    },
  );

  registerAppTool(
    server,
    'bedtime_recap',
    {
      title: 'Bedtime recap',
      description: 'For parents: how last night\'s story went ("how did bedtime go?", "what did Maya choose?", "did she finish the story?").',
      inputSchema: z.object({ hero: z.string().max(40).optional() }),
      annotations: { readOnlyHint: true, openWorldHint: false },
      _meta: uiMeta(),
    },
    async ({ hero }) => {
      const child = store.resolveChild(familyId, hero);
      if (!child) return fail('No story hero is set up yet.');
      const story = store.storiesFor(child.id).find((s) => s.status === 'ready' && s.playback.startedAt);
      if (!story) return reply(`${child.name} hasn't read a story yet.`, { read: false });
      const r = recapData(story, child);
      const parts = [
        `Last story: “${r.title}”.`,
        r.finished ? `${child.name} listened all the way to the end.` : `${child.name} heard ${r.pagesHeard} of ${r.totalPages} pages.`,
        r.choiceMade ? `At the big moment, ${child.name} chose “${r.choiceMade}”.` : '',
        r.wordsExplored.length ? `Word of the night: “${r.wordOfTheNight}”, and ${child.name} asked about it.` : r.wordOfTheNight ? `Word of the night: “${r.wordOfTheNight}”.` : '',
      ];
      return reply(parts.filter(Boolean).join(' '), r, { view: 'recap', recap: r });
    },
  );

  registerAppTool(
    server,
    'update_story_world',
    {
      title: 'Update the story world',
      description:
        'For parents: change what stories include for a child: add a favourite thing, add a topic to never mention, rename the sidekick, ' +
        'or add a recurring character (e.g. "add Grandma Rose to the stories", "never mention thunderstorms", "Maya loves trains now").',
      inputSchema: z.object({
        hero: z.string().max(40).optional(),
        add_favorite: z.string().max(60).optional(),
        add_avoid_topic: z.string().max(60).optional(),
        remove_avoid_topic: z.string().max(60).optional(),
        add_character_name: z.string().max(40).optional(),
        add_character_description: z.string().max(200).optional().describe('What the new character looks like and is like.'),
        rename_sidekick: z.string().max(40).optional(),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: uiMeta(),
    },
    async (a) => {
      const child = store.resolveChild(familyId, a.hero);
      if (!child) return fail('No story hero is set up yet.');
      const changes: string[] = [];
      if (a.add_favorite && !child.favoriteThings.includes(a.add_favorite)) {
        child.favoriteThings.push(a.add_favorite);
        changes.push(`added ${a.add_favorite} to favourite things`);
      }
      if (a.add_avoid_topic && !child.avoid.includes(a.add_avoid_topic)) {
        child.avoid.push(a.add_avoid_topic);
        changes.push(`stories will never mention ${a.add_avoid_topic}`);
      }
      if (a.remove_avoid_topic) {
        child.avoid = child.avoid.filter((t) => t.toLowerCase() !== a.remove_avoid_topic!.toLowerCase());
        changes.push(`${a.remove_avoid_topic} is allowed again`);
      }
      if (a.add_character_name) {
        child.world.recurringCharacters.push({ name: a.add_character_name, description: a.add_character_description ?? `${a.add_character_name}, a kind friend` });
        changes.push(`${a.add_character_name} will appear in future stories`);
      }
      if (a.rename_sidekick) {
        changes.push(`${child.world.sidekick.name} is now called ${a.rename_sidekick}`);
        child.world.sidekick.name = a.rename_sidekick;
      }
      store.updateChild(child);
      const say = changes.length ? `Done: ${changes.join('; ')}.` : `Here's ${child.name}'s story world. Nothing was changed.`;
      return reply(say, { hero: child.name, changes }, { view: 'world', hero: heroData(child) });
    },
  );

  server.registerTool(
    'forget_story_world',
    {
      title: 'Forget story history',
      description:
        "For parents: permanently delete a child's stories, illustrations and story memories. Only call with confirm=true after the parent has clearly confirmed.",
      inputSchema: z.object({ hero: z.string().max(40).optional(), confirm: z.boolean().describe('Must be true; ask the parent to confirm first.') }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ hero, confirm }) => {
      const child = store.resolveChild(familyId, hero);
      if (!child) return fail('No story hero is set up yet.');
      if (!confirm) return reply(`This will delete all of ${child.name}'s stories and story memories. Are you sure?`, { needsConfirmation: true });
      const n = store.deleteStoriesFor(child.id);
      child.world.episodes = [];
      child.world.recurringCharacters = [];
      store.updateChild(child);
      return reply(`Done. I deleted ${n} ${n === 1 ? 'story' : 'stories'} and ${child.name}'s story memories.`, { deleted: n });
    },
  );

  registerAppTool(
    server,
    'log_reading_progress',
    {
      title: 'Log reading progress',
      description: 'Used by the storybook view to record which page is showing and which words were explored.',
      inputSchema: z.object({
        story_id: z.string(),
        position: z.number().int().min(0),
        word_explored: z.string().max(40).optional(),
      }),
      annotations: { readOnlyHint: false, openWorldHint: false },
      _meta: uiMeta(['app']),
    },
    async ({ story_id, position, word_explored }) => {
      const story = store.getStory(story_id);
      if (!story || story.familyId !== familyId) return fail('Unknown story');
      story.playback.pageIndex = position;
      story.playback.pagesHeard = Math.max(story.playback.pagesHeard, position);
      if (word_explored && !story.playback.wordsExplored.includes(word_explored.toLowerCase())) story.playback.wordsExplored.push(word_explored.toLowerCase());
      if (stepAt(story, position).kind === 'end') story.playback.finishedAt ??= new Date().toISOString();
      store.putStory(story);
      return { content: [{ type: 'text' as const, text: 'ok' }] };
    },
  );

  return server;
}
