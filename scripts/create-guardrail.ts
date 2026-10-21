/**
 * `npm run create-guardrail` — creates the Amazon Bedrock Guardrail that checks every story
 * (and every parent request) for bedtime-appropriate content, then prints the env vars to set.
 */
import { BedrockClient, CreateGuardrailCommand, CreateGuardrailVersionCommand } from '@aws-sdk/client-bedrock';
import { config } from '../src/config.js';

const bedrock = new BedrockClient({ region: config.awsRegion });
// --topics none (default) | frightening | all
// Default is content filters + prompt-attack + profanity only: on our bedtime corpus, denied topics
// blocked 15% of gentle stories (comforting a fear reads as "frightening content"). Nuance is handled
// by the bedtime-suitability review in src/story/safety.ts instead.
const topicsArg = process.argv.includes('--topics') ? process.argv[process.argv.indexOf('--topics') + 1] : 'none';
const blocked = "Let's keep tonight's story cozy and kind. Could you tell me a little differently what happened today?";

const g = await bedrock.send(
  new CreateGuardrailCommand({
    name: `once-upon-tonight-bedtime-${topicsArg}-${Date.now().toString(36)}`,
    description: "Keeps Once Upon Tonight stories calm, kind and age-appropriate for young children at bedtime.",
    contentPolicyConfig: {
      filtersConfig: [
        { type: 'SEXUAL', inputStrength: 'HIGH', outputStrength: 'HIGH' },
        { type: 'VIOLENCE', inputStrength: 'MEDIUM', outputStrength: 'HIGH' },
        { type: 'HATE', inputStrength: 'HIGH', outputStrength: 'HIGH' },
        { type: 'INSULTS', inputStrength: 'MEDIUM', outputStrength: 'HIGH' },
        { type: 'MISCONDUCT', inputStrength: 'MEDIUM', outputStrength: 'HIGH' },
        { type: 'PROMPT_ATTACK', inputStrength: 'HIGH', outputStrength: 'NONE' },
      ],
    },
    ...(topicsArg !== 'none' && { topicPolicyConfig: {
      topicsConfig: [
        {
          name: 'Frightening content',
          type: 'DENY' as const,
          // Narrow on purpose: feeling nervous or brave about everyday things is the heart of these stories.
          definition: 'Scenes built to terrify a young child: monsters or villains attacking, kidnapping, death, injury, or a child abandoned in danger.',
          examples: ['A monster hid under the bed and grabbed her foot.', 'Everyone left and she was all alone in the dark forest forever.', 'The wolf chased them and bit Pip.'],
        },
        {
          name: 'Unsafe activities',
          type: 'DENY' as const,
          definition: 'Encouraging a child to do something dangerous alone, like playing with fire, knives or medicine, or going off with strangers.',
          examples: ['Maya lit a match to make the room glow.', 'Pip said it was fine to go with the stranger who offered candy.', 'She climbed onto the roof all by herself.'],
        },
      ].filter((t) => topicsArg === 'all' || t.name === 'Frightening content'),
    } }),
    wordPolicyConfig: { managedWordListsConfig: [{ type: 'PROFANITY' }] },
    blockedInputMessaging: blocked,
    blockedOutputsMessaging: blocked,
  }),
);
const v = await bedrock.send(new CreateGuardrailVersionCommand({ guardrailIdentifier: g.guardrailId!, description: 'v1' }));
console.log(`Created guardrail ${g.guardrailId} version ${v.version}. Add to .env:\nGUARDRAIL_ID=${g.guardrailId}\nGUARDRAIL_VERSION=${v.version}`);
