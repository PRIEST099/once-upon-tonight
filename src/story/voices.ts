import { ConverseCommand, type ToolConfiguration } from '@aws-sdk/client-bedrock-runtime';
import { bedrock } from './aws.js';
import { recordTokens } from './cost.js';
import { config } from '../config.js';
import type { Child, Page, VoiceLine } from '../types.js';

/**
 * Character voices: the narrator reads the story, and each character's quoted lines are read in their own
 * Polly voice. Quotes are found by code (so the split is exact); Claude only decides who says each quote
 * and what kind of voice that character has. Anything that doesn't line up falls back to the narrator.
 */

type VoiceType = 'girl' | 'boy' | 'woman' | 'man';
/** Neural Polly voices per kind, in the order they're handed out. The narrator and Alexa's voice are left out. */
const POOLS: Record<VoiceType, string[]> = {
  girl: ['Ivy', 'Kimberly'],
  boy: ['Kevin', 'Justin'],
  woman: ['Ruth', 'Kendra', 'Salli'],
  man: ['Gregory', 'Matthew', 'Joey'],
};

/** Quoted passages in a page, with their character ranges (straight or curly quotes, balanced only). */
export function quotesIn(text: string): { start: number; end: number }[] | null {
  const out: { start: number; end: number }[] = [];
  const re = /“[^“”]*”|"[^"]*"/g;
  for (let m; (m = re.exec(text)); ) out.push({ start: m.index, end: m.index + m[0].length });
  const stray = text.replace(/“[^“”]*”|"[^"]*"/g, '');
  return /["“”]/.test(stray) ? null : out; // unbalanced quotes: don't guess
}

const TOOL: ToolConfiguration = {
  tools: [
    {
      toolSpec: {
        name: 'cast_voices',
        description: 'Say who speaks each quoted passage, and what kind of voice each speaker has.',
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              speakers: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    voice: { type: 'string', enum: ['girl', 'boy', 'woman', 'man'], description: 'Children and small creatures are girl or boy; grown-ups are woman or man.' },
                  },
                  required: ['name', 'voice'],
                },
              },
              pages: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string' },
                    quotes: { type: 'array', items: { type: 'string' }, description: 'The speaker name of each numbered quote on the page, in order. "narrator" if no character says it.' },
                  },
                  required: ['id', 'quotes'],
                },
              },
            },
            required: ['speakers', 'pages'],
          },
        },
      },
    },
  ],
  toolChoice: { tool: { name: 'cast_voices' } },
};

/** Works out each page's voice lines. Returns an empty plan (narrator only) if character voices are off or anything fails. */
export async function castVoices(pages: Page[], child: Child): Promise<Record<string, VoiceLine[]>> {
  if (!config.characterVoices) return {};
  const quoted = pages.map((p) => ({ page: p, quotes: quotesIn(p.text) })).filter((x) => x.quotes && x.quotes.length);
  if (!quoted.length) return {};

  const cast = [
    `${child.name}, the hero: ${child.appearance}`,
    `${child.world.sidekick.name}, the sidekick: ${child.world.sidekick.description}`,
    ...child.world.recurringCharacters.map((c) => `${c.name}: ${c.description}`),
  ];
  const listing = quoted
    .map(({ page, quotes }) => `Page ${page.id}:\n${page.text}\nQuotes on this page:\n${quotes!.map((q, i) => `${i + 1}. ${page.text.slice(q.start, q.end)}`).join('\n')}`)
    .join('\n\n');
  let input: any;
  try {
    const res = await bedrock.send(
      new ConverseCommand({
        modelId: config.reviewModelId,
        system: [{ text: 'You cast voices for a children\'s audiobook. For every quoted passage, name the character who says it, using the names from the cast list exactly. Use "narrator" for quotes nobody in the story speaks (a sign, a song title).' }],
        messages: [{ role: 'user', content: [{ text: `Cast:\n${cast.map((c) => `- ${c}`).join('\n')}\n\n${listing}` }] }],
        toolConfig: TOOL,
        inferenceConfig: { maxTokens: 1500, temperature: 0 },
      }),
    );
    recordTokens(config.reviewModelId, res.usage);
    input = res.output?.message?.content?.find((b) => b.toolUse)?.toolUse?.input;
  } catch (err) {
    console.warn('[voices] casting failed; narrator only', err);
    return {};
  }
  if (!input?.pages) return {};

  // Hand out voices: the hero first, then everyone else in the order they speak; no two characters share one.
  const kinds = new Map<string, VoiceType>((input.speakers ?? []).map((s: any) => [String(s.name).toLowerCase(), s.voice as VoiceType]));
  const used = new Map<VoiceType, number>();
  const voiceOf = new Map<string, string>();
  const assign = (name: string) => {
    const key = name.toLowerCase();
    if (key === 'narrator' || voiceOf.has(key)) return voiceOf.get(key);
    const kind = kinds.get(key);
    const pool = kind && POOLS[kind];
    if (!pool) return undefined;
    const n = used.get(kind!) ?? 0;
    if (n >= pool.length) return undefined;
    used.set(kind!, n + 1);
    voiceOf.set(key, pool[n]);
    return pool[n];
  };
  assign(child.name);
  assign(child.world.sidekick.name);

  const plan: Record<string, VoiceLine[]> = {};
  for (const { page, quotes } of quoted) {
    const said = input.pages.find((p: any) => p.id === page.id)?.quotes;
    if (!Array.isArray(said) || said.length !== quotes!.length) continue; // didn't line up: narrator only
    const lines: VoiceLine[] = [];
    let at = 0;
    quotes!.forEach((q, i) => {
      const voice = assign(String(said[i] ?? 'narrator'));
      if (!voice) return; // narrator reads this quote
      if (q.start > at) lines.push({ start: at, end: q.start, speaker: 'narrator', voice: config.narratorVoice });
      lines.push({ start: q.start, end: q.end, speaker: String(said[i]), voice });
      at = q.end;
    });
    if (!lines.length) continue;
    if (at < page.text.length) lines.push({ start: at, end: page.text.length, speaker: 'narrator', voice: config.narratorVoice });
    plan[page.id] = lines;
  }
  return plan;
}
