import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/server';
import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from '@modelcontextprotocol/ext-apps/server';
import { config } from './config.js';
import * as store from './store.js';
import { createStory } from './story/pipeline.js';
import { rebaseMediaUrl } from './media.js';
import type { Child, Page, ReadingLevel, Story } from './types.js';

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

/** Cost guard: new stories a family can start per rolling 24 h (re-reading is always free). */
const MAX_STORIES_PER_DAY = Number(process.env.MAX_STORIES_PER_DAY) > 0 ? Math.floor(Number(process.env.MAX_STORIES_PER_DAY)) : 5;
const DAY_MS = 24 * 60 * 60_000;
/** A repeat of the same request within this window returns the story already made from it. */
const SAME_REQUEST_MS = 10 * 60_000;
/** A pipeline still "in progress" after this long died with a restart; don't let it block new stories. */
const STALE_PIPELINE_MS = 15 * 60_000;
const normalizeMoments = (t: string) =>
  t
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

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
    cost: s.cost,
    generationMs: s.generationMs,
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
  if (!s.choice) return { kind: 'end' };
  if (pos === k) return { kind: 'choice' };
  if (!branch) return { kind: 'choice' };
  if (pos - k - 1 < branch.pages.length) return { kind: 'page', page: branch.pages[pos - k - 1], number: pos, total };
  return { kind: 'end' };
}

const choicePrompt = (s: Story) => `${s.choice!.question} Say “${s.choice!.options[0].label}” or “${s.choice!.options[1].label}”.`;
const choiceFacts = (s: Story) => ({ awaitingChoice: true, question: s.choice!.question, options: s.choice!.options.map((o) => o.label) });

/** Screen mode: the storybook narrates the page itself, so say only a short cue; the page text stays in the facts. */
function describeStep(s: Story, child: Child, pos: number) {
  const step = stepAt(s, pos);
  if (step.kind === 'page') return { say: `Page ${step.number}.`, facts: { page: step.number, of: step.total, text: step.page.text } };
  if (step.kind === 'choice') return { say: choicePrompt(s), facts: choiceFacts(s) };
  return { say: `The end. Goodnight, ${child.name}.`, facts: { finished: true } };
}

// ---- voice-first reading (devices without a screen) ---------------------------------------------
// The reply itself reads the story: consecutive pages up to ~120 words, stopping early at the choice
// or the end, then one short cue. playback.pageIndex then points at the first page not yet read.

const VOICE_WORDS = 120;
const readModeInput = z
  .enum(['screen', 'voice'])
  .optional()
  .describe(
    "'screen' (default): the device shows the storybook, which narrates every page itself, so say only the short cue returned. " +
      "'voice': the device has no screen; the returned text reads the next pages aloud and ends with a short question.",
  );

/** Where the most recent voice chunk that read any pages began, per story, so "read that again" repeats all of it. */
const voiceChunkStart = new Map<string, { from: number; onePage: boolean }>();

const wordCount = (t: string) => t.split(/\s+/).filter(Boolean).length;

function readAloud(s: Story, child: Child, from: number, onePage = false) {
  const texts: string[] = [];
  const pages: number[] = [];
  let words = 0;
  let pos = from;
  let cue: { say: string; facts: Record<string, unknown> };
  for (;;) {
    const step = stepAt(s, pos);
    if (step.kind === 'page') {
      const n = wordCount(step.page.text);
      if (texts.length && (onePage || words + n > VOICE_WORDS)) {
        cue = { say: 'Shall I keep going?', facts: { more: true } };
        break;
      }
      texts.push(step.page.text);
      pages.push(step.number);
      words += n;
      pos++;
    } else if (step.kind === 'choice' && s.playback.branch) {
      pos++; // already chosen: carry straight on down that path
    } else {
      cue = step.kind === 'choice' ? { say: choicePrompt(s), facts: choiceFacts(s) } : { say: `The end. Goodnight, ${child.name}.`, facts: { finished: true } };
      break;
    }
  }
  const branch = s.choice?.options.find((o) => o.id === s.playback.branch) ?? s.choice?.options[0];
  return {
    say: [...texts, cue.say].join(' '),
    next: pos,
    pages,
    facts: { readMode: 'voice', narratedOnScreen: false, pagesRead: pages, of: s.pages.length + (branch?.pages.length ?? 0), ...cue.facts },
  };
}

