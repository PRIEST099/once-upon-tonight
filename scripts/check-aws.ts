/**
 * `npm run check-aws` — verifies this AWS account can call every service the story pipeline uses:
 * the writer and review models, the Guardrail (when GUARDRAIL_ID is set), the image model,
 * Rekognition image moderation and Polly. Writes a sample illustration to data/check-aws.png.
 * These are live, billed calls (a few cents in all).
 */
import fs from 'node:fs';
import { ApplyGuardrailCommand, ConverseCommand } from '@aws-sdk/client-bedrock-runtime';
import { SynthesizeSpeechCommand, type Engine, type VoiceId } from '@aws-sdk/client-polly';
import { DetectModerationLabelsCommand } from '@aws-sdk/client-rekognition';
import { config } from '../src/config.js';
import { bedrock, polly, rekognition } from '../src/story/aws.js';
import { illustrate, ILLUSTRATION_STYLE } from '../src/story/illustrator.js';
import { IMAGE_FLAG_CONFIDENCE } from '../src/story/safety.js';

const check = async (name: string, fn: () => Promise<string>) => {
  const started = Date.now();
  try {
    const result = await fn();
    console.log(`✅ ${name} (${Date.now() - started}ms): ${result}`);
  } catch (e: any) {
    console.log(`❌ ${name} (${Date.now() - started}ms): ${e.name}: ${String(e.message).slice(0, 240)}`);
  }
};

const converse = async (modelId: string) => {
  const r = await bedrock.send(
    new ConverseCommand({
      modelId,
      messages: [{ role: 'user', content: [{ text: 'Reply with five cozy bedtime words.' }] }],
      inferenceConfig: { maxTokens: 40 },
    }),
  );
  return r.output?.message?.content?.[0]?.text ?? '(empty)';
};

// Rekognition moderates the same sample picture the image check paints.
const painting = illustrate(`${ILLUSTRATION_STYLE}. A small round sky-blue dragon on a pillow fort under a glowing moon`, 42);

await Promise.all([
  check(`Bedrock text · ${config.textModelId}`, () => converse(config.textModelId)),
  check(`Bedrock review · ${config.reviewModelId}`, () => converse(config.reviewModelId)),
  config.guardrailId
    ? check(`Bedrock Guardrail · ${config.guardrailId} (${config.guardrailVersion})`, async () => {
        const r = await bedrock.send(
          new ApplyGuardrailCommand({
            guardrailIdentifier: config.guardrailId,
            guardrailVersion: config.guardrailVersion,
            source: 'OUTPUT',
            content: [{ text: { text: 'Maya and her dragon built a pillow fort and whispered goodnight to the moon.' } }],
          }),
        );
        const units = (r.usage?.contentPolicyUnits ?? 0) + (r.usage?.topicPolicyUnits ?? 0);
        return `${r.action} on a gentle sentence (${units} text units)`;
      })
    : console.log('⏭️  Bedrock Guardrail: skipped, GUARDRAIL_ID is not set (only the bedtime review runs)'),
  check(`Bedrock image · ${config.imageModelId} (${config.imageRegion})`, async () => {
    const png = await painting;
    fs.mkdirSync(config.dataDir, { recursive: true });
    fs.writeFileSync(`${config.dataDir}/check-aws.png`, png);
    return `${png.length} bytes → data/check-aws.png`;
  }),
  check(`Rekognition moderation (${config.awsRegion})`, async () => {
    // MinConfidence 1 lists even faint labels, so you can see how far the sample is from the bar.
    const r = await rekognition.send(new DetectModerationLabelsCommand({ Image: { Bytes: await painting }, MinConfidence: 1 }));
    const labels = r.ModerationLabels ?? [];
    const flagged = labels.some((l) => (l.Confidence ?? 0) >= IMAGE_FLAG_CONFIDENCE);
    const list = labels.map((l) => `${l.Name}(${Math.round(l.Confidence ?? 0)})`).join(', ') || 'none';
    return `${flagged ? `would be repainted (a label ≥ ${IMAGE_FLAG_CONFIDENCE})` : 'clean'} · labels: ${list}`;
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
