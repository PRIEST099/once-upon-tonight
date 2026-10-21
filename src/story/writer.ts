import { ConverseCommand, type ToolInputSchema } from '@aws-sdk/client-bedrock-runtime';
import { bedrock } from './aws.js';
import { recordTokens } from './cost.js';
import { withRetry } from './retry.js';
import { config } from '../config.js';
import type { Child, StoryRequest } from '../types.js';

/** What the author model returns (via a forced tool call, so the shape is guaranteed). */
export interface StoryDraft {
  title: string;
  dedication: string;
  sharedPages: DraftPage[];
  choice: {
    question: string;
    options: { label: string; pages: DraftPage[] }[];
  };
  wordOfTheNight: { word: string; meaning: string; example: string };
  episodeSummary: string;
  newCharacters: { name: string; description: string }[];
  newPlaces: string[];
}

export interface DraftPage {
  text: string;
  scene: string;
  charactersInScene: string[];
}

const pageSchema = {
  type: 'object',
  properties: {
    text: { type: 'string', description: 'The words read aloud on this page.' },
    scene: {
      type: 'string',
      description:
        'A self-contained prompt for an image model, 35–70 words. Describe every character by appearance and NEVER by name (image models think names are extra people), ' +
        'using the exact looks given; say how they are positioned together; then setting, light and mood. Never ask for written words or letters.',
    },
    charactersInScene: { type: 'array', items: { type: 'string' }, description: 'Names of characters visible in the illustration.' },
  },
  required: ['text', 'scene', 'charactersInScene'],
};

const storySchema = {
  type: 'object',
  properties: {
    title: { type: 'string' },
    dedication: { type: 'string', description: 'One short line, e.g. "For Maya, who was brave today."' },
    sharedPages: { type: 'array', items: pageSchema },
    choice: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'A gentle question asking the child to choose what happens next, naming both options.' },
        options: {
          type: 'array',
          minItems: 2,
          maxItems: 2,
          items: {
            type: 'object',
            properties: {
              label: { type: 'string', description: '2–5 words a child can say or tap, e.g. "Follow the glowing fish".' },
              pages: { type: 'array', items: pageSchema },
            },
            required: ['label', 'pages'],
          },
        },
      },
      required: ['question', 'options'],
    },
    wordOfTheNight: {
      type: 'object',
      properties: {
        word: { type: 'string', description: 'One slightly-new word that appears verbatim in the story text.' },
        meaning: { type: 'string', description: 'A one-sentence, kid-friendly meaning.' },
        example: { type: 'string', description: 'A short everyday example sentence using the word.' },
      },
      required: ['word', 'meaning', 'example'],
    },
    episodeSummary: { type: 'string', description: 'Two sentences summarizing this episode, for continuity in future stories.' },
    newCharacters: {
      type: 'array',
      items: {
        type: 'object',
        properties: { name: { type: 'string' }, description: { type: 'string', description: 'Visual description for illustrations.' } },
        required: ['name', 'description'],
      },
    },
    newPlaces: { type: 'array', items: { type: 'string' }, description: 'Imaginary story-world places introduced tonight that could return in later episodes (not real-world places like a school or a pool). Often empty.' },
  },
  required: ['title', 'dedication', 'sharedPages', 'choice', 'wordOfTheNight', 'episodeSummary', 'newCharacters', 'newPlaces'],
};

const levelGuide: Record<Child['readingLevel'], string> = {
  'pre-reader': '1–2 very short sentences per page (under 25 words), simple words, gentle repetition.',
  'early-reader': '2–3 short sentences per page (under 40 words), mostly simple words, one or two new words in the whole story.',
  'independent-reader': '3–4 sentences per page (under 60 words), richer vocabulary, a little dialogue.',
};

