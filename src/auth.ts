import express, { type Request, type Response, type NextFunction } from 'express';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { config, resourceUrl, MCP_PATH } from './config.js';
import * as store from './store.js';
import type { OAuthClient } from './types.js';

/**
 * OAuth 2.1 authorization server + resource-server guard, shaped around Alexa+ account linking:
 *  - Protected Resource Metadata (RFC 9728) at /.well-known/oauth-protected-resource[/mcp]
 *  - Authorization Server Metadata (RFC 8414) at /.well-known/oauth-authorization-server
 *  - Authorization code + PKCE (S256 only) with the RFC 8707 `resource` parameter
 *  - Refresh tokens with rotation
 *  - Bare 401 on unauthenticated MCP requests (Alexa+ ignores WWW-Authenticate; discovery is via PRM)
 * Dynamic Client Registration is also offered for other MCP hosts; Alexa+ uses a pre-registered client.
 */

const SCOPES = ['stories'];
const ACCESS_TTL_MS = 60 * 60 * 1000;
const REFRESH_TTL_MS = 60 * 24 * 60 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;

const b64url = (buf: Buffer) => buf.toString('base64url');
const randomToken = (bytes = 32) => b64url(randomBytes(bytes));

export function ensureBuiltInClients() {
  const alexa: OAuthClient = {
    clientId: 'alexa-plus',
    clientSecret: config.alexaClientSecret,
    clientName: 'Alexa',
    redirectUris: [],
    // Alexa's account-linking redirect URLs differ per region/vendor ID, so match by prefix.
    redirectPrefixes: [
      'https://pitangui.amazon.com/',
      'https://layla.amazon.com/',
      'https://alexa.amazon.co.jp/',
      'https://alexa.amazon.com/',
    ],
    public: false,
  };
  const countertop: OAuthClient = {
    clientId: 'countertop',
    clientName: 'Countertop (Alexa+ simulator)',
    redirectUris: [],
    redirectPrefixes: ['http://localhost:', 'http://127.0.0.1:'],
    public: true,
  };
  store.putClient(alexa);
  store.putClient(countertop);
}

function redirectAllowed(client: OAuthClient, uri: string) {
  return client.redirectUris.includes(uri) || (client.redirectPrefixes ?? []).some((p) => uri.startsWith(p));
}

function oauthError(res: Response, status: number, error: string, description: string) {
  res.status(status).set('Cache-Control', 'no-store').json({ error, error_description: description });
}

export function protectedResourceMetadata() {
  return {
    resource: resourceUrl(),
    authorization_servers: [config.publicUrl],
    scopes_supported: SCOPES,
    bearer_methods_supported: ['header'],
    resource_name: 'Once Upon Tonight',
    resource_documentation: `${config.publicUrl}/`,
  };
}

export function authorizationServerMetadata() {
  const base = config.publicUrl;
  return {
    issuer: base,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    revocation_endpoint: `${base}/revoke`,
    scopes_supported: SCOPES,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post', 'none'],
    service_documentation: `${base}/`,
  };
}

/** Pending authorization requests between GET /authorize (form shown) and POST /authorize (form submitted). */
const pending = new Map<string, { params: Record<string, string>; client: OAuthClient; expiresAt: number }>();

