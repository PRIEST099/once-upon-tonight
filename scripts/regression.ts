/**
 * `npx tsx scripts/regression.ts [--base http://localhost:8899]` — regression checks for tricky
 * behaviour. Run against a MOCK server with REQUIRE_AUTH=false, e.g.
 *   PORT=8899 DATA_DIR=/tmp/ouat-test AI_MODE=mock REQUIRE_AUTH=false npx tsx src/server.ts
 */
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { resolveChoice } from '../src/mcp.js';

const i = process.argv.indexOf('--base');
const BASE = i > 0 ? process.argv[i + 1] : 'http://localhost:8899';
let failed = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` · ${detail}` : ''}`);
  if (!ok) failed++;
};

// 1. Choice resolution (pure)
const L: [string, string] = ['Climb Moonberry Hill', 'Practice in the Pillow Fort'];
const cases: [string, 0 | 1 | undefined][] = [
  ['the first one', 0], ['the second one', 1], ['the other one', 1], ['the pillow fort one', 1], ['climb the hill', 0],
  ["I'm not scared, climb the hill!", 0], ["let's not wait, climb the hill", 0], ['practice!', 1], ['banana', undefined],
];
for (const [said, want] of cases) check(`choice "${said}"`, resolveChoice(L, said) === want, `got ${resolveChoice(L, said)}`);
check('lone "first" beats a label containing "first"', resolveChoice(['Follow the fish', 'Ask the owl first'], 'first') === 0);
check('option_number wins', resolveChoice(L, 'the hill', 2) === 1);

// 2. HTTP: exact-case routes, Origin
const post = (path: string, origin?: string) =>
  fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(origin && { origin }) },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
check('evil Origin on /mcp → 403', (await post('/mcp', 'http://evil.example')).status === 403);
check('/MCP (wrong case) does not reach the MCP handler', (await post('/MCP', 'http://evil.example')).status === 404);
check('localhost Origin allowed', (await post('/mcp', 'http://localhost:5310')).status === 200);

// 3. Tools: mock mode isn't capped; deleting mid-generation doesn't resurrect the story
const client = new Client({ name: 'regression', version: '1' });
await client.connect(new StreamableHTTPClientTransport(new URL(`${BASE}/mcp`)));
const call = async (name: string, args: Record<string, unknown> = {}) => (await client.callTool({ name, arguments: args })) as any;
for (let n = 0; n < 7; n++) {
  const r = await call('create_tonights_story', { todays_moments: `regression day ${n} ${Date.now()}`, length: 'short' });
  if (r.structuredContent?.limitReached) {
    check('mock mode is not capped', false, `capped at story ${n + 1}`);
    break;
  }
  if (n === 6) check('mock mode is not capped', true, '7 creates');
  await new Promise((r) => setTimeout(r, 7000)); // mock pipeline finishes before the next one
}
const fresh = await call('create_tonights_story', { todays_moments: `delete me ${Date.now()}`, length: 'short' });
const warn = await call('forget_story_world', { confirm: false });
const token = warn.structuredContent?.confirmation_token;
const del = await call('forget_story_world', { confirm: true, confirmation_token: token });
check('forget with a token deletes', !!del.structuredContent?.deleted || del.structuredContent?.deleted === 0, JSON.stringify(del.structuredContent).slice(0, 80));
await new Promise((r) => setTimeout(r, 9000));
const lib = await call('story_library', {});
const ids = (lib.structuredContent?.stories ?? []).map((s: any) => s.storyId);
check('story deleted mid-generation stays deleted', !ids.includes(fresh.structuredContent?.storyId), `library: ${ids.length} stories`);

await client.close();
console.log(failed ? `\n${failed} check(s) failed` : '\nAll regression checks passed.');
process.exit(failed ? 1 : 0);
