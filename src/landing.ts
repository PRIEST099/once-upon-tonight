import { config, MCP_PATH } from './config.js';

/** The hosted Countertop (infra/deploy-countertop-aws.sh), already pointed at the demo endpoint. */
const TRY_IT = process.env.TRY_IT_URL ?? 'https://d3eqnu2zudrdt1.cloudfront.net';

/**
 * The page a person sees in a browser: at `/`, and at the MCP endpoint itself when it's opened without a token
 * (that answer is still the bare 401 Alexa+ expects; only the body is human-readable).
 */
export function landingPage(opts: { atEndpoint?: boolean } = {}) {
  const endpoint = `${config.publicUrl}${MCP_PATH}`;
  const note = opts.atEndpoint
    ? `<p class="note">You opened the MCP endpoint in a browser. It's working: it answers <b>401</b> because Alexa+ and other MCP clients call it with an access token from account linking, not from a browser tab. Here's how to try it.</p>`
    : '';
  const demo = config.demoMode
    ? `<p>This copy runs in <b>demo mode</b>: anyone can link the demo family. Maya's stories are pre-made and replayed instantly; a child you add ("make tonight's story for Zara, she's six…") gets a real story made with the paid models, within a small shared daily quota.</p>
<p>Demo family (fictional test account, prefilled on the consent page): <code>parent@example.com</code> / <code>bedtime</code></p>`
    : '';
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Once Upon Tonight</title>
<style>
  body { font-family: system-ui, -apple-system, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 16px; line-height: 1.6; color: #1d1b2e; background: #faf8f3; }
  h1 { margin-bottom: 4px; } h2 { margin-top: 28px; font-size: 1.15rem; }
  code { background: #ece8f7; padding: 1px 5px; border-radius: 4px; font-size: .92em; word-break: break-all; }
  pre { background: #1d1b2e; color: #f4f1ff; padding: 12px 14px; border-radius: 8px; overflow-x: auto; font-size: .88em; }
  .note { background: #fff4d6; border: 1px solid #f0d58a; padding: 10px 14px; border-radius: 8px; }
  a { color: #4b3bb5; }
</style>
<h1>🌙 Once Upon Tonight</h1>
<p>An Alexa+ add-on, built as an MCP server, that turns a child's day into tonight's illustrated, narrated, choose-your-path bedtime story, and remembers the story world for tomorrow night.</p>
${note}
<p><a href="${TRY_IT}"><b>Try it in your browser</b></a> · <a href="https://youtu.be/Lgh42f-NPUk">Watch the 3-minute demo</a> · <a href="https://github.com/PRIEST099/once-upon-tonight">Code</a> · <a href="https://github.com/PRIEST099/countertop">Countertop simulator</a></p>

<h2>MCP endpoint</h2>
<p><code>${endpoint}</code> (Streamable HTTP, spec 2025-11-25, OAuth 2.1 with PKCE S256)</p>
${demo}

<h2>Try it</h2>
<p><b>Easiest: <a href="${TRY_IT}">${TRY_IT}</a></b>. It's a hosted copy of Countertop, an open-source Alexa+ style simulator, already pointed at this endpoint. Press <b>Link add-on</b>, allow, then type or hold Space and say "Make tonight's story about her first swimming lesson", "Read my bedtime story", or "How did bedtime go last night?".</p>
<p><b>Quick check from a terminal.</b> Countertop is an open-source Alexa+ style simulator. Its headless check tests account linking against the published Alexa+ requirements:</p>
<pre>git clone https://github.com/PRIEST099/countertop
cd countertop && npm install
npm run check -- ${endpoint}</pre>
<p><b>Your own Countertop.</b> Run <code>npm run dev</code> in Countertop and open <code>http://localhost:5310</code>. Paste the endpoint above, press <b>Link add-on</b> and allow. Then say or type "Make tonight's story about her first swimming lesson", "Read my bedtime story", or "How did bedtime go last night?". Countertop uses Claude on Amazon Bedrock to play Alexa, so this part needs AWS credentials with Bedrock and Polly in us-east-1.</p>
<p><b>Run it yourself.</b> See the <a href="https://github.com/PRIEST099/once-upon-tonight#readme">README</a>. <code>AI_MODE=mock</code> runs the server without any AWS account.</p>

<h2>For MCP clients</h2>
<ul>
  <li>Protected resource metadata: <a href="/.well-known/oauth-protected-resource">/.well-known/oauth-protected-resource</a></li>
  <li>Authorization server metadata: <a href="/.well-known/oauth-authorization-server">/.well-known/oauth-authorization-server</a></li>
</ul>
<p><a href="/privacy">Privacy</a> · <a href="/terms">Terms</a></p>
</html>`;
}

/** A person's browser, as opposed to an MCP client: a plain GET that asks for HTML and carries no token. */
export const isBrowserVisit = (method: string, accept: string | undefined, authorization: string | undefined) =>
  method === 'GET' && !authorization && /text\/html/.test(accept ?? '');
