import { ConverseCommand, InvokeModelCommand, type ToolConfiguration } from '@aws-sdk/client-bedrock-runtime';
import { bedrock, bedrockImages } from './aws.js';
import { PRICES, record, recordTokens } from './cost.js';
import { config } from '../config.js';
import type { Character } from '../types.js';

// No time of day here: the scene says whether it's a sunny morning or a starry night.
export const ILLUSTRATION_STYLE =
  "Watercolor children's picture book illustration, soft and cozy, gentle rounded shapes, warm gentle light";

const NEGATIVE =
  'text, letters, words, captions, watermark, signature, logo, scary, menacing, dark horror, sharp teeth, weapons, blood, photorealistic, extra limbs, distorted face, ' +
  'animal ears on a person, wings on a person, horns on a person, a child with a tail, half-animal child, hybrid creature, merged characters, duplicate characters';

/** The visual part of a character description (before any personality notes after ';'). */
const look = (c: Character) => c.description.split(';')[0].trim();

/** The cast members a page's `charactersInScene` names (matched loosely: "Grandma" finds "Grandma Rose"). */
export const castIn = (inScene: string[], cast: Character[]) =>
  cast.filter((c) => inScene.some((n) => n.toLowerCase().includes(c.name.toLowerCase()) || c.name.toLowerCase().includes(n.toLowerCase())));

/**
 * Build one illustration prompt. Image models have no character memory and don't know who "Pip"
 * is, so each character's look is spliced in right where their name first appears in the scene,
 * then repeated as a cast list; a per-story seed keeps the style consistent from page to page.
 * The first cast member is the hero, always a human child. Image models like to blend a child
 * hugging a fox cub into one fox-eared child, so the cast list keeps them apart in so many words.
 * `fix` is a correction from a picture review, put first so it carries the most weight.
 */
export function illustrationPrompt(scene: string, inScene: string[], cast: Character[], fix?: string) {
  const present = castIn(inScene, cast);
  // Image models read names like "Pip" as "another child" and drop subjects buried mid-sentence.
  // So: describe every character up front, and swap names in the scene for short noun phrases.
  let described = scene;
  for (const c of present) {
    const ref = look(c).split(/ with |,/)[0].trim().replace(/^(a|an) /i, 'the ');
    described = described.replace(new RegExp(`\\b${c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(['’]s)?\\b`, 'g'), (_m, s) => ref + (s ?? ''));
  }
  const castList = present.length > 1
    ? ` ${present.length} separate characters, each drawn once: ${present.map((c, i) => look(c) + (i === 0 && c === cast[0] ? ' (an ordinary human child: human face and ears, no wings, horns or tail)' : '')).join('; ')}.`
    : '';
  const prompt = `${fix ? `${fix}. ` : ''}${ILLUSTRATION_STYLE}. ${described}${castList}`;
  // Nova Canvas caps prompts at 1024 chars; Stability models accept far longer prompts.
  return config.imageModelId.includes('nova') && prompt.length > 1024 ? prompt.slice(0, 1024) : prompt;
}

export async function illustrate(prompt: string, seed: number): Promise<Uint8Array> {
  const isNova = config.imageModelId.includes('nova-canvas');
  const body = isNova
    ? {
        taskType: 'TEXT_IMAGE',
        textToImageParams: { text: prompt, negativeText: NEGATIVE },
        imageGenerationConfig: { numberOfImages: 1, width: 1280, height: 720, cfgScale: 6.5, seed, quality: 'standard' },
      }
    : { prompt, negative_prompt: NEGATIVE, aspect_ratio: '16:9', output_format: 'jpeg', seed };
  const res = await bedrockImages.send(
    new InvokeModelCommand({
      modelId: config.imageModelId,
      contentType: 'application/json',
      accept: 'application/json',
      body: JSON.stringify(body),
    }),
  );
  const out = JSON.parse(new TextDecoder().decode(res.body));
  const filtered = Array.isArray(out.finish_reasons) && out.finish_reasons[0];
  if (out.error || filtered || !out.images?.[0]) throw new Error(out.error ?? filtered ?? 'No image returned');
  record(PRICES.image, 1);
  return Buffer.from(out.images[0], 'base64');
}

