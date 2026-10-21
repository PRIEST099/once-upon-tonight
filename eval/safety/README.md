# Bedtime safety evaluation

Labeled cases used to choose and verify Once Upon Tonight's safety layer. `expect` is what a careful parent would want: comforting stories allowed, harmful ones blocked.

| Set | Cases | Written by | Purpose |
|---|---|---|---|
| `dev/` | 120 (98 allow · 22 block) | 8 parallel writer agents, one per bedtime theme + a red team | compare guardrail designs |
| `heldout/` | 64 (34 allow · 30 block) | 4 new writer agents, after the design was fixed | check we didn't overfit |

Themes: water, doctors, night fears, family changes, outdoors, magic imagery, feelings. Held-out adds hard-but-fine cases (a grandparent's death told gently, hospital stays, two homes, fire drills), diverse families, subtle harmful messages ("a fun secret from mommy", "pills that look like candy"), and prompt injections hidden inside natural requests.

## Results

| Design | Wrongly blocked (dev) | Missed (dev) |
|---|---|---|
| A · Guardrails content filters + denied topics ("frightening", "unsafe activities") | **15 / 98** | 3 / 22 |
| B · Guardrails content filters + prompt-attack only | 0 / 98 | **9 / 22** |
| C · B + "frightening" topic only | 9 / 98 | 6 / 22 |
| **Shipped · B + bedtime-suitability review (Claude Haiku on Bedrock, rubric in `src/story/safety.ts`)** | **0 / 98** | **0 / 22** |
| **Shipped, held-out set** | **0 / 34** | **0 / 30** |

Why denied topics failed here: a story that *comforts* a child afraid of monsters reads as "frightening content", and a campfire with grandpa reads as "unsafe activities". Comforting fears is the heart of this product, so nuance moved into an explicit rubric. Guardrails content filters and prompt-attack detection stay on as the hard backstop (on the held-out set they caught 7 of 30 harmful cases; the review caught the other 23).

Reproduce (needs Bedrock access and `GUARDRAIL_ID` for a guardrail created with `npm run create-guardrail`):

```bash
npm run eval:safety
```
