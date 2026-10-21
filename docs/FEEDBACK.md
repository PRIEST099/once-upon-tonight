# Product feedback

Honest feedback on every tool, API and SDK we used to build **Once Upon Tonight** (Alexa+ track) and **Countertop** (open-source simulator). Each section covers what we used it for, what worked, what needs work, onboarding (zero to hello world), and whether we'd build with it again. Detailed reproductions are in the [friction log](FRICTION_LOG.md).

---

## Alexa+ MCP add-ons (docs, design guide, auth requirements, MCP Apps support)
- **Used for:** the target platform. We built to the published requirements: Streamable HTTP, MCP 2025-11-25, OAuth 2.1 + PKCE S256 with Protected Resource Metadata and a bare 401, refresh tokens, under 500 ms per call, MCP Apps visuals, an `addon.json` manifest, and the design guide (768×480 base, dark mode, 48 px touch targets, spoken text under 30 s).
- **What worked:** Choosing **MCP** is the right call: we could build and test the whole add-on with open tooling, and the same standards-based server is portable to any MCP Apps host. The **design guide** is genuinely useful: the "spoken text equals on-screen text" and "auto-scroll in sync with TTS" rules directly inspired our word-by-word read-along. The **auth page** is precise. "Return 401 without WWW-Authenticate", "S256 or account linking fails" and "resource must match exactly" saved us hours.
- **Needs work:**
  1. **Access.** The console, CLI and web simulator show "Coming Soon" and are partner-only. Only the add-ons home page and the hackathon FAQ say so; the quickstart and simulator pages read as if anyone can use them.
  2. **The `alexa-ai` name on public npm** belongs to an unrelated third-party package. That's a real supply-chain risk for anyone who copies `npm i -g alexa-ai`.
  3. **MCP Apps host capabilities are undocumented.** We couldn't find whether the webview supports app→server `tools/call`, `ui/update-model-context`, display-mode requests or HTML5 audio/autoplay. We designed defensively, but a capabilities table (like ChatGPT's and Claude's) would remove guesswork.
  4. **Contradictions:** `_meta.ui` on the tool result vs. the tool definition, protocol versions in examples (2025-03-26 / 2025-06-18 / 2025-11-25), and Echo Show 8 at 960×600 vs. 1280×800.
  5. **Family experiences:** "must not target children" rules out a whole category of Echo Show moments (bedtime, homework, chores) unless reframed as parent-operated. A documented parent-supervised path would unlock it.
- **Onboarding:** reading the docs took about 45 minutes. Hello world on the real platform was impossible, because there's no access. With our own simulator we went from zero to a linked, rendering add-on in about 3 hours.
- **Would we build with it again?** **Yes.** MCP plus MCP Apps is the most open voice-assistant integration model we've used. We'd ship this to real families the day the toolkit opens.

## Model Context Protocol: TypeScript SDK v2 (`@modelcontextprotocol/server`, `/node`, `/client`)
- **Used for:** the MCP server (stateless Streamable HTTP, per-request server scoped to the linked family through `ctx.http.authInfo`) and the MCP client in Countertop's browser agent loop.
- **What worked:** Stateless mode with `enableJsonResponse` is easy to reason about and fast (3–20 ms per call). Negotiating 2025-11-25 down to older versions just works. `req.auth` → `ctx.http.authInfo` is a clean way to scope tools per account.
- **Needs work:** The README mentions spec 2026-07-28 while `LATEST_PROTOCOL_VERSION` is 2025-11-25, which is confusing. Most tutorials, including Alexa+ samples, still show v1 `@modelcontextprotocol/sdk`. The bearer-auth helpers always send `WWW-Authenticate`, which conflicts with Alexa+; an option to omit it would help.
- **Onboarding:** about 20 minutes to a running server.
- **Would we use it again?** Yes.

## MCP Apps (`@modelcontextprotocol/ext-apps` v2: server helpers, App, AppBridge)
- **Used for:** the storybook view (App), registering UI tools and resources (`registerAppTool`/`registerAppResource`), and Countertop's host (AppBridge + double-iframe sandbox).
- **What worked:** The protocol is well designed. Tool input/result notifications, `visibility: ["app"]` for view-only tools, and `updateModelContext` let the assistant know what page is on screen. `examples/basic-host` was the best reference for building a host.
- **Needs work:** No packaged host implementation, so every host re-implements the sandbox proxy. Autoplay delegation (`allow="autoplay"`) through the double iframe isn't mentioned, and media apps need it.
- **Would we use it again?** Yes. It's the reason one UI works across hosts.

