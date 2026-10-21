import express, { type Request, type Response, type NextFunction } from 'express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { config, DEFAULT_ALEXA_CLIENT_SECRET, MCP_PATH, originAllowed } from './config.js';
import { loadDb } from './store.js';
import { authRouter, ensureBuiltInClients, requireMcpAuth } from './auth.js';
import { createMcpServer, loadAppBundle, watchAppBundle } from './mcp.js';
import { mediaDir } from './media.js';
import { landingPage } from './landing.js';

if (config.publicUrl.startsWith('https:') && (!config.alexaClientSecret || config.alexaClientSecret === DEFAULT_ALEXA_CLIENT_SECRET)) {
  console.error(
    `Refusing to start: PUBLIC_URL is ${config.publicUrl} but ALEXA_CLIENT_SECRET is the repo default. ` +
      'Set ALEXA_CLIENT_SECRET to a long random value (and the same value in the Alexa+ add-on account-linking config).',
  );
  process.exit(1);
}

loadDb();
ensureBuiltInClients();
loadAppBundle();
watchAppBundle();

const app = express();
// Exact-case routes: the Origin check and rate limits key on the path, so "/MCP" must not reach "/mcp".
app.set('case sensitive routing', true);
app.disable('x-powered-by');
app.set('trust proxy', config.trustProxy);

/** Endpoints a hostile web page must not be able to drive from a user's browser (DNS rebinding, CSRF). */
const ORIGIN_CHECKED = [MCP_PATH, '/token', '/register', '/revoke', '/authorize'];

/**
 * Browser-based MCP clients (like the Countertop simulator) need CORS on the MCP + OAuth endpoints.
 * Only allow-listed origins are echoed back; a request whose Origin is not on the list gets 403 on the
 * endpoints above, as the Streamable HTTP spec requires. No Origin header (Alexa+, curl) is fine.
 */
function cors(req: Request, res: Response, next: NextFunction) {
  const origin = req.headers.origin;
  res.vary('Origin');
  if (origin !== undefined && !originAllowed(origin)) {
    if (!ORIGIN_CHECKED.some((p) => req.path === p || req.path.startsWith(`${p}/`))) return next();
    console.warn(`[http] blocked ${req.method} ${req.path} from origin ${origin}`);
    return req.path.startsWith(MCP_PATH)
      ? res.status(403).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Forbidden: origin not allowed' }, id: null })
      : res.status(403).json({ error: 'invalid_request', error_description: 'Origin not allowed' });
  }
  if (origin !== undefined) {
    res.set({
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'authorization, content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id',
      'Access-Control-Expose-Headers': 'mcp-session-id, mcp-protocol-version, www-authenticate',
      'Access-Control-Max-Age': '600',
    });
  }
  if (req.method === 'OPTIONS') return res.status(204).end();
  next();
}
app.use(cors);

app.get('/health', (_req, res) => res.json({ ok: true, aiMode: config.aiMode }));
app.use('/media', express.static(mediaDir(), { maxAge: '7d', fallthrough: false }));
app.use(authRouter());

// Streamable HTTP, stateless: a fresh server + transport per request, scoped to the linked family.
app.post(MCP_PATH, requireMcpAuth, express.json({ limit: '1mb' }), async (req, res) => {
  const familyId = (req as any).auth.extra.familyId as string;
  const server = createMcpServer(familyId);
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    transport.close();
    server.close();
  });
  const started = Date.now();
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error('[mcp] request failed', err);
    if (!res.headersSent) res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal error' }, id: null });
  } finally {
    const method = Array.isArray(req.body) ? 'batch' : req.body?.method;
    const tool = req.body?.params?.name ? ` ${req.body.params.name}` : '';
    console.log(`[mcp] ${method}${tool} ${Date.now() - started}ms`);
  }
});
// No server-initiated streams in stateless mode.
app.get(MCP_PATH, requireMcpAuth, (_req, res) => res.status(405).set('Allow', 'POST').end());
app.delete(MCP_PATH, (_req, res) => res.status(405).set('Allow', 'POST').end());

app.get('/', (_req, res) => {
  res.type('html').send(landingPage());
});
app.get('/privacy', (_req, res) =>
  res.type('text').send(
    'Once Upon Tonight privacy notice (hackathon prototype)\n\nA parent account stores: the parent email, each story hero nickname and preferences the parent enters, generated stories, illustrations and narration, and reading progress. No voice recordings are received or stored. Story text is generated with Amazon Bedrock and is not used to train models. Parents can delete a hero\'s stories and story memories at any time ("forget the story world"). Data is kept until the parent deletes it or the account is closed.',
  ),
);
app.get('/terms', (_req, res) => res.type('text').send('Once Upon Tonight is a hackathon prototype provided as-is for demonstration purposes.'));

app.listen(config.port, config.host, () => {
  console.log(
    `🌙 Once Upon Tonight listening on ${config.host}:${config.port} as ${config.publicUrl}  (MCP at ${MCP_PATH}, AI_MODE=${config.aiMode}${config.demoMode ? ', demo mode' : ''})`,
  );
});
