# Friction log

Every entry is something we actually hit while building **Once Upon Tonight** (Alexa+ track) and **Countertop** (open-source simulator) during the submission window.
Format per entry: task · steps · expected vs. actual · severity · workaround · suggestion.

Severity scale: **Blocker** (couldn't proceed as designed) · **High** (hours lost or design changed) · **Medium** (real confusion, worked around) · **Low** (papercut).

---

### 1. Alexa+ add-on console and web simulator show "Coming Soon"
- **Task:** Deploy our MCP server as an Alexa+ add-on and test it in the official web simulator.
- **Steps:** Signed in to developer.amazon.com → opened `/alexa/console/ask/addons` and `/alexa/console/ask/addons/simulator`, both linked from the "Test in the Web Simulator" docs page.
- **Expected:** An add-ons list / simulator, or a clear "request preview access" path.
- **Actual:** A blank page reading "Coming Soon". The MCP Toolkit quickstart, the simulator page and the CLI reference don't say the tools are partner-only; only the add-ons home page and the hackathon FAQ do.
- **Severity:** Blocker (for the official path)
- **Workaround:** Built our own spec-faithful simulator ([Countertop](../../countertop)); the hackathon FAQ confirms this is accepted.
- **Suggestion:** Put a "Private preview: select partners only" banner on every MCP Toolkit page and in the console itself. Even better, give hackathon participants a time-boxed simulator allowlist.

### 2. `alexa-ai` on public npm is an unrelated third-party package
- **Task:** Install the Alexa AI CLI mentioned in the quickstart (`alexa-ai configure`, `alexa-ai deploy`).
- **Steps:** `npm search alexa-ai`
- **Expected:** Amazon's CLI, or nothing.
- **Actual:** The top result is `alexa-ai@2.6.0`, an unrelated "AI engine for the Alexa WhatsApp bot". The real `@alexa-ai/cli` only lives in a private CodeArtifact registry.
- **Severity:** Medium (supply-chain risk: a developer copying `npm i -g alexa-ai` installs a stranger's code)
- **Workaround:** Didn't install anything; confirmed the real package name in the setup docs.
- **Suggestion:** Show the exact scoped install command (`npm i -g @alexa-ai/cli` + registry) on every page that shows `alexa-ai` commands, and consider reserving the unscoped name.

### 3. The Alexa+ 401 requirement conflicts with MCP SDK bearer-auth helpers
- **Task:** Protect `/mcp` so Alexa+ account linking works.
- **Steps:** Tried `requireBearerAuth` from `@modelcontextprotocol/express`.
- **Expected:** A drop-in middleware that satisfies Alexa+.
- **Actual:** Alexa+ docs require a bare `401` **without** `WWW-Authenticate`. The SDK helpers always add the header, by design per RFC 6750 and MCP.
- **Severity:** Medium
- **Workaround:** Hand-wrote a resource-server guard with an `ALEXA_STRICT_401` flag (discovery goes through `/.well-known/oauth-protected-resource`, which MCP 2025-11-25 also allows).
- **Suggestion:** Either tolerate the header (ignoring it is fine) or publish a small official "Alexa+ auth" middleware. It is the single most error-prone part of onboarding.

### 4. Where does `_meta.ui.resourceUri` go: tool definition or tool result?
- **Task:** Make our storybook UI render on Echo Show.
- **Steps:** Read the MCP Toolkit overview ("renders your custom visuals as long as you have resourceUri defined in the tool response"), the MCP Apps spec and the Local Inspector docs.
- **Expected:** One location, as in the MCP Apps spec (on the tool definition in `tools/list`).
- **Actual:** The Alexa+ example puts `_meta.ui` (with `invoking`/`invoked` strings) on the **tool result**; the MCP Apps standard and the Local Inspector read it from the **tool definition**.
- **Severity:** Medium
- **Workaround:** Put it in both places.
- **Suggestion:** State explicitly that both are read, and which wins.

### 5. Protocol version inconsistencies in the Alexa+ docs
- **Task:** Choose which MCP protocol version to target and test against.
- **Steps:** Compared the MCP Toolkit overview, the client-lifecycle page (example `initialize` request) and the Local Inspector docs.
- **Expected:** One version used consistently in the docs and examples.
- **Actual:** The docs say "supports 2025-11-25", the documented initialize payload sends `"protocolVersion": "2025-03-26"`, and the Local Inspector uses `2025-06-18`.
- **Severity:** Low
- **Workaround:** Negotiate any supported version (the MCP SDK does this).
- **Suggestion:** Align the example payloads with the supported version.

### 6. Undocumented MCP Apps bridge capabilities on Alexa+
- **Task:** Let the storybook turn pages and play narration on screen.
- **Steps:** Searched the MCP Toolkit pages, the design guide (display modes, layout, components) and the BYO MCP appendix for which View→Host requests the Alexa+ webview supports.
- **Expected:** A host-capabilities table (tools/call from the UI, model-context updates, display modes, media/autoplay).
- **Actual:** The docs don't say whether the Alexa+ webview supports app→server `tools/call`, `ui/update-model-context`, `ui/request-display-mode`, or HTML5 audio playback/autoplay. They only give a codec list.
- **Severity:** High (it shapes the whole UI design)
- **Workaround:** Defensive design. The tool result carries the full story, so page turns and choices work locally; every server call is best-effort; voice works without the UI; there's a "tap to start" fallback if autoplay is blocked.
- **Suggestion:** Publish a host-capabilities table for the Alexa+ MCP Apps host, like ChatGPT's and Claude's.

### 7. Conflicting Echo Show 8 viewport sizes
- **Task:** Size the storybook for Echo Show 8.
- **Steps:** Compared the viewport-profile table in the BYO MCP appendix with the visual foundations page of the design guide.
- **Expected:** One size per device.
- **Actual:** The viewport profile table says Echo Show 8 is 960×600; the visual foundations page treats Echo Show 8/15 as 1280×800.
- **Severity:** Low
- **Workaround:** Designed on a 768×480 base with one scale factor (`--u = 100vw / 768`), so either size works.
- **Suggestion:** Fix the table, or say which one the simulator uses.

### 8. Family/kids experiences vs. the "must not target children" policy
- **Task:** Design a bedtime-story experience, a classic Echo Show use case.
- **Steps:** Read the add-on policy requirements (Child Safety) and searched for an Amazon Kids or parent-supervised path for add-ons.
- **Expected:** A documented way to build family experiences that a parent controls.
- **Actual:** Add-on policy says add-ons "must not be targeted towards children" and must never collect their data, and the docs give no Amazon Kids path for add-ons.
- **Severity:** High (it changed the product design)
- **Workaround:** A parent-operated design: the parent links the account and sets the hero's nickname and preferences, no child accounts, no voice data stored, and deletion in one confirmed request (`forget_story_world`).
- **Suggestion:** Publish a "family experiences" guideline or a parent-supervised category for add-ons.

### 9. No Amazon first-party image model available in Bedrock
- **Task:** Illustrate story pages with Amazon Nova Canvas.
- **Steps:** `aws bedrock list-foundation-models` in us-east-1, us-west-2, eu-west-1, ap-northeast-1.
- **Expected:** `amazon.nova-canvas-v1:0` (or a successor) available, as in the Nova docs.
- **Actual:** No `nova-canvas` (or any Amazon text-to-image model) in any of them. Only Stability models, and text-to-image Stability models only in us-west-2.
- **Severity:** Medium
- **Workaround:** Stability SD3.5 Large on Bedrock in us-west-2, with a second Bedrock client for that region.
- **Suggestion:** A deprecation notice with a recommended replacement on the Nova Canvas docs pages.

### 10. Models listed as ACTIVE but "not available for this account"
- **Task:** Use the newest Claude models for story writing.
- **Steps:** `list-foundation-models` shows `anthropic.claude-sonnet-5-5` and `claude-opus-5-5` as `ACTIVE`; `list-inference-profiles` lists `us.anthropic.claude-sonnet-5-5`; then called `Converse` with that profile.
- **Expected:** A listed, ACTIVE model with an inference profile can be called, or the listing says it isn't enabled.
- **Actual:** `Converse` → `AccessDeniedException: … is not available for this account`. `aws bedrock-runtime converse` printed an empty result for some models instead of the error when using `--query`.
- **Severity:** Medium
- **Workaround:** Probed models one by one; settled on Claude Sonnet 4.6 (writer) and Claude Haiku 4.5 (assistant).
- **Suggestion:** Add an `entitled: true/false` field to `list-foundation-models`, or a `--by-access` filter.

### 11. Polly generative voices don't support word speech marks
- **Task:** Word-by-word read-along highlighting (great for early readers).
- **Steps:** `SynthesizeSpeech` with `Engine: generative`, `VoiceId: Ruth`, `OutputFormat: json`, `SpeechMarkTypes: [word]`.
- **Expected:** Word timings for the most natural voices, or a documented engine/feature matrix.
- **Actual:** `ValidationException: The selected speech mark type - word - is not supported for this engine: generative`. Only discoverable at request time.
- **Severity:** Low
- **Workaround:** Neural engine (same "Danielle" voice) for audio and marks. Long-form also supports marks but costs about 6× more.
- **Suggestion:** Add an engine × feature matrix to the `SynthesizeSpeech` docs.

### 12. Polly speech-mark offsets are UTF-8 byte offsets
- **Task:** Highlight the exact word being read in the storybook.
- **Steps:** Used each mark's `start`/`end` with `String.slice` on the page text.
- **Expected:** Offsets that index the string we sent.
- **Actual:** `start`/`end` are byte offsets into the UTF-8 input, so curly quotes and em dashes (common in story text) shift highlighting in JavaScript, which uses UTF-16 indexes.
- **Severity:** Low
- **Workaround:** Built a byte→char index map (`narrator.ts`).
- **Suggestion:** Call it out prominently in the speech marks docs, or add a `charStart`/`charEnd` option.

### 13. SD3.5 Large throttles at 4 concurrent requests
- **Task:** Paint 6–9 illustrations in parallel.
- **Steps:** `InvokeModel` on `stability.sd3-5-large-v1:0` (us-west-2) with 4 concurrent requests.
- **Expected:** Default quotas sized for a few concurrent images, or the limit shown on the model card.
- **Actual:** `ThrottlingException (429)` after 3 SDK retries; the whole story failed.
- **Severity:** Medium
- **Workaround:** One image at a time with exponential backoff, narration recorded in parallel, and the previous illustration reused if one fails.
- **Suggestion:** Show default on-demand RPM/concurrency for image models on the model card.

### 14. `aws login` same-device flow → "400 Bad Request … outdated link"
- **Task:** Get CLI credentials quickly (new `aws login` command).
- **Steps:** `aws login --region us-east-1` opened the browser sign-in.
- **Expected:** Sign in, then return to the terminal with credentials.
- **Actual:** "400 Bad Request. You may have typed the address incorrectly or you may have used an outdated link. Please clear your cookies…" Re-running produced the same thing.
- **Severity:** Medium (it blocked the first 30 minutes for a first-time AWS developer)
- **Workaround:** `aws login --remote` (cross-device code flow) worked first time.
- **Suggestion:** Detect the failing case and tell the user to try `--remote`, or a private window.

### 15. MCP TypeScript SDK v1 vs v2 mismatch across docs
- **Task:** Build the server and MCP Apps view with the current SDKs.
- **Steps:** Installed `@modelcontextprotocol/ext-apps@2` next to the `@modelcontextprotocol/sdk` used in the Alexa+ samples.
- **Expected:** The samples' SDK works with the current MCP Apps package.
- **Actual:** `@modelcontextprotocol/ext-apps@2` requires the **v2** split packages (`@modelcontextprotocol/server`, `/node`, `/express`, `/client`), while the Alexa+ docs and most MCP tutorials still show v1 `@modelcontextprotocol/sdk`. The v2 server README mentions spec "2026-07-28" while its `LATEST_PROTOCOL_VERSION` is `2025-11-25`.
- **Severity:** Low
- **Workaround:** Used v2 throughout, checked the exported constants.
- **Suggestion:** Note the SDK major version in Alexa+ samples.

### 16. Hackathon AWS credits ran out mid-event
- **Task:** Get the $150 hackathon AWS credits to cover Bedrock usage.
- **Steps:** Opened the Resources page to find the request form.
- **Expected:** A credit request form, as the rules describe.
- **Actual:** The Resources page notes credit codes ran out on Oct 7, two weeks before the deadline.
- **Severity:** Low (for us); higher for students
- **Workaround:** Stayed under ~$10 with cheap defaults: Haiku for the assistant, neural Polly, short stories, and a `mock` mode that needs no AWS.
- **Suggestion:** Reserve a pool for late joiners, or document a "free" path (e.g. mock models).

### 17. Guardrails denied topics flag comforting bedtime stories (15% false positives)
- **Task:** Block frightening or unsafe content in children's stories with Bedrock Guardrails denied topics.
- **Steps:** Created "Frightening content" and "Unsafe activities" denied topics, then tested on a 120-case labeled corpus (7 bedtime themes + a red team).
- **Expected:** Gentle stories pass; scary or unsafe ones are blocked.
- **Actual:**
  - 15 of 98 gentle cases were blocked. Comforting a fear of the dark or of monsters was flagged as "frightening". A campfire with grandpa, a bike with a helmet, medicine measured by a parent, and "golden sparkles floated up like tiny stars" were flagged as "unsafe activities".
  - Narrowing the definitions didn't fix it.
  - Checking a whole story as one text blocked stories whose pages passed individually.
  - It surfaced during our demo recording: a gentle swimming-lesson story was rejected twice and the take was lost.
- **Severity:** High (it broke the core use case: comforting a child's worries)
- **Workaround:** Guardrails kept for content filters + prompt attack (0 false positives), plus a rubric-based review by Claude Haiku on Bedrock. That scores 184/184 on dev + held-out sets ([eval/safety](../eval/safety/README.md)).
- **Suggestion:** "Allowed context" examples for denied topics, a children's-content preset, and a confidence score for topic matches so builders can tune the threshold.