export function buildAuthorPrompt(child: Child, req: StoryRequest) {
  const shared = req.length === 'short' ? 2 : 3;
  const branch = req.length === 'short' ? 2 : 3;
  const w = child.world;
  const recent = w.episodes.slice(-3);
  // A new word every night: the series is also a small vocabulary builder.
  const usedWords = [...new Set(w.episodes.map((e) => e.wordOfTheNight).filter(Boolean))].slice(-30);

  const system = `You are the author of "Once Upon Tonight", a nightly bedtime-story series written for one specific child.
Write warm, calm, funny-in-a-gentle-way stories that a parent would be glad to have read to their child at bedtime.

Rules:
- ${child.name} is the hero. ${w.sidekick.name} (${w.sidekick.description}) is always by ${child.name}'s side.
- Weave in what happened today naturally and kindly. If ${child.name} is worried about something, never dismiss the feeling: let the story model a small, concrete coping idea (a slow breath, asking for help, a brave first step) and let the worry shrink.
- No villains, peril, injuries, or anything frightening. No brand names, screens, or real-world dangers. Never mention: ${child.avoid.join(', ') || 'n/a'}.
- Reading level (${child.readingLevel}, age ${child.age}): ${levelGuide[child.readingLevel]}
- Structure: exactly ${shared} shared pages, then a choice between two different, equally lovely paths, then exactly ${branch} pages for each path. Both paths must end well.
- The last page of each path is a wind-down: slower, sleepy imagery (quiet, warm, cozy), ending by saying goodnight to ${child.name} by name.
- Use the word of the night verbatim exactly once in the shared pages.${usedWords.length ? ` Pick a new word: not ${usedWords.map((x) => `"${x}"`).join(', ')}.` : ''}
- Continuity: this is one episode in an ongoing series. ${recent.length ? 'Briefly and naturally call back to one earlier episode.' : 'This is the first episode.'}
Return the story only by calling the write_story tool.`;

  const user = `Tonight's story for ${child.name} (age ${child.age}).
What happened today / what's on their mind: ${req.todaysMoments}
${req.theme ? `Theme the parent asked for: ${req.theme}` : ''}
How to describe characters in illustration prompts (use these looks, never names):
- ${child.name}: ${child.appearance}
- ${w.sidekick.name}: ${w.sidekick.description.split(';')[0]}
${w.recurringCharacters.map((c) => `- ${c.name}: ${c.description}`).join('\n')}
${child.name} loves: ${child.favoriteThings.join(', ')}.
Recurring places: ${w.places.join(', ') || 'none yet'}.
Recurring characters: ${w.recurringCharacters.map((c) => `${c.name} — ${c.description}`).join('; ') || 'none yet'}.
Earlier episodes:
${recent.map((e) => `- ${e.date}: "${e.title}" — ${e.summary}${e.choiceMade ? ` (${child.name} chose: ${e.choiceMade})` : ''}`).join('\n') || '- none'}`;

  return { system, user };
}

/** Models occasionally return nested tool-input fields as JSON strings; normalize them. */
function unstring<T>(v: T | string): T {
  if (typeof v !== 'string') return v;
  try {
    return JSON.parse(v) as T;
  } catch {
    return v as unknown as T;
  }
}

/** A malformed draft gets one more try; a throttled one waits and tries again. */
export function writeStory(child: Child, req: StoryRequest): Promise<StoryDraft> {
  return withRetry(() => writeOnce(child, req));
}

async function writeOnce(child: Child, req: StoryRequest): Promise<StoryDraft> {
  const { system, user } = buildAuthorPrompt(child, req);
  const res = await bedrock.send(
    new ConverseCommand({
      modelId: config.textModelId,
      system: [{ text: system }],
      messages: [{ role: 'user', content: [{ text: user }] }],
      inferenceConfig: { maxTokens: 8000, temperature: 0.8 },
      toolConfig: {
        tools: [
          {
            toolSpec: {
              name: 'write_story',
              description: 'Deliver the finished bedtime story.',
              inputSchema: { json: storySchema } as ToolInputSchema,
            },
          },
        ],
        toolChoice: { tool: { name: 'write_story' } },
      },
    }),
  );
  recordTokens(config.textModelId, res.usage);
  const toolUse = res.output?.message?.content?.find((c) => c.toolUse)?.toolUse;
  if (!toolUse?.input) throw new Error('The author model did not return a story');
  const draft = toolUse.input as unknown as StoryDraft;
  draft.sharedPages = unstring(draft.sharedPages);
  draft.choice = unstring(draft.choice);
  if (typeof draft.choice === 'string' || typeof draft.sharedPages === 'string') {
    // Seen with deep schemas: a nested object arrives as a JSON string with unescaped quotes.
    throw new Error('The author returned a nested field as malformed JSON');
  }
  if (draft.choice) draft.choice.options = unstring(draft.choice.options)?.map((o) => ({ ...o, pages: unstring(o.pages) }));
  draft.wordOfTheNight = unstring(draft.wordOfTheNight);
  draft.newCharacters = unstring(draft.newCharacters) ?? [];
  draft.newPlaces = unstring(draft.newPlaces) ?? [];
  if (!Array.isArray(draft.sharedPages) || !draft.sharedPages.length || draft.choice?.options?.length !== 2) {
    throw new Error(`Story came back incomplete (stopReason=${res.stopReason}, keys=${Object.keys(draft).join(',')})`);
  }
  return draft;
}
