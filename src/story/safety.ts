import { ApplyGuardrailCommand } from '@aws-sdk/client-bedrock-runtime';
import { bedrock } from './aws.js';
import { config } from '../config.js';
import type { Child } from '../types.js';

/**
 * Second line of defence after the author prompt: every page is checked with an Amazon Bedrock
 * Guardrail (when GUARDRAIL_ID is set) and against the parent's own "never mention" list.
 */
export async function checkStoryText(child: Child, texts: string[]): Promise<{ ok: boolean; provider: string; notes?: string }> {
  const joined = texts.join('\n');
  const hit = child.avoid.find((topic) => new RegExp(`\\b${escapeRe(topic.replace(/s$/, ''))}s?\\b`, 'i').test(joined));
  if (hit) return { ok: false, provider: 'parent avoid-list', notes: `mentions "${hit}"` };

  if (!config.guardrailId) return { ok: true, provider: 'author prompt + avoid-list' };

  const res = await bedrock.send(
    new ApplyGuardrailCommand({
      guardrailIdentifier: config.guardrailId,
      guardrailVersion: config.guardrailVersion,
      source: 'OUTPUT',
      content: [{ text: { text: joined } }],
    }),
  );
  return res.action === 'GUARDRAIL_INTERVENED'
    ? { ok: false, provider: 'Amazon Bedrock Guardrails', notes: 'content filter intervened' }
    : { ok: true, provider: 'Amazon Bedrock Guardrails' };
}

/** Screen the parent's request before writing (prompt-injection and off-topic protection). */
export async function checkParentInput(text: string): Promise<{ ok: boolean; message?: string }> {
  if (!config.guardrailId) return { ok: true };
  const res = await bedrock.send(
    new ApplyGuardrailCommand({
      guardrailIdentifier: config.guardrailId,
      guardrailVersion: config.guardrailVersion,
      source: 'INPUT',
      content: [{ text: { text } }],
    }),
  );
  return res.action === 'GUARDRAIL_INTERVENED' ? { ok: false, message: res.outputs?.[0]?.text } : { ok: true };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
