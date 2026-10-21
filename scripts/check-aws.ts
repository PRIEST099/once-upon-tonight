/**
 * `npm run check-aws` — verifies this AWS account can call every service the story pipeline uses.
 * Writes a sample illustration to data/check-aws.png.
 */
import fs from 'node:fs';
import { ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { SynthesizeSpeechCommand, type Engine, type VoiceId } from '@aws-sdk/client-polly';
import { config } from '../src/config.js';
import { bedrock, polly } from '../src/story/aws.js';
import { illustrate, ILLUSTRATION_STYLE } from '../src/story/illustrator.js';

const check = async (name: string, fn: () => Promise<string>) => {
  const started = Date.now();
  try {
    console.log(`✅ ${name} (${Date.now() - started}ms): ${await fn()}`);
  } catch (e: any) {
    console.log(`❌ ${name} (${Date.now() - started}ms): ${e.name}: ${String(e.message).slice(0, 240)}`);
  }
};

await Promise.all([
  check(`Bedrock text · ${config.textModelId}`, async () => {
    const r = await bedrock.send(
      new ConverseCommand({
        modelId: config.textModelId,
        messages: [{ role: 'user', content: [{ text: 'Reply with five cozy bedtime words.' }] }],
        inferenceConfig: { maxTokens: 40 },
      }),
    );
    return r.output?.message?.content?.[0]?.text ?? '(empty)';
  }),
  check(`Bedrock image · ${config.imageModelId} (${config.imageRegion})`, async () => {
    const png = await illustrate(`${ILLUSTRATION_STYLE}. A small round sky-blue dragon on a pillow fort under a glowing moon`, 42);
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(`${config.dataDir}/check-aws.png`, png);
    return `${png.length} bytes → data/check-aws.png`;
  }),
  check(`Amazon Polly · ${config.narratorVoice} (${config.narratorEngine}) word marks`, async () => {
    const r = await polly.send(
      new SynthesizeSpeechCommand({
        Text: 'Maya took a slow, brave breath.',
        VoiceId: config.narratorVoice as VoiceId,
        Engine: config.narratorEngine as Engine,
        OutputFormat: 'json',
        SpeechMarkTypes: ['word'],
      }),
    );
    return (await r.AudioStream!.transformToString()).trim().split('\n').length + ' word marks';
  }),
]);