/** Read a voice chunk starting at `from` and move the reading position past it. */
function voiceRead(s: Story, child: Child, from: number, onePage = false) {
  const r = readAloud(s, child, from, onePage);
  const k = s.pages.length;
  if (r.pages.length) voiceChunkStart.set(s.id, { from, onePage }); // a bare re-ask ("Shall I…", the question) isn't a chunk
  s.playback.pageIndex = r.next;
  s.playback.pagesHeard = Math.max(s.playback.pagesHeard, r.next > k ? r.next - 1 : r.next);
  if (stepAt(s, r.next).kind === 'end') s.playback.finishedAt ??= new Date().toISOString();
  store.putStory(s);
  return r;
}

/** The page before `pos` for "go back", stepping over a choice that has already been made. */
function pageBefore(s: Story, pos: number) {
  const k = s.pages.length;
  const p = pos - 1 === k && s.playback.branch ? k - 1 : pos - 1;
  return Math.max(0, p);
}

// ---- choice resolution -------------------------------------------------------------------------
// Order: explicit option_number → words matching a label → ordinal words → ask again. A bare "one"
// never counts as "first" ("the pillow fort one", "the other one").

const CHOICE_FILLER = new Set(['the', 'a', 'an', 'to', 'in', 'of', 'and', 'one', 'lets', 'let', 'go', 'i', 'want', 'please', 'do', 'on', 'at', 'with', 'it', 'that', 'this', 'we', 'is', 'pick', 'choose']);
const choiceWords = (t: string) =>
  t
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
const sameWord = (x: string, y: string) =>
  x === y || x === `${y}s` || y === `${x}s` || (Math.min(x.length, y.length) >= 4 && (x.startsWith(y) || y.startsWith(x)));

/** Map the child's words (or an explicit 1/2) to option index 0 or 1; undefined means ask again. */
export function resolveChoice(labels: [string, string], choice = '', optionNumber?: number): 0 | 1 | undefined {
  if (optionNumber === 1 || optionNumber === 2) return optionNumber === 1 ? 0 : 1;
  const raw = choiceWords(choice);
  const said = raw.filter((w) => !CHOICE_FILLER.has(w));
  // A lone position word ("first", "the second one") means a position, even if a label contains it.
  if (said.length === 1 && /^(first|1|left)$/.test(said[0])) return 0;
  if (said.length === 1 && /^(second|2|two|other|last|right)$/.test(said[0])) return 1;
  const pick = (i: 0 | 1, _alone: boolean): 0 | 1 => i;

  // Label words: more matching words wins; on a tie, a label the child said in full beats one they only touched.
  const match = labels.map((label) => {
    const want = [...new Set(choiceWords(label).filter((w) => !CHOICE_FILLER.has(w)))];
    const hits = want.filter((w) => said.some((s) => sameWord(s, w))).length;
    return { hits, full: hits > 0 && hits === want.length };
  });
  const [a, b] = match;
  if (a.hits !== b.hits) return pick(a.hits > b.hits ? 0 : 1, Math.min(a.hits, b.hits) === 0);
  if (a.hits && a.full !== b.full) return a.full ? 0 : 1;

  // Ordinals; if both kinds are said ("not the first, the second"), the last one mentioned wins.
  const text = ` ${raw.join(' ')} `;
  const lastAt = (re: RegExp) => Math.max(-1, ...[...text.matchAll(re)].map((m) => m.index!));
  const first = Math.max(lastAt(/ (first|1|left)(?= )/g), lastAt(/ (option|choice|number|path|plan) (one|a)(?= )/g), text === ' a ' ? 0 : -1);
  const second = lastAt(/ (second|two|2|other|last|right|b)(?= )/g);
  if (first < 0 && second < 0) return undefined;
  return pick(second > first ? 1 : 0, first < 0 || second < 0);
}

