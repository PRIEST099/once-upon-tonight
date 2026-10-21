/**
 * `npm run create-guardrail` — creates the Amazon Bedrock Guardrail that checks every story
 * (and every parent request) for bedtime-appropriate content, then prints the env vars to set.
 */
import { BedrockClient, CreateGuardrailCommand, CreateGuardrailVersionCommand } from '@aws-sdk/client-bedrock';
import { config } from '../src/config.js';

const bedrock = new BedrockClient({ region: config.awsRegion });
const blocked = "Let's keep tonight's story cozy and kind. Could you tell me a little differently what happened today?";

const g = await bedrock.send(
  new CreateGuardrailCommand({
    name: `once-upon-tonight-bedtime-${Date.now().toString(36)}`,
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
    topicPolicyConfig: {
      topicsConfig: [
        {
          name: 'Frightening content',
          type: 'DENY',
          definition: 'Story content meant to scare a young child, such as monsters chasing or attacking, being lost or abandoned, death, or characters in danger.',
          examples: ['A monster hid under the bed and grabbed her foot.', 'Everyone left and she was all alone in the dark forest forever.'],
        },
        {
          name: 'Unsafe activities',
          type: 'DENY',
          definition: 'Story content that shows children doing dangerous things as if they were fun or fine, such as playing with fire, going off with strangers, or taking medicine alone.',
          examples: ['Maya lit a match to make the room glow.', 'Pip said it was fine to go with the stranger who offered candy.'],
        },
      ],
    },
    wordPolicyConfig: { managedWordListsConfig: [{ type: 'PROFANITY' }] },
    blockedInputMessaging: blocked,
    blockedOutputsMessaging: blocked,
  }),
);
const v = await bedrock.send(new CreateGuardrailVersionCommand({ guardrailIdentifier: g.guardrailId!, description: 'v1' }));
console.log(`Created guardrail ${g.guardrailId} version ${v.version}. Add to .env:\nGUARDRAIL_ID=${g.guardrailId}\nGUARDRAIL_VERSION=${v.version}`);
