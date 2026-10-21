import { InvokeModelCommand } from '@aws-sdk/client-bedrock-runtime';
import { bedrockImages } from './aws.js';
import { PRICES, record } from './cost.js';
import { config } from '../config.js';
import type { Character } from '../types.js';

export const ILLUSTRATION_STYLE =
  "Watercolor children's picture book illustration, soft and cozy, gentle rounded shapes, indigo night and warm gold light";

const NEGATIVE =
  'text, letters, words, captions, watermark, signature, logo, scary, menacing, dark horror, sharp teeth, weapons, blood, photorealistic, extra limbs, distorted face';

/** The visual part of a character description (before any personality notes after ';'). */
const look = (c: Character) => c.description.split(';')[0].trim();

/**
 * Build one illustration prompt. Image models have no character memory and don't know who "Pip"
 * is, so each character's look is spliced in right where their name first appears in the scene,
 * then repeated as a cast list; a per-story seed keeps the style consistent from page to page.
 */
export function illustrationPrompt(scene: string, inScene: string[], cast: Character[]) {
  const present = cast.filter((c) => inScene.some((n) => n.toLowerCase().includes(c.name.toLowerCase()) || c.name.toLowerCase().includes(n.toLowerCase())));
  // Image models read names like "Pip" as "another child" and drop subjects buried mid-sentence.
  // So: describe every character up front, and swap names in the scene for short noun phrases.
  let described = scene;
  for (const c of present) {
    const ref = look(c).split(/ with |,/)[0].trim().replace(/^(a|an) /i, 'the ');
    described = described.replace(new RegExp(`\\b${c.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(['’]s)?\\b`, 'g'), (_m, s) => ref + (s ?? ''));
  }
  const prompt = `${ILLUSTRATION_STYLE}. ${described}`;
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
