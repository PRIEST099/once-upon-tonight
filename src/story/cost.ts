import { AsyncLocalStorage } from 'node:async_hooks';
import type { Story } from '../types.js';

export interface Price {
  label: string;
  /** How many units `usd` buys. */
  per: number;
  usd: number;
}

/**
 * List prices used to estimate what one story costs to make, in USD.
 *
 * ESTIMATES ONLY, read off the public on-demand price pages on 2026-10-21 (us-east-1; images in
 * us-west-2). Verify current pricing before quoting them anywhere: they ignore free tiers, volume
 * tiers, discounts and tax, and prices change.
 */
export const PRICES = {
  // Claude on Amazon Bedrock, per 1M tokens, at the global cross-region rate (see GEO_PREMIUM).
  sonnetInput: { label: 'Claude Sonnet 4.6 · input tokens', per: 1_000_000, usd: 3 },
  sonnetOutput: { label: 'Claude Sonnet 4.6 · output tokens', per: 1_000_000, usd: 15 },
  haikuInput: { label: 'Claude Haiku 4.5 · input tokens', per: 1_000_000, usd: 1 },
  haikuOutput: { label: 'Claude Haiku 4.5 · output tokens', per: 1_000_000, usd: 5 },
  // A text unit is up to 1,000 characters. Content filters and denied topics are each billed per
  // unit checked; the profanity word list is free.
  guardrail: { label: 'Bedrock Guardrails · text units', per: 1000, usd: 0.15 },
  image: { label: 'Stability SD3.5 Large · images', per: 1, usd: 0.08 },
  // Polly bills every character sent, so the speech-marks request costs as much as the audio.
  polly: {
    neural: { label: 'Amazon Polly neural · characters', per: 1_000_000, usd: 16 },
    standard: { label: 'Amazon Polly standard · characters', per: 1_000_000, usd: 4 },
    generative: { label: 'Amazon Polly generative · characters', per: 1_000_000, usd: 30 },
    'long-form': { label: 'Amazon Polly long-form · characters', per: 1_000_000, usd: 100 },
  } as Record<string, Price>,
  rekognition: { label: 'Rekognition moderation · images', per: 1, usd: 0.001 },
} satisfies Record<string, Price | Record<string, Price>>;

/** Geo inference profiles (our default "us." model ids) are listed 10% above the global rate. */
const GEO_PREMIUM = 1.1;

export type CostSummary = NonNullable<Story['cost']>;

/** Adds up one story's usage, one line per priced item. */
export class CostMeter {
  private lines = new Map<string, { price: Price; qty: number }>();

  add(price: Price, qty: number) {
    const line = this.lines.get(price.label) ?? { price, qty: 0 };
    line.qty += qty;
    this.lines.set(price.label, line);
  }

  summary(): CostSummary {
    const items = [...this.lines.values()].map(({ price, qty }) => ({ label: price.label, qty, usd: round((qty / price.per) * price.usd) }));
    return { usd: round(items.reduce((sum, i) => sum + i.usd, 0)), items };
  }
}

const round = (usd: number) => Math.round(usd * 100_000) / 100_000;

// The pipeline runs each story inside `metered(...)`; every AWS call made inside it, however deep,
// reports its usage with `record(...)` without a meter being threaded through every signature.
const meters = new AsyncLocalStorage<CostMeter>();

export const metered = <T>(meter: CostMeter, fn: () => Promise<T>) => meters.run(meter, fn);

/** Report usage to the current story's meter (a no-op outside a metered run, e.g. in scripts). */
export function record(price: Price, qty: number | undefined) {
  if (qty) meters.getStore()?.add(price, qty);
}

/** Converse usage → token lines for whichever Claude model answered (Haiku, else Sonnet rates). */
export function recordTokens(modelId: string, usage?: { inputTokens?: number; outputTokens?: number }) {
  const haiku = /haiku/i.test(modelId);
  const k = modelId.startsWith('global.') ? 1 : GEO_PREMIUM;
  const priced = (p: Price): Price => ({ ...p, usd: p.usd * k });
  record(priced(haiku ? PRICES.haikuInput : PRICES.sonnetInput), usage?.inputTokens);
  record(priced(haiku ? PRICES.haikuOutput : PRICES.sonnetOutput), usage?.outputTokens);
}
