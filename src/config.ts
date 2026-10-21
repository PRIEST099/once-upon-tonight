import 'dotenv/config';
import path from 'node:path';

const port = Number(process.env.PORT ?? 8787);
const publicUrl = (process.env.PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, '');
const publicIsLocal = ['localhost', '127.0.0.1'].includes(new URL(publicUrl).hostname);
const list = (v: string | undefined) => (v ?? '').split(',').map((s) => s.trim()).filter(Boolean);

function parseTrustProxy(v: string): boolean | number | string {
  if (v === 'true' || v === 'false') return v === 'true';
  return /^\d+$/.test(v) ? Number(v) : v;
}

/** The placeholder secret shipped in the repo; the server refuses to run on a public https URL with it. */
export const DEFAULT_ALEXA_CLIENT_SECRET = 'change-me-alexa-secret';

export const config = {
  port,
  /** Interface to bind. Loopback by default; set HOST=0.0.0.0 in a container or behind a remote load balancer. */
  host: process.env.HOST ?? '127.0.0.1',
  /** Public base URL of this server. Alexa+ (or any MCP host) reaches /mcp under it. */
  publicUrl,
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
  /** Characters' quoted lines read in their own voices (CHARACTER_VOICES=false: the narrator reads everything). */
  characterVoices: process.env.CHARACTER_VOICES !== 'false',
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
  alexaClientSecret: process.env.ALEXA_CLIENT_SECRET ?? DEFAULT_ALEXA_CLIENT_SECRET,
  /** Prefill the seeded parent's email/password on the sign-in page. On by default only for a localhost PUBLIC_URL. */
  /**
   * Hosted demo (AI_MODE=mock): stories for heroes a visitor adds are made live, with paid models, within
   * LIVE_STORIES_PER_DAY (all visitors, rolling 24 h) and LIVE_STORIES_TOTAL (ever). Maya's stay pre-made.
   */
  liveNewHeroes: process.env.LIVE_NEW_HEROES === 'true',
  liveStoriesPerDay: Number(process.env.LIVE_STORIES_PER_DAY ?? 3),
  liveStoriesTotal: Number(process.env.LIVE_STORIES_TOTAL ?? 10),
  /** Mock mode: how long each studio step takes, so the progress is visible (the hosted demo uses a slower pace). */
  mockStepMs: Number(process.env.MOCK_STEP_MS ?? 1200),
  demoMode: (process.env.DEMO_MODE ?? String(publicIsLocal)) === 'true',

  /**
   * Browser origins allowed to call /mcp and the OAuth endpoints (the Streamable HTTP spec requires
   * Origin validation against DNS rebinding). An entry ending in ":*" matches any port. Requests that
   * carry no Origin header (Alexa+, server-to-server) are always allowed. The PUBLIC_URL origin is
   * always included, since the sign-in page posts back to it.
   */
  allowedOrigins: [
    ...(process.env.ALLOWED_ORIGINS ? list(process.env.ALLOWED_ORIGINS) : ['http://localhost:*', 'http://127.0.0.1:*']),
    new URL(publicUrl).origin,
  ],
  /** Express "trust proxy" (true/false, a hop count, or addresses); the default trusts only a tunnel/proxy on this machine. */
  trustProxy: parseTrustProxy(process.env.TRUST_PROXY ?? 'loopback'),
  /** POSTs per minute per client IP allowed on /authorize and /token. */
  authRateLimitPerMinute: Number(process.env.AUTH_RATE_LIMIT ?? 30),
};

export const MCP_PATH = '/mcp';
export const resourceUrl = () => `${config.publicUrl}${MCP_PATH}`;

const originPatterns = config.allowedOrigins.map((o) => {
  const base = o.replace(/\/$/, '').toLowerCase();
  const anyPort = base.endsWith(':*');
  const escaped = (anyPort ? base.slice(0, -2) : base).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^${escaped}${anyPort ? '(:\\d+)?' : ''}$`);
});

/** True when a browser Origin header value is on the allow-list. */
export const originAllowed = (origin: string) => originPatterns.some((re) => re.test(origin.toLowerCase()));