export function authRouter() {
  const r = express.Router();
  r.use(express.urlencoded({ extended: false }));

  r.get(['/.well-known/oauth-protected-resource', `/.well-known/oauth-protected-resource${MCP_PATH}`], (_req, res) => {
    res.json(protectedResourceMetadata());
  });
  r.get(['/.well-known/oauth-authorization-server', `/.well-known/oauth-authorization-server${MCP_PATH}`], (_req, res) => {
    res.json(authorizationServerMetadata());
  });

  // ---- Dynamic Client Registration (RFC 7591), for MCP hosts other than Alexa+ ----
  r.post('/register', express.json(), (req, res) => {
    const body = req.body ?? {};
    const redirectUris: string[] = Array.isArray(body.redirect_uris) ? body.redirect_uris : [];
    if (!redirectUris.length || !redirectUris.every((u) => /^https:\/\/|^http:\/\/(localhost|127\.0\.0\.1)[:/]/.test(u))) {
      return oauthError(res, 400, 'invalid_redirect_uri', 'redirect_uris must be https (or http on localhost)');
    }
    const isPublic = (body.token_endpoint_auth_method ?? 'none') === 'none';
    const client: OAuthClient = {
      clientId: store.newId('client'),
      clientSecret: isPublic ? undefined : randomToken(24),
      clientName: String(body.client_name ?? 'MCP client').slice(0, 80),
      redirectUris,
      public: isPublic,
    };
    store.putClient(client);
    res.status(201).json({
      client_id: client.clientId,
      ...(client.clientSecret && { client_secret: client.clientSecret }),
      client_name: client.clientName,
      redirect_uris: client.redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: isPublic ? 'none' : 'client_secret_basic',
      client_id_issued_at: Math.floor(Date.now() / 1000),
    });
  });

  // ---- Authorization endpoint: parent signs in and consents ----
  r.get('/authorize', (req, res) => {
    const q = Object.fromEntries(Object.entries(req.query).map(([k, v]) => [k, String(v)]));
    const client = q.client_id ? store.getClient(q.client_id) : undefined;
    if (!client) return res.status(400).send(errorPage('Unknown app', 'This app is not registered with Once Upon Tonight.'));
    if (!q.redirect_uri || !redirectAllowed(client, q.redirect_uri)) {
      return res.status(400).send(errorPage('Redirect not allowed', 'The redirect address for this app is not registered.'));
    }
    const back = (params: Record<string, string>) => {
      const u = new URL(q.redirect_uri);
      for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
      if (q.state) u.searchParams.set('state', q.state);
      return res.redirect(u.toString());
    };
    if (q.response_type !== 'code') return back({ error: 'unsupported_response_type' });
    if (!q.code_challenge || q.code_challenge_method !== 'S256') {
      return back({ error: 'invalid_request', error_description: 'PKCE with code_challenge_method=S256 is required' });
    }
    if (q.resource && !sameResource(q.resource)) {
      return back({ error: 'invalid_target', error_description: 'Unknown resource' });
    }
    const txn = randomToken(16);
    pending.set(txn, { params: q, client, expiresAt: Date.now() + 10 * 60 * 1000 });
    res.send(consentPage(txn, client.clientName));
  });

  r.post('/authorize', (req, res) => {
    const txn = pending.get(String(req.body.txn ?? ''));
    if (!txn || txn.expiresAt < Date.now()) return res.status(400).send(errorPage('Sign-in expired', 'Please start linking again.'));
    const { params, client } = txn;
    const u = new URL(params.redirect_uri);
    if (params.state) u.searchParams.set('state', params.state);

    if (req.body.action === 'deny') {
      pending.delete(String(req.body.txn));
      u.searchParams.set('error', 'access_denied');
      return res.redirect(u.toString());
    }
    const family = store.findFamilyByEmail(String(req.body.email ?? ''));
    if (!family || family.password !== String(req.body.password ?? '')) {
      return res.status(401).send(consentPage(String(req.body.txn), client.clientName, 'That email and password did not match.'));
    }
    pending.delete(String(req.body.txn));
    const code = randomToken(24);
    store.putCode({
      code,
      clientId: client.clientId,
      familyId: family.id,
      redirectUri: params.redirect_uri,
      codeChallenge: params.code_challenge,
      resource: params.resource,
      scope: params.scope && params.scope.split(' ').every((s) => SCOPES.includes(s)) ? params.scope : SCOPES.join(' '),
      expiresAt: Date.now() + CODE_TTL_MS,
    });
    u.searchParams.set('code', code);
    res.redirect(u.toString());
  });

  // ---- Token endpoint ----
  r.post('/token', express.urlencoded({ extended: false }), (req, res) => {
    const client = authenticateClient(req);
    if (!client) return oauthError(res, 401, 'invalid_client', 'Client authentication failed');
    const body = req.body ?? {};

    if (body.grant_type === 'authorization_code') {
      const code = store.takeCode(String(body.code ?? ''));
      if (!code || code.expiresAt < Date.now() || code.clientId !== client.clientId) {
        return oauthError(res, 400, 'invalid_grant', 'Authorization code is invalid or expired');
      }
      if (body.redirect_uri && body.redirect_uri !== code.redirectUri) {
        return oauthError(res, 400, 'invalid_grant', 'redirect_uri does not match');
      }
      const verifier = String(body.code_verifier ?? '');
      const expected = b64url(createHash('sha256').update(verifier).digest());
      if (!verifier || !safeEqual(expected, code.codeChallenge)) {
        return oauthError(res, 400, 'invalid_grant', 'PKCE verification failed');
      }
      const resource = body.resource ?? code.resource;
      if (resource && !sameResource(resource)) return oauthError(res, 400, 'invalid_target', 'Unknown resource');
      return issueTokens(res, client.clientId, code.familyId, code.scope, resource);
    }

    if (body.grant_type === 'refresh_token') {
      const rt = store.getToken(String(body.refresh_token ?? ''));
      if (!rt || rt.kind !== 'refresh' || rt.expiresAt < Date.now() || rt.clientId !== client.clientId) {
        return oauthError(res, 400, 'invalid_grant', 'Refresh token is invalid or expired');
      }
      store.deleteToken(rt.token); // rotation
      return issueTokens(res, client.clientId, rt.familyId, rt.scope, rt.resource);
    }

    oauthError(res, 400, 'unsupported_grant_type', 'Use authorization_code or refresh_token');
  });

  r.post('/revoke', express.urlencoded({ extended: false }), (req, res) => {
    const client = authenticateClient(req);
    const t = store.getToken(String(req.body?.token ?? ''));
    if (client && t && t.clientId === client.clientId) store.deleteToken(t.token);
    res.status(200).end();
  });

  return r;
}