## Amazon Bedrock: Converse API with Claude Sonnet 4.6 (writer) and Claude Haiku 4.5 (Countertop assistant)
- **Used for:** writing each branching story as structured JSON via a **forced tool call** (`toolChoice: {tool}`), and as the Alexa+-style reasoning layer that picks MCP tools in Countertop.
- **What worked:** Forced tool use gives reliable structure. Converse's tool format maps one-to-one onto MCP tool schemas, so turning `tools/list` into a Bedrock `toolConfig` was about 10 lines. Haiku answers tool-routing turns in about 1.6–2 s.
- **Needs work:** `list-foundation-models` lists Claude Sonnet 5.5 and Opus 5.5 as `ACTIVE`, but `Converse` answers `AccessDeniedException … not available for this account`. There's no way to list only *entitled* models. Once, a long story came back without its pages (tool input incomplete); we now allow more output tokens, normalize nested fields that arrive as JSON strings, and retry once.
- **Onboarding:** about 10 minutes once credentials worked.
- **Would we use it again?** Yes.

## Amazon Bedrock Guardrails (`CreateGuardrail`, `ApplyGuardrail`)
- **Used for:** content filters, a prompt-attack filter and a profanity list on the parent's request (INPUT) and on every story page (OUTPUT), created by script.
- **What worked:** `ApplyGuardrail`, decoupled from model calls, is exactly right for multi-step pipelines. Content filters plus prompt-attack detection had **zero false positives** on 98 gentle bedtime pages and requests, and they reliably caught prompt injection.
- **Needs work:** **Denied topics weren't usable for children's content.** We measured three designs on 120 labeled cases written per theme ([eval](../eval/safety/README.md)):
  - Denied topics ("frightening content", "unsafe activities") blocked **15 of 98** gentle stories. A story *comforting* a child afraid of monsters under the bed was flagged as frightening. A campfire with grandpa, a bike with a helmet, and even *"golden sparkles floated up like tiny stars"* were flagged as unsafe.
  - Joining a whole story into one `ApplyGuardrail` call blocked stories whose pages each passed alone.
  - We solved it by keeping Guardrails as the hard backstop (filters only) and adding a rubric review by Claude Haiku on Bedrock. Together that's **184/184 correct, including a 64-case held-out set**.
  - We'd love a children's-content preset, topic definitions that support "allowed context" examples, and a top-level reason string in `ApplyGuardrail` responses (digging through `assessments` to learn which policy fired is tedious).
- **Would we use it again?** Yes, as one layer of several.

## Amazon Bedrock: Stability AI SD3.5 Large and Stable Image Core (image generation)
- **Used for:** a watercolor illustration for every story page (us-west-2).
- **What worked:** SD3.5 Large follows multi-character prompts well. Once we described characters by appearance (never by name), the hero and sidekick appeared consistently on every page.
- **Needs work:** **Amazon Nova Canvas isn't available in any region we checked**, so there's no first-party image model, and text-to-image Stability models are only in us-west-2, which forced a second regional client. SD3.5 throttled at 4 concurrent requests (429), and default quotas aren't visible on the model card. Stable Image Core drops secondary subjects ("a girl and her dragon" → just the girl).
- **Would we use it again?** Yes, with a first-party Amazon option preferred if it returns.

## Amazon Polly (neural "Danielle"; speech marks; neural "Joanna" for the Countertop assistant)
- **Used for:** story narration plus **word speech marks** for read-along highlighting, and the assistant's spoken replies in Countertop.
- **What worked:** Speech marks are the hidden gem here; they made the read-along feature possible in an afternoon. Neural voices are warm and fast, and cheap enough for a family product.
- **Needs work:** The **generative** engine rejects word speech marks (found only at request time); there's no engine × feature matrix. Offsets are **UTF-8 byte offsets**, which silently break highlighting around curly quotes and em dashes in JavaScript; we wrote a byte→char mapper. SSML prosody support differs per engine.
- **Would we use it again?** Absolutely.

## AWS CLI `aws login`
- **Used for:** getting credentials as a first-time AWS developer.
- **What worked:** `aws login --remote` (cross-device code flow) worked first time.
- **Needs work:** The default same-device flow showed "400 Bad Request … outdated link, clear your cookies" twice before we found `--remote`.

## Amazon Devices Builder Tools / Vega
- Not used. We chose the Alexa+ track because it needs no hardware.