const yes = (description: string) => ({ type: 'boolean', description });
const REVIEW: ToolConfiguration = {
  tools: [
    {
      toolSpec: {
        name: 'review_picture',
        description: 'Answer each question about the illustration.',
        inputSchema: {
          json: {
            type: 'object',
            properties: {
              merged: yes('Does any human have animal parts: animal ears, horns, wings, a tail or an animal face?'),
              sharedBody: yes('Do two characters share one body anywhere (one character\'s body flowing into another\'s, a head on someone else\'s body)?'),
              drawnTwice: yes('Does any listed character appear more than once?'),
              heroMissing: yes('Is the hero (the human child) missing?'),
              wrongKind: yes('Is a listed animal drawn as a different kind of animal (a fox where a dog should be)?'),
              writing: yes('Are there any written words or letters?'),
              scary: yes('Is anything scary or upsetting for a small child?'),
              othersMissing: { type: 'array', items: { type: 'string' }, description: 'Names of listed characters (other than the hero) who are not in the picture.' },
              wrongTimeOfDay: yes('Is it clearly night when the text says morning or daytime, or the reverse?'),
              fix: { type: 'string', description: 'If any answer above is yes: one short positive sentence for the painter, e.g. "A human girl with no horns or wings stands beside one small blue dragon".' },
            },
            required: ['merged', 'sharedBody', 'drawnTwice', 'heroMissing', 'wrongKind', 'writing', 'scary', 'othersMissing', 'wrongTimeOfDay'],
          },
        },
      },
    },
  ],
  toolChoice: { tool: { name: 'review_picture' } },
};

/** severity: 2 = repaint (merged, doubled, someone missing, wrong animal, writing, scary), 1 = keep with a note, 0 = good. */
export type PictureReview = { severity: 0 | 1 | 2; problems: string[]; fix?: string };

/**
 * Claude looks at a finished picture next to the page it illustrates, the way an editor would, and catches
 * what image models get wrong: a child merged with their animal friend, a character drawn twice, the wrong
 * kind of animal, written text. It answers fixed questions, so props, poses and clothes never count.
 */
export async function reviewPicture(image: Uint8Array, page: { text: string }, present: Character[], hero: Character): Promise<PictureReview> {
  // Only what kind of being each character is ("a small orange fox cub"), not clothes: those vary and don't matter.
  const who = present.map((c) => `- ${c.name}: ${c === hero ? 'a human child (the hero)' : look(c).split(/ with |,/)[0].trim()}`).join('\n');
  const res = await bedrock.send(
    new ConverseCommand({
      modelId: config.pictureReviewModelId,
      system: [{ text: "You check illustrations for a children's bedtime picture book before a child sees them. Look closely at every figure: count each character, follow each body from head to feet to see where it ends, and check each person's head and back for animal ears, horns, wings or a tail." }],
      messages: [
        {
          role: 'user',
          content: [
            { image: { format: 'jpeg', source: { bytes: image } } },
            { text: `Page text: ${page.text}\n\nCharacters who should be in the picture:\n${who || '- (no named characters)'}` },
          ],
        },
      ],
      toolConfig: REVIEW,
      inferenceConfig: { maxTokens: 400, temperature: 0 },
    }),
  );
  recordTokens(config.pictureReviewModelId, res.usage);
  const a = res.output?.message?.content?.find((b) => b.toolUse)?.toolUse?.input as Record<string, any> | undefined;
  if (!a || typeof a.merged !== 'boolean') throw new Error('The picture review returned nothing');
  const serious = [
    a.merged && 'a person has animal parts',
    a.sharedBody && 'two characters share one body',
    a.drawnTwice && 'a character is drawn twice',
    a.heroMissing && 'the hero is missing',
    a.wrongKind && 'an animal is the wrong kind',
    a.writing && 'written letters',
    a.scary && 'something scary',
    // Often a merge in disguise: the boy wearing the neighbour's headwrap and apron, and no neighbour.
    ...(Array.isArray(a.othersMissing) ? a.othersMissing.map((n: unknown) => `${n} is missing`) : []),
  ].filter(Boolean) as string[];
  const minor = a.wrongTimeOfDay ? ['the time of day is off'] : [];
  return { severity: serious.length ? 2 : minor.length ? 1 : 0, problems: [...serious, ...minor], fix: (serious.length && a.fix?.trim()) || undefined };
}