function sameResource(value: string) {
  const norm = (s: string) => s.replace(/#.*$/, '').replace(/\/$/, '');
  return norm(value) === norm(resourceUrl()) || norm(value) === norm(config.publicUrl);
}

function safeEqual(a: string, b: string) {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

function authenticateClient(req: Request): OAuthClient | undefined {
  let id: string | undefined;
  let secret: string | undefined;
  const basic = req.headers.authorization?.match(/^Basic (.+)$/i);
  if (basic) {
    const [u, p] = Buffer.from(basic[1], 'base64').toString().split(':');
    id = decodeURIComponent(u ?? '');
    secret = decodeURIComponent(p ?? '');
  } else {
    id = req.body?.client_id;
    secret = req.body?.client_secret;
  }
  const client = id ? store.getClient(id) : undefined;
  if (!client) return undefined;
  if (client.public) return client; // PKCE is the proof for public clients
  return client.clientSecret && secret && safeEqual(client.clientSecret, secret) ? client : undefined;
}

function issueTokens(res: Response, clientId: string, familyId: string, scope: string, resource?: string) {
  const access = randomToken();
  const refresh = randomToken();
  const now = Date.now();
  store.putToken({ token: access, kind: 'access', clientId, familyId, scope, resource, expiresAt: now + ACCESS_TTL_MS });
  store.putToken({ token: refresh, kind: 'refresh', clientId, familyId, scope, resource, expiresAt: now + REFRESH_TTL_MS });
  res.set('Cache-Control', 'no-store').json({
    access_token: access,
    token_type: 'Bearer',
    expires_in: ACCESS_TTL_MS / 1000,
    refresh_token: refresh,
    scope,
  });
}

/** Resource-server guard for /mcp. Populates req.auth, which the MCP SDK surfaces as ctx.http.authInfo. */
export function requireMcpAuth(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  const bearer = header?.match(/^Bearer (.+)$/i)?.[1];

  if (!bearer && !config.requireAuth) {
    (req as any).auth = {
      token: 'demo',
      clientId: 'demo',
      scopes: SCOPES,
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      extra: { familyId: store.DEMO_FAMILY_ID },
    };
    return next();
  }

  const t = bearer ? store.getToken(bearer) : undefined;
  const valid = t && t.kind === 'access' && t.expiresAt > Date.now() && (!t.resource || sameResource(t.resource));
  if (!valid) {
    if (!config.alexaStrict401) {
      res.set('WWW-Authenticate', `Bearer resource_metadata="${config.publicUrl}/.well-known/oauth-protected-resource${MCP_PATH}"`);
    }
    return res.status(401).json({ error: 'invalid_token', error_description: bearer ? 'Token is invalid or expired' : 'Authorization required' });
  }
  (req as any).auth = {
    token: t.token,
    clientId: t.clientId,
    scopes: t.scope.split(' '),
    expiresAt: Math.floor(t.expiresAt / 1000),
    ...(t.resource && { resource: new URL(t.resource) }),
    extra: { familyId: t.familyId },
  };
  next();
}

// ---- pages -------------------------------------------------------------------------------

const pageShell = (title: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>
:root{--ink:#1d1640;--muted:#5b5680;--card:#fffdf8;--accent:#ffb84d;--night:#231a5c;--line:#e7e1f5}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;font-family:ui-rounded,"SF Pro Rounded","Avenir Next",system-ui,sans-serif;
background:radial-gradient(1200px 600px at 20% -10%,#4b3ba8 0,transparent 60%),linear-gradient(180deg,#231a5c,#120c33);color:var(--ink);padding:16px}
.card{width:min(440px,100%);background:var(--card);border-radius:24px;padding:28px;box-shadow:0 30px 80px rgba(0,0,0,.35)}
.brand{display:flex;gap:12px;align-items:center;margin-bottom:18px}.moon{width:44px;height:44px;border-radius:50%;background:radial-gradient(circle at 35% 35%,#fff6d6,#ffd36b);box-shadow:0 0 24px #ffd36b88}
h1{font-size:22px;margin:0}p{color:var(--muted);line-height:1.5}ul{color:var(--muted);padding-left:20px;line-height:1.6}
label{display:block;font-weight:600;margin:14px 0 6px}input{width:100%;padding:12px 14px;border-radius:12px;border:1.5px solid var(--line);font-size:16px}
.row{display:flex;gap:10px;margin-top:20px}button{flex:1;padding:14px;border-radius:14px;border:0;font-size:16px;font-weight:700;cursor:pointer}
.allow{background:var(--night);color:#fff}.deny{background:#efeaf9;color:var(--ink)}.err{color:#b3261e;font-weight:600}.hint{font-size:13px;background:#fff4dc;border-radius:10px;padding:8px 10px;color:#6b4e00}
</style></head><body><main class="card">${body}</main></body></html>`;

function consentPage(txn: string, clientName: string, error?: string) {
  return pageShell(
    'Link Once Upon Tonight',
    `<div class="brand"><div class="moon"></div><div><h1>Once Upon Tonight</h1><div style="color:#5b5680">Bedtime stories, made from today</div></div></div>
<p><strong>${escapeHtml(clientName)}</strong> would like to link to your family's Once Upon Tonight account. It will be able to:</p>
<ul><li>create tonight's story for your children</li><li>open your family's story library</li><li>remember each child's story world between nights</li></ul>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/authorize">
<input type="hidden" name="txn" value="${txn}">
<label for="email">Parent email</label><input id="email" name="email" type="email" autocomplete="username" value="parent@example.com" required>
<label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" value="bedtime" required>
<p class="hint">Demo family: parent@example.com / bedtime</p>
<div class="row"><button class="deny" name="action" value="deny" formnovalidate>Not now</button><button class="allow" name="action" value="allow">Link account</button></div>
</form>`,
  );
}

function errorPage(title: string, message: string) {
  return pageShell(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
