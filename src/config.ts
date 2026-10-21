import 'dotenv/config';
import path from 'node:path';

const port = Number(process.env.PORT ?? 8787);

export const config = {
  port,
  /** Public base URL of this server. Alexa+ (or any MCP host) reaches /mcp under it. */
  publicUrl: (process.env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, ''),
  dataDir: path.resolve(process.env.DATA_DIR ?? 'data'),

  /** 'bedrock' calls Amazon Bedrock + Polly; 'mock' replays the bundled seed story (no AWS needed). */
  aiMode: (process.env.AI_MODE ?? 'bedrock') as 'bedrock' | 'mock',
  awsRegion: process.env.AWS_REGION ?? 'us-east-1',
  textModelId: process.env.TEXT_MODEL_ID ?? 'us.anthropic.claude-sonnet-4-6',
  /** Stability AI SD3.5 Large on Bedrock (us-west-2): best character fidelity per dollar in our tests. Nova Canvas ids also work. */
  imageModelId: process.env.IMAGE_MODEL_ID ?? 'stability.sd3-5-large-v1:0',
  imageRegion: process.env.IMAGE_REGION ?? 'us-west-2',
  /** Fast model that applies the bedtime-suitability rubric to requests and pages. */
  reviewModelId: process.env.REVIEW_MODEL_ID ?? 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
  guardrailId: process.env.GUARDRAIL_ID,
  guardrailVersion: process.env.GUARDRAIL_VERSION ?? 'DRAFT',
  narratorVoice: process.env.NARRATOR_VOICE ?? 'Danielle',
  narratorEngine: (process.env.NARRATOR_ENGINE ?? 'neural') as 'neural' | 'generative' | 'long-form' | 'standard',

  /**
   * Alexa+ account linking expects a bare 401 (no WWW-Authenticate header) and discovers
   * auth through /.well-known/oauth-protected-resource instead. The MCP 2025-11-25 spec allows
   * either discovery mechanism, so this stays on by default.
   */
  alexaStrict401: (process.env.ALEXA_STRICT_401 ?? 'true') === 'true',
  /** Set to false to let unauthenticated requests act as the demo family (handy with MCP Inspector). */
  requireAuth: (process.env.REQUIRE_AUTH ?? 'true') === 'true',
  /** Client secret Alexa+ uses during account linking (configured in addon-package/addon.json). */
  alexaClientSecret: process.env.ALEXA_CLIENT_SECRET ?? 'change-me-alexa-secret',
};

export const MCP_PATH = '/mcp';
export const resourceUrl = () => `${config.publicUrl}${MCP_PATH}`;
