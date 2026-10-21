import express, { type Request, type Response, type NextFunction } from 'express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import { config, MCP_PATH } from './config.js';
import { loadDb } from './store.js';
import { authRouter, ensureBuiltInClients, requireMcpAuth } from './auth.js';
import { createMcpServer, loadAppBundle, watchAppBundle } from './mcp.js';
import { mediaDir } from './media.js';

loadDb();
ensureBuiltInClients();
loadAppBundle();
watchAppBundle();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);

/** Browser-based MCP clients (like the Countertop simulator) need CORS on the MCP + OAuth endpoints. */
function cors(req: Request, res: Response, next: NextFunction) {
  res.set({
    'Access-Control-Allow-Origin': req.headers.origin ?? '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'authorization, content-type, accept, mcp-protocol-version, mcp-session-id, last-event-id',
    'Access-Control-Expose-Headers': 'mcp-session-id, mcp-protocol-version, www-authenticate',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  });
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
  res.type('html').send(`<!doctype html><meta charset="utf-8"><title>Once Upon Tonight</title>
<body style="font-family:system-ui;max-width:640px;margin:48px auto;padding:0 16px;line-height:1.6">
<h1>🌙 Once Upon Tonight</h1>
<p>An Alexa+ MCP add-on that turns a child's day into tonight's illustrated, narrated bedtime story.</p>
<ul><li>MCP endpoint (Streamable HTTP): <code>${config.publicUrl}${MCP_PATH}</code></li>
<li>Protected resource metadata: <a href="/.well-known/oauth-protected-resource">/.well-known/oauth-protected-resource</a></li>
<li>Authorization server metadata: <a href="/.well-known/oauth-authorization-server">/.well-known/oauth-authorization-server</a></li></ul>
<p><a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></p></body>`);
});
app.get('/privacy', (_req, res) =>
  res.type('text').send(
    'Once Upon Tonight privacy notice (hackathon prototype)\n\nA parent account stores: the parent email, each story hero nickname and preferences the parent enters, generated stories, illustrations and narration, and reading progress. No voice recordings are received or stored. Story text is generated with Amazon Bedrock and is not used to train models. Parents can delete a hero\'s stories and story memories at any time ("forget the story world"). Data is kept until the parent deletes it or the account is closed.',
  ),
);
app.get('/terms', (_req, res) => res.type('text').send('Once Upon Tonight is a hackathon prototype provided as-is for demonstration purposes.'));

app.listen(config.port, () => {
  console.log(`🌙 Once Upon Tonight listening on ${config.publicUrl}  (MCP at ${MCP_PATH}, AI_MODE=${config.aiMode})`);
});
