import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { PollyClient } from '@aws-sdk/client-polly';
import { config } from '../config.js';

export const bedrock = new BedrockRuntimeClient({ region: config.awsRegion });
/** Image models live in a different region than the text models on this account. */
export const bedrockImages = new BedrockRuntimeClient({ region: config.imageRegion });
export const polly = new PollyClient({ region: config.awsRegion });
