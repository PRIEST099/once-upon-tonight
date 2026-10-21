/**
 * `npm run smoke` — end-to-end check that behaves like Alexa+ would:
 *   OAuth discovery → account linking (code + PKCE S256 + resource) → MCP initialize over
 *   Streamable HTTP → tools/list → resources/read (UI) → the whole bedtime flow, timing every call
 *   against Alexa+'s 500 ms budget.
 * Usage: npm run smoke [-- --base http://localhost:8787] [-- --skip-create]
 */
import { createHash, randomBytes } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

const arg = (name: string) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] ?? 'true' : undefined;
};
const BASE = arg('base') ?? 'http://localhost:8787';
const SKIP_CREATE = Boolean(arg('skip-create'));
const REDIRECT = 'http://localhost:9999/callback';

const ok = (m: string) => console.log(`  ✅ ${m}`);
const bad = (m: string) => { console.log(`  ❌ ${m}`); process.exitCode = 1; };

async function linkAccount() {
  console.log('\n① OAuth discovery + account linking');
  const unauth = await fetch(`${BASE}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  unauth.status === 401 ? ok(`unauthenticated /mcp → 401 (WWW-Authenticate: ${unauth.headers.get('www-authenticate') ?? 'none, Alexa-style'})`) : bad(`expected 401, got ${unauth.status}`);
  const prm = await (await fetch(`${BASE}/.well-known/oauth-protected-resource`)).json();
  ok(`protected resource metadata → resource=${prm.resource}`);
  const as = await (await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json();
  as.code_challenge_methods_supported?.includes('S256') ? ok('authorization server advertises PKCE S256') : bad('S256 missing');

  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authUrl = new URL(as.authorization_endpoint);
  Object.entries({ response_type: 'code', client_id: 'countertop', redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'xyz', resource: prm.resource, scope: 'stories' }).forEach(([k, v]) =>
    authUrl.searchParams.set(k, v),
  );
  const page = await (await fetch(authUrl)).text();
  const txn = page.match(/name="txn" value="([^"]+)"/)?.[1];
  if (!txn) throw new Error('consent page did not render');
  ok('consent page rendered');
  const consent = await fetch(as.authorization_endpoint, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ txn, email: 'parent@example.com', password: 'bedtime', action: 'allow' }),
  });
  const code = new URL(consent.headers.get('location')!).searchParams.get('code');
  if (!code) throw new Error('no authorization code');
  ok('parent signed in → authorization code');
  const tok = await (
    await fetch(as.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT, client_id: 'countertop', code_verifier: verifier, resource: prm.resource }),
    })
  ).json();
  tok.access_token && tok.refresh_token ? ok('token exchange → access + refresh token') : bad(`token exchange failed ${JSON.stringify(tok)}`);
  const refreshed = await (
    await fetch(as.token_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tok.refresh_token, client_id: 'countertop' }),
    })
  ).json();
  refreshed.access_token ? ok('refresh token rotation works') : bad('refresh failed');
  return refreshed.access_token as string;
}

async function main() {
  const token = await linkAccount();
  console.log('\n② MCP over Streamable HTTP');
  const client = new Client({ name: 'smoke-test', version: '1.0.0' });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  ok(`initialized · server=${client.getServerVersion()?.name} · protocol negotiated`);

  const timed = async <T>(label: string, fn: () => Promise<T>) => {
    const t = Date.now();
    const r = await fn();
    const ms = Date.now() - t;
    (ms < 500 ? ok : bad)(`${label} · ${ms}ms${ms < 500 ? '' : ' (over the 500 ms Alexa+ budget)'}`);
    return r;
  };
  const { tools } = await timed('tools/list', () => client.listTools());
  console.log(`     ${tools.map((t) => t.name).join(', ')}`);
  const { resources } = await timed('resources/list', () => client.listResources());
  const ui = await timed(`resources/read ${resources[0].uri}`, () => client.readResource({ uri: resources[0].uri }));
  console.log(`     ${ui.contents[0].mimeType} · ${(ui.contents[0] as any).text.length} bytes`);

  const call = (name: string, args: Record<string, unknown> = {}) =>
    timed(`tools/call ${name}`, () => client.callTool({ name, arguments: args })).then((r: any) => {
      console.log(`     🗣  ${r.content?.[0]?.text?.slice(0, 160)}`);
      return r;
    });

  let storyId: string | undefined;
  if (!SKIP_CREATE) {
    console.log('\n③ Parent: make tonight\'s story');
    const created = await call('create_tonights_story', {
      todays_moments: 'Maya lost her first wobbly tooth at lunch today and is a little nervous about her first dentist visit tomorrow morning.',
      theme: 'bravery',
      length: 'short',
    });
    storyId = created.structuredContent.storyId;
    let status = 'queued';
    const started = Date.now();
    while (!['ready', 'failed'].includes(status)) {
      await new Promise((r) => setTimeout(r, 4000));
      const p: any = await client.callTool({ name: 'check_story_progress', arguments: { story_id: storyId } });
      status = p.structuredContent.status;
      console.log(`     … ${Math.round((Date.now() - started) / 1000)}s ${status}: ${p.structuredContent.step}`);
    }
    if (status === 'failed') return bad('story generation failed');
    ok(`story ready in ${Math.round((Date.now() - started) / 1000)}s`);
  }

  console.log('\n④ Bedtime: read, choose, explore a word');
  const open = await call('open_storybook', { start_over: true });
  storyId ??= open.structuredContent.storyId;
  await call('turn_page', { direction: 'next' });
  await call('turn_page', { direction: 'next' });
  await call('choose_path', { choice: 'the first one' });
  await call('explain_word', {});
  await call('turn_page', { direction: 'next' });
  await call('turn_page', { direction: 'next' });

  console.log('\n⑤ Parent: next morning');
  await call('bedtime_recap', {});
  await call('story_library', {});
  await call('update_story_world', {});
  await client.close();
  console.log(process.exitCode ? '\nSome checks failed.' : '\nAll checks passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