// ---- forget_story_world confirmation (server-enforced, not just a model promise) -----------------

const FORGET_TTL_MS = 5 * 60_000;
const forgetTokens = new Map<string, { familyId: string; childId: string; expiresAt: number }>();

function issueForgetToken(familyId: string, childId: string) {
  const now = Date.now();
  for (const [t, v] of forgetTokens) if (v.expiresAt <= now || (v.familyId === familyId && v.childId === childId)) forgetTokens.delete(t);
  const token = randomBytes(12).toString('base64url');
  forgetTokens.set(token, { familyId, childId, expiresAt: now + FORGET_TTL_MS });
  return token;
}

/** Single use: a token is spent whether or not it matches. */
function redeemForgetToken(token: string | undefined, familyId: string, childId: string) {
  const t = token ? forgetTokens.get(token) : undefined;
  if (!t) return false;
  forgetTokens.delete(token!);
  return t.familyId === familyId && t.childId === childId && t.expiresAt > Date.now();
}

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
const READING_LEVEL_SAY: Record<ReadingLevel, string> = { 'pre-reader': 'a pre-reader', 'early-reader': 'an early reader', 'independent-reader': 'an independent reader' };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
function listOf(items: string[], max = 3) {
  const shown = items.slice(0, max);
  if (items.length > max) shown.push(`${items.length - max} more`);
  return shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}` : (shown[0] ?? '');
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
  // The linked family's story heroes are already known, so the assistant never has to ask who "her" is.
  const kids = store.childrenOf(familyId);
  const heroes = kids.length
    ? ` This family's story ${kids.length === 1 ? 'hero is' : 'heroes are'} ${kids.map((c) => `${c.name} (age ${c.age})`).join(', ')}. ` +
      (kids.length === 1
        ? `When the parent says "her", "him", "my daughter", "my son" or "my kid", they mean ${kids[0].name}: don't ask for a name, and don't ask for more details before creating a story; use what was said.`
        : `Only ask which child if it isn't clear from what was said.`)
    : '';
  const server = new McpServer(
    { name: 'once-upon-tonight', title: 'Once Upon Tonight', version: '0.1.0' },
    {
      instructions:
        'Once Upon Tonight makes a personalized, illustrated, narrated bedtime story from the day a family just had, then reads it page by page. ' +
        'A parent creates the story (create_tonights_story); at bedtime anyone can open it (open_storybook), turn pages, and choose what happens next. ' +
        'Stories remember earlier nights, so recurring friends and places come back.' +
        heroes,
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
        '"she\'s nervous about the dentist tomorrow". Writing, illustrating and narrating takes a couple of minutes and runs in the background; ' +
        'reply that it will be ready by bedtime. Pass everything the parent said about the day in todays_moments. ' +
        'Safe to repeat: if a story for this child is already being made, or the same request was made in the last few minutes, that story is returned instead of a new one.',
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
      const now = Date.now();
      const age = (s: Story) => now - Date.parse(s.createdAt);
      const studio = { invoking: 'Opening the story studio…', invoked: 'Story studio' };

      // One story at a time per child: a second "make tonight's story" returns the one in the studio.
      const theirs = store.storiesFor(child.id);
      const making = theirs.find((s) => s.status !== 'ready' && s.status !== 'failed' && age(s) < STALE_PIPELINE_MS);
      if (making) {
        const step = making.progress.step.charAt(0).toLowerCase() + making.progress.step.slice(1);
        return reply(
          `I'm already making a story for ${child.name}: ${step}. It will be ready in a couple of minutes.`,
          { storyId: making.id, hero: child.name, status: making.status, alreadyInProgress: true, newStoryStarted: false },
          { view: 'studio', story: studioData(making, child) },
          studio,
        );
      }

      // The same request again (a retry, or the parent repeating themselves) gets the story already made from it.
      const said = normalizeMoments(todays_moments);
      const repeat = theirs.find((s) => s.status !== 'failed' && age(s) < SAME_REQUEST_MS && normalizeMoments(s.request.todaysMoments) === said);
      if (repeat) {
        return reply(
          repeat.status === 'ready'
            ? `I already made that one: “${repeat.title}” is ready whenever ${child.name} is.`
            : `I'm already making that story for ${child.name}. It will be ready in a couple of minutes.`,
          { storyId: repeat.id, hero: child.name, status: repeat.status, title: repeat.title, sameRequest: true, newStoryStarted: false },
          { view: 'studio', story: studioData(repeat, child) },
          studio,
        );
      }

      // Cost guard: live stories call paid models, so cap new ones per family per day. The log survives
      // forget_story_world, and mock mode (the public demo) is free, so it isn't capped.
      const today = config.aiMode === 'mock' ? 0 : store.creationsSince(familyId, DAY_MS);
      if (today >= MAX_STORIES_PER_DAY) {
        const say =
          `That's ${MAX_STORIES_PER_DAY} new stories today, which is the daily limit, so the next new one will have to wait until tomorrow. ` +
          `I can read one of ${child.name}'s stories again instead. Just ask what stories you have.`;
        return reply(
          say,
          { ok: false, limitReached: true, limit: MAX_STORIES_PER_DAY, createdLast24h: today, newStoryStarted: false },
          { view: 'message', title: "That's plenty of stories for today", body: say },
        );
      }

      const story = createStory(child, { todaysMoments: todays_moments, theme, length: length ?? 'standard' });
      if (config.aiMode !== 'mock') store.recordCreation(familyId);
      return reply(
        `I'm making tonight's story for ${child.name} now. It will be ready in a couple of minutes, so it's all set for bedtime.`,
        { storyId: story.id, hero: child.name, status: story.status, readyInSeconds: 150 },
        { view: 'studio', story: studioData(story, child) },
        studio,
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
        'or a specific earlier one by story_id from story_library. ' +
        "On a device with a screen (read_mode 'screen', the default) the storybook narrates every page aloud itself with highlighted words, " +
        'so say only the short cue returned and never read page text over it. ' +
        "On a voice-only device with no screen, pass read_mode 'voice': the returned text reads the next pages aloud and ends with " +
        "\"Shall I keep going?\" (on yes, call turn_page next with read_mode 'voice') or the choice question (then call choose_path).",
      inputSchema: z.object({
        story_id: z.string().optional().describe('Omit for the newest ready story.'),
        hero: z.string().max(40).optional(),
        start_over: z.boolean().optional().describe('true to begin again from page 1; otherwise resume where reading stopped.'),
        read_mode: readModeInput,
      }),
      annotations: { readOnlyHint: false, openWorldHint: false },
      _meta: uiMeta(),
    },
    async ({ story_id, hero, start_over, read_mode }) => {
      const { story, child, problem } = resolveStory(familyId, story_id, hero);
      if (!story || !child) return fail(problem!);
      const finished = stepAt(story, story.playback.pageIndex).kind === 'end';
      // The public demo family is shared by every visitor, so opening the book always starts at page 1 there.
      if (start_over || finished || config.demoMode) {
        story.playback = { pageIndex: 0, wordsExplored: [], pagesHeard: 0 };
        voiceChunkStart.delete(story.id);
      }
      story.playback.startedAt ??= new Date().toISOString();
      store.putStory(story);
      const pos = story.playback.pageIndex;
      const facts = { storyId: story.id, title: story.title, hero: child.name };
      if (read_mode === 'voice') {
        const r = voiceRead(story, child, pos);
        return reply(`“${story.title}”. ${r.say}`, { ...facts, position: r.next, ...r.facts });
      }
      const step = describeStep(story, child, pos);
      return reply(
        pos === 0 ? `“${story.title}”.` : `“${story.title}”. ${step.say}`,
        { ...facts, position: pos, readMode: 'screen', narratedOnScreen: true, ...step.facts },
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
      description:
        'Move through the open story: "next page", "keep going", "go back", "read that again", "start from the beginning". ' +
        "Pass the same read_mode as open_storybook: with 'voice' (no screen) read the returned pages aloud; with a screen say only the short cue.",
      inputSchema: z.object({
        story_id: z.string().optional(),
        direction: z.enum(['next', 'previous', 'again', 'first']).describe('next = forward, previous = back, again = repeat this page, first = page 1'),
        read_mode: readModeInput,
      }),
      annotations: { readOnlyHint: false, openWorldHint: false },
      _meta: uiMeta(['model', 'app']),
    },
    async ({ story_id, direction, read_mode }) => {
      const { story, child, problem } = resolveStory(familyId, story_id);
      if (!story || !child) return fail(problem!);
      const cur = story.playback.pageIndex;
      const k = story.pages.length;
      if (read_mode === 'voice') {
        // cur is the first page not yet read aloud; "again" repeats the whole last chunk when we know where it began.
        const began = voiceChunkStart.get(story.id);
        const last = began && began.from <= cur ? began : undefined;
        const r =
          direction === 'next'
            ? voiceRead(story, child, cur)
            : direction === 'first'
              ? voiceRead(story, child, 0)
              : direction === 'again' && last
                ? voiceRead(story, child, last.from, last.onePage)
                : voiceRead(story, child, pageBefore(story, direction === 'again' ? cur : (last?.from ?? cur)), true);
        return reply(r.say, { storyId: story.id, position: r.next, ...r.facts });
      }
      let pos = direction === 'next' ? cur + 1 : direction === 'previous' ? Math.max(0, cur - 1) : direction === 'first' ? 0 : cur;
      if (pos > k && !story.playback.branch) pos = k; // can't pass the choice until one is made
      if (stepAt(story, pos).kind === 'end') story.playback.finishedAt ??= new Date().toISOString();
      story.playback.pageIndex = pos;
      story.playback.pagesHeard = Math.max(story.playback.pagesHeard, Math.min(pos, k + (story.playback.branch ? 99 : 0)));
      store.putStory(story);
      const step = describeStep(story, child, pos);
      return reply(
        step.say,
        { storyId: story.id, position: pos, readMode: 'screen', narratedOnScreen: true, ...step.facts },
        { view: 'storybook', story: bookData(story, child), position: pos },
      );
    },
  );

  registerAppTool(
    server,
    'choose_path',
    {
      title: 'Choose what happens next',
      description:
        'At the story\'s choice point, pick which way the story goes, passing the child\'s own words as choice ' +
        '("the castle!", "the second one", "the pillow fort one", "follow the fish"). If the words don\'t match an option, the question comes back to ask again. ' +
        'Pass the same read_mode as open_storybook.',
      inputSchema: z.object({
        story_id: z.string().optional(),
        choice: z.string().min(1).max(80).optional().describe('The child\'s words: the option label, part of it, or "first"/"second"/"the other one".'),
        option_number: z
          .number()
          .int()
          .min(1)
          .max(2)
          .optional()
          .describe('1 or 2, only when you are sure which option the child means (1 = the first option offered). Overrides choice.'),
        read_mode: readModeInput,
      }),
      annotations: { readOnlyHint: false, openWorldHint: false },
      _meta: uiMeta(['model', 'app']),
    },
    async ({ story_id, choice, option_number, read_mode }) => {
      const { story, child, problem } = resolveStory(familyId, story_id);
      if (!story || !child || !story.choice) return fail(problem ?? 'This story has no choice to make.');
      const [a, b] = story.choice.options;
      const i = resolveChoice([a.label, b.label], choice, option_number);
      if (i === undefined) return reply(choicePrompt(story), { storyId: story.id, ...choiceFacts(story), understood: false });
      const picked = story.choice.options[i];
      const k = story.pages.length;
      story.playback.branch = picked.id;
      story.playback.pageIndex = k + 1;
      store.putStory(story);
      const fresh = store.getChild(child.id)!;
      const ep = fresh.world.episodes.find((e) => e.storyId === story.id);
      if (ep) {
        ep.choiceMade = picked.label;
        store.updateChild(fresh);
      }
      if (read_mode === 'voice') {
        const r = voiceRead(story, child, k + 1);
        return reply(`${picked.label}! ${r.say}`, { storyId: story.id, chose: picked.label, position: r.next, ...r.facts });
      }
      const step = describeStep(story, child, k + 1);
      return reply(
        `${picked.label}! ${step.say}`,
        { storyId: story.id, chose: picked.label, position: k + 1, readMode: 'screen', narratedOnScreen: true, ...step.facts },
        { view: 'storybook', story: bookData(story, child), position: k + 1 },
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
        'add a recurring character, change the child\'s nickname, age or reading level ' +
        '(e.g. "add Grandma Rose to the stories", "never mention thunderstorms", "Maya loves trains now", "call her Mia in the stories", "Maya just turned six").',
      inputSchema: z.object({
        hero: z.string().max(40).optional(),
        add_favorite: z.string().max(60).optional(),
        add_avoid_topic: z.string().max(60).optional(),
        remove_avoid_topic: z.string().max(60).optional(),
        add_character_name: z.string().max(40).optional(),
        add_character_description: z.string().max(200).optional().describe('What the new character looks like and is like.'),
        rename_sidekick: z.string().max(40).optional(),
        rename_hero: z.string().min(1).max(40).optional().describe("The child's new nickname in the stories."),
        set_age: z.number().int().min(2).max(10).optional().describe("The child's age in years."),
        set_reading_level: z
          .enum(['pre-reader', 'early-reader', 'independent-reader'])
          .optional()
          .describe('How the child reads: pre-reader (listens only), early-reader (sounding out words), independent-reader.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      _meta: uiMeta(),
    },
    async (a) => {
      const child = store.resolveChild(familyId, a.hero);
      if (!child) return fail('No story hero is set up yet.');
      const changes: string[] = [];
      const newName = a.rename_hero?.trim();
      if (newName && newName !== child.name) {
        const taken = store.childrenOf(familyId).some((c) => c.id !== child.id && c.name.toLowerCase() === newName.toLowerCase());
        if (taken) changes.push(`${newName} wasn't used because another story hero already has that name`);
        else {
          changes.push(`${child.name} is now called ${newName}`);
          child.name = newName;
        }
      }
      if (a.set_age && a.set_age !== child.age) {
        // Keep the illustration description in step ("a five-year-old girl…") so pictures age with the child.
        const was = new RegExp(`\\b(${child.age}|${NUMBER_WORDS[child.age] ?? child.age})-year-old\\b`, 'i');
        child.appearance = child.appearance.replace(was, `${NUMBER_WORDS[a.set_age]}-year-old`);
        child.age = a.set_age;
        changes.push(`${child.name} is now ${a.set_age}`);
      }
      if (a.set_reading_level && a.set_reading_level !== child.readingLevel) {
        child.readingLevel = a.set_reading_level;
        changes.push(`stories will be written for ${READING_LEVEL_SAY[a.set_reading_level]}`);
      }
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
        // Asking twice updates the character rather than adding a second Grandma Rose.
        const known = child.world.recurringCharacters.find((c) => c.name.toLowerCase() === a.add_character_name!.toLowerCase());
        if (known) {
          if (a.add_character_description) known.description = a.add_character_description;
          changes.push(`${known.name} is already in the story world${a.add_character_description ? ', with the description updated' : ''}`);
        } else {
          child.world.recurringCharacters.push({ name: a.add_character_name, description: a.add_character_description ?? `${a.add_character_name}, a kind friend` });
          changes.push(`${a.add_character_name} will appear in future stories`);
        }
      }
      if (a.rename_sidekick) {
        changes.push(`${child.world.sidekick.name} is now called ${a.rename_sidekick}`);
        child.world.sidekick.name = a.rename_sidekick;
      }
      store.updateChild(child);
      const say = changes.length ? `Done: ${changes.join('; ')}.` : `Here's ${child.name}'s story world. Nothing was changed.`;
      return reply(say, { hero: child.name, age: child.age, readingLevel: child.readingLevel, changes }, { view: 'world', hero: heroData(child) });
    },
  );

  server.registerTool(
    'forget_story_world',
    {
      title: 'Forget story history',
      description:
        "For parents: permanently delete a child's stories (with their illustrations and narration) and story memories (past story nights, recurring characters, places). " +
        'Two steps, enforced by the server: first call without confirm, read the returned warning to the parent and keep its confirmation_token; ' +
        'only if the parent then clearly says yes, call again with confirm=true and that confirmation_token (single use, valid 5 minutes).',
      inputSchema: z.object({
        hero: z.string().max(40).optional(),
        confirm: z.boolean().optional().describe('true only on the second call, after the parent clearly said yes to the warning.'),
        confirmation_token: z.string().max(64).optional().describe('The confirmation_token returned by the first call.'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    },
    async ({ hero, confirm, confirmation_token }) => {
      const child = store.resolveChild(familyId, hero);
      if (!child) return fail('No story hero is set up yet.');
      const w = child.world;
      const stories = store.storiesFor(child.id).length;
      const characters = w.recurringCharacters.map((c) => c.name);
      const doomed = [
        stories && `${child.name}'s ${plural(stories, 'story', 'stories')} with their pictures and narration`,
        w.episodes.length && `the memories of ${plural(w.episodes.length, 'past story night', 'past story nights')}`,
        characters.length && `${characters.length === 1 ? 'the recurring character' : 'the recurring characters'} ${listOf(characters)}`,
        w.places.length && `${w.places.length === 1 ? 'the story place' : 'the story places'}: ${listOf(w.places)}`,
      ].filter((x): x is string => Boolean(x));
      if (!doomed.length) return reply(`${child.name} has no stories or story memories to delete.`, { hero: child.name, deleted: 0, nothingToDelete: true });
      const what = doomed.length > 1 ? `${doomed.slice(0, -1).join('; ')}; and ${doomed.at(-1)}` : doomed[0];
      const kept = `${w.sidekick.name} the sidekick, ${child.name}'s favourite things and the topics to avoid`;
      const willDelete = { stories, storyNights: w.episodes.length, characters, places: [...w.places] };

      if (confirm === true && redeemForgetToken(confirmation_token, familyId, child.id)) {
        const n = store.deleteStoriesFor(child.id);
        w.episodes = [];
        w.recurringCharacters = [];
        w.places = [];
        store.updateChild(child);
        return reply(`Done. I deleted ${what}. ${kept} are still there.`, {
          hero: child.name,
          deleted: { ...willDelete, stories: n },
          kept: ['sidekick', 'favoriteThings', 'avoid'],
        });
      }

      // Anything else (first call, missing, expired, reused or someone else's token) asks again with a fresh token.
      const token = issueForgetToken(familyId, child.id);
      const again = confirm !== true ? '' : confirmation_token ? 'That confirmation has expired, so nothing has been deleted yet. ' : 'Nothing has been deleted yet. ';
      return reply(`${again}This will permanently delete ${what}. ${kept} will stay. Are you sure?`, {
        hero: child.name,
        needsConfirmation: true,
        confirmation_token: token,
        expiresInSeconds: FORGET_TTL_MS / 1000,
        willDelete,
        willKeep: ['sidekick', 'favoriteThings', 'avoid'],
      });
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
