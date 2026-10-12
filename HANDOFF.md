# HANDOFF — Assist AI Telegram bot (chat_assistai_bot)

Written Oct 2026; updated at the end of the "file editing, Phases 2 + 3" session. This file is the
**source of truth for continuing the project**: it says what exists, what was decided,
what is verified vs. not, and what the next phases are. Read it before changing anything.
(README.md documents each feature in detail; this file is the map and the to-do list.)

---

## 1. How to resume in a new conversation

1. Upload this project zip (or `HANDOFF.md` + the files you want changed).
2. Say what you want next, e.g. *"Here are the errors from testing file editing live: …"* or pick
   an item from section 7 (open items / not-done lists).
3. Ask for an updated zip at the end. The assistant should: run the ESLint `no-undef`
   check and the module link-check from section 9 before delivering (a plain
   `node --check` does NOT catch variables used outside their block — that bug nearly
   shipped once).

## 2. What the product is

A Telegram bot with two surfaces that share one Neon (Postgres) database:

- **DM bot** — `api/telegram-webhook.js` (a large standalone file with its own system
  prompt and provider calls; commands: /start /think /image /file /invite /upgrade /plans).
- **Mini app** — `public/miniapp/index.html` (single-file UI) + `api/miniapp/*.js`
  (chats, messages, plans, usage, settings, transcribe, web-search, users, memories,
  blob-upload, create-invoice). Chat threads with history, model tiers, search, think, voice.

Deployed on **Vercel (Hobby)**. **Hobby allows 12 serverless functions and the project is
exactly at 12** (webhook + 11 under api/miniapp) — never add a new file under `api/`; put
new endpoints inside an existing file (that is why trials live in `plans.js`).
`vercel.json` sets maxDuration 60 for webhook/messages/transcribe, 30 for chats.

## 3. Map of the code

| Area | Files |
|---|---|
| AI providers & chains | `lib/ai.js` (Standard/Flash/Max/Extra chains, vision chain, system prompt, think, review), `lib/providerBudget.js` (shared-budget guards), `lib/identity.js` (who the assistant says it is) |
| Limits & plans | `lib/limits.js` (TIER_LIMITS, TRIAL_KINDS, rolling-window checks, reset-time helpers, file/Max/Extra caps), `lib/subscriptions.js`, `lib/trials.js`, `lib/referrals.js` |
| Images | `lib/imagegen.js` (Cloudflare FLUX -> Pollinations), `lib/brandImage.js` + `lib/badgeData.js` (Assist AI badge), `lib/imageResize.js` |
| Files in | `lib/fileTypes.js`, `lib/attachments.js`, `lib/ocr.js` (Mistral OCR) |
| Files out | `lib/fileGen/` — `detect.js`, `index.js` (orchestrator), `markdown.js`, `docx.js`, `pdf.js`, `fontData.js` |
| Files edited (NEW, Phases 2+3) | `lib/fileGen/editDetect.js`, `lib/fileGen/edit/` — `index.js` (editFile), `text.js`, `xlsx.js`, `docx.js` (in-place Word), `util.js`; wired in `api/miniapp/messages.js` (`editAndSaveFile`) and `api/telegram-webhook.js` (`handleDmEdit`); model instructions `edit_*` in `FILE_TASK_INSTRUCTION` (`lib/ai.js`) |
| Health check (NEW) | `lib/health.js` (+ `providerCatalog()` exported from `lib/ai.js`), owner-only `/health [live]` in `api/telegram-webhook.js`, `scripts/check-env.mjs` (`npm run check` / `check:live`) |
| Tests (NEW) | `tests/phase1-create.test.mjs`, `tests/phase23-edit.test.mjs`, `tests/security.test.mjs`, `tests/health.test.mjs` |
| Voice / search | `lib/transcribe.js`, `lib/search.js` |
| DB | `db/schema.js`, `db/setup.sql`, `db/migrate_*.sql` |
| UI | `public/miniapp/index.html` (menu drawer, Plan sheet, usage-bar footer, image viewer, download cards) |

## 4. Deploy checklist

- `npm install` (new deps: docx, marked, pdf-lib, @pdf-lib/fontkit).
- **Migrations** (run in Neon SQL editor, in order, skipping ones already applied):
  v2 … v14 as before, and the newest: **`db/migrate_plan_trials_v15.sql`** (creates
  `plan_trials`; required before trials work). File creation needs NO migration (it
  uses `usage_events` with kind `file_created`, like the other counters).
- Env vars — see the full table in section 8. Redeploy after changing any.
- Cloudflare image/text and Mistral need real keys; first real call is the real test.

## 5. Decisions already made (do not re-litigate without asking)

- **Token allowance** is a rolling window (`TOKEN_WINDOW_DAYS`, default 30): Free 300K,
  Pro 1.8M, Premium 4.5M. *Open question:* switch to daily (proposed Free 15K, Pro 90K,
  Premium 225K; trials Pro-promo 35K, Premium-trial 50K) — owner had not answered.
- **Messages:** Free 15 per rolling 24h; Pro/Premium per rolling hour. All windows are
  rolling (no midnight reset); a full bar shows a live countdown to when room frees up.
- **Trials:** Pro promo = 14 days for the first 100 *activations*; Premium trial = 3 days,
  once per account; clock starts on tap; `TRIAL_DAILY_START_CAP` 20/day; Max/Extra per-day
  caps and extra tokens in `TRIAL_KINDS`. Menu item **Plan** sits below Settings.
- **Usage UI:** thin bars in the menu *footer* (Messages, Tokens, plus a trial line);
  amber at 80%, red + countdown when full.
- **Channel bonus removed.** `/start` now ends with a join prompt + button
  (`TELEGRAM_CHANNEL_USERNAME`). Deliberately *not* a hard gate (owner said "or something
  like mandatory"; a soft prompt was built — a hard gate is possible but not built).
- **Identity:** first person, "Assist AI"; never names providers/models (`lib/identity.js`).
- **Images:** Cloudflare FLUX.1-schnell first (neuron-guarded), then Pollinations Flux 1024,
  then Pollinations defaults (its anonymous default is `sana` @768 — soft, garbled text).
  Assist AI badge bottom-LEFT; Pollinations' own watermark is NOT removed/covered.
  Flash only gets the `[GENERATE_IMAGE]` instruction when the message plausibly asks for a
  picture (a misfire cost a free user an image once).
- **Provider budgets:** Cloudflare 10K neurons/UTC-day, guard stops at 9,000
  (`CF_NEURON_DAILY_CAP`); Mistral free = $10/month credit, guard stops at $8.50
  (`MISTRAL_MONTHLY_BUDGET_USD`). Mistral ids are pinned, not `-latest`
  (`mistral-large-2512` has 250K tok/min; `large-4` only 20K). Pixtral is retired/removed.
- **Logo:** `public/logo.png`/`logo.jpg` (purple-orange chat bubble + sparkle). NOTE
  `public/logo.jpg` is really a 942 KB PNG; a 13 KB web-sized replacement was supplied.
  `public/iii.jpg` is the old logo and unused.
- **File creation limits (agreed):** Free 1/day, Pro 5, Premium 15 (+ site cap 150/day);
  the tokens a file uses count toward the token allowance; always the Standard chain.

## 6. What was built and how well it is verified

Verified = run in the sandbox with mocks/simulations. **Nothing has been run against live
Neon, Telegram, Cloudflare, Mistral or Pollinations** (the sandbox cannot reach them).

| Feature | State |
|---|---|
| Provider chains + budget guards | Built; cost math and guard logic tested; real Cloudflare/Mistral calls untested |
| Trials + Plan sheet | Built; DB logic read-reviewed, not run against Neon |
| Usage bars + countdown | Built; countdown index logic unit-checked; UI not run in Telegram |
| Join prompt / identity | Built; model wording untested live |
| Image viewer + Save (`tg.downloadFile`) | Built; behaviour inside Telegram untested |
| Images: Cloudflare FLUX + fallback + badge | Built; fallback/refusal paths simulated; badge verified visually |
| **File editing Phases 2 + 3** | Built: detection, text (full rewrite + patches), Excel ops, in-place Word, guards, limits wiring, mini app + DM. Verified in the sandbox with a MOCKED model on real files: 55 checks (tests/phase23-edit.test.mjs), edited .docx/.xlsx opened and rendered in LibreOffice. **Not run with a real model, Blob, Telegram or Neon** — expect first-contact bugs (model output format, Blob fetch, DM download). |
| **File creation Phase 1** | Built: detection (22 phrasings pass), Word + PDF rendering (verified by opening: mammoth text extraction, LibreOffice render, pdftoppm visual incl. Amharic), orchestrator (all formats, export mode, error paths, with a mocked model), limits, mini-app wiring, download card, DM `/file`. **Not run end-to-end with a real model, Blob upload, or Telegram.** |

## 7. Roadmap / phases

### File creation
- **Phase 1 — DONE.** Create HTML/Word/PDF/Markdown/text; export last reply;
  per-user + site limits; tokens counted; mini app + DM.
  *Small follow-ups not done:* show "files today" on the usage footer / `usage.js`;
  DM export of the previous reply (the DM has no saved history); PowerPoint output;
  cap PDF/Word length more cleverly; offer a "regenerate with changes" button.
- **Phase 2 — BUILT (untested live): edit an uploaded file and send it back.** Text/code/HTML/
  Markdown/CSV/JSON (whole-file rewrite up to ~8K chars, `{find,replace}` patches up to 30K) and
  Excel (JSON cell operations via `exceljs`; charts/pivots/macros refused). PDF/PowerPoint/images:
  explained, not edited. Counts as a file + message + tokens. Trigger: one editable attachment +
  edit verb, or `/file edit <change>` (mini app: also edits the latest file in the chat).
  *Not done:* PDF "rewrite as new Word/PDF" (needs text extraction), PowerPoint editing,
  "regenerate with changes" for created files, showing remaining file allowance.
- **Phase 3 — BUILT (untested live): in-place Word (.docx) editing** (`edit/docx.js`) exactly as
  designed: numbered paragraphs, JSON edits/deletes/insert_after by paragraph number, only
  `word/document.xml` touched. Locked paragraphs (fields, links, text boxes, equations, content
  controls, tracked changes); table-cell/section-break paragraphs are blanked rather than removed.
  *Not done:* headers/footers/text boxes, preserving mid-sentence formatting inside an edited paragraph.
- Not possible on Vercel: Word->PDF conversion (no LibreOffice), headless-browser HTML->PDF.

### Other open items (owner's call)
1. Daily token window instead of 30-day (numbers proposed in section 5).
2. Daily token ceilings for Pro/Premium (proposed 120K / 300K).
3. Voxtral Mini as a voice-to-text fallback (check the endpoint name first).
4. Mistral OCR page cap (~500 pages/month) — OCR draws on the same $10 credit.
5. Hard channel-join gate (needs the bot to be a channel admin).
6. Pollinations API key (free, enter.pollinations.ai) for stability / `nologo`.
7. Check the Gemini AI Studio limits page for an image model with a free quota.
8. Show remaining file allowance in the UI; Premium trial / promo marketing copy.
9. Drop the unused `channel_memberships` table (optional): `DROP TABLE IF EXISTS channel_memberships;`

## 8. Environment variables

**Core:** `DATABASE_URL`, `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `OWNER_CHAT_ID`,
`MINI_APP_URL`, `GROQ_API_KEY`, `GEMINI_API_KEY`.
**Optional providers (skipped when unset):** `OPENROUTER_API_KEY`, `MISTRAL_API_KEY`,
`CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` (both), `MODELSCOPE_API_KEY`, `ZAI_API_KEY`,
`CEREBRAS_API_KEY` (effectively unused), `TAVILY_API_KEY`, `SEARXNG_URL`,
`TELEGRAM_BOT_USERNAME` (invite links), `TELEGRAM_CHANNEL_USERNAME` (join prompt).
**Tunables (default):** `CF_NEURON_DAILY_CAP` (9000), `MISTRAL_MONTHLY_BUDGET_USD` (8.5),
`PRO_PROMO_SLOTS` (100), `TRIAL_DAILY_START_CAP` (20), `TOKEN_WINDOW_DAYS` (30),
`EXTRA_SITE_DAILY_CAP` (60), `FILE_SITE_DAILY_CAP` (150), `BOT_NAME` ("Assist AI"),
`CF_IMAGE_STEPS` (4).
**Model ids (defaults):** `CF_STANDARD_MODEL` `@cf/openai/gpt-oss-120b`, `CF_FLASH_MODEL`
`@cf/meta/llama-3.1-8b-instruct-fp8-fast`, `CF_VISION_MODEL` `@cf/google/gemma-4-26b-a4b-it`,
`CF_IMAGE_MODEL` `@cf/black-forest-labs/flux-1-schnell`, `MISTRAL_SMALL_MODEL`
`mistral-small-2603`, `MISTRAL_LARGE_MODEL` `mistral-large-2512`, `MISTRAL_14B_MODEL`
`ministral-14b-2512`, `MISTRAL_8B_MODEL` `ministral-8b-2512`.
**Automatic:** `BLOB_READ_WRITE_TOKEN` (connect Vercel Blob), `VERCEL_GIT_COMMIT_SHA`.

## 9. Test recipes (run before delivering any change)

```bash
npm install
# 1) catches variables used out of scope — node --check does NOT
npm i --no-save eslint@8
npx eslint --no-eslintrc --parser-options=ecmaVersion:2022 --parser-options=sourceType:module \
  --env node,es2022 --rule 'no-undef: error' lib api db
# mini-app script: extract the last <script type="module"> from public/miniapp/index.html
# to a .mjs file and lint it with  --env browser,es2022
# 2) every module must link (named imports checked at link time)
DATABASE_URL=postgres://u:p@localhost.invalid/db TELEGRAM_BOT_TOKEN=x OWNER_CHAT_ID=1 \
  node --input-type=module -e "await import('./lib/limits.js')"      # repeat per changed file
# 3) file rendering: build a docx/pdf from sample Markdown (include Amharic), open with
#    mammoth / `soffice --headless --convert-to pdf` / `pdftoppm -png` and LOOK at it.
```
Mock `fetch` (and pass `ask` into `createFile`) to simulate providers; remember a mocked
global `fetch` also intercepts the Neon HTTP driver.

**Edit tests:** `node --no-deprecation tests/phase23-edit.test.mjs` and
`node --no-deprecation tests/phase1-create.test.mjs` (mocked model, real files). For a visual check
of Word/Excel output use the sandbox-safe LibreOffice wrapper (`soffice.py --headless --convert-to pdf`)
then `pdftoppm -png`.

## 10. Lessons learned (avoid repeating)

- WOFF2 fonts through fontkit + subsetting produced garbled PDF glyphs; embed plain **WOFF**.
- Pollinations' default model/size is poor (`sana` 768); its errors are huge JSON — log, never show.
- Groq free (Oct 2026 tracker): gpt-oss-120b, gpt-oss-20b and Qwen3.8 27B each get 30 req/min, 1,000/day,
  8,000 tokens/min, 200,000 tokens/day — the per-minute limit is the real ceiling; the chain exists to spill over.
- **Free/hosted model ids churn.** The first real `/health live` (10 Oct 2026) found: Groq's llama-3.1-8b-instant
  shut down (16 Aug), OpenRouter's gpt-oss-120b:free and qwen2.5-vl:free withdrawn. Ids that change are now env vars
  (`GROQ_FLASH_MODEL`, `OPENROUTER_MODEL`, `OPENROUTER_VISION_MODEL`, plus the CF_*/MISTRAL_* ones); OpenRouter ids must end
  in `:free` or are ignored (a non-free id would bill). Run `/health` after any provider announcement.
- A model asked to flag image requests on every message misfires on small models — use
  keyword gates + explicit commands.
- Rolling windows: "resets at 12" is just messages sent ~24h earlier aging out.
- Never serve generated HTML inline from your own/Blob domain (phishing risk) — download only.
- Free-tier facts change fast (Mistral moved to $10 credits; Together/Gemini image free tiers
  unclear). Re-verify provider limits before relying on them.
- Models disagree about a file's final newline — normalise to what the original had, or a "no change"
  looks like a change (and vice-versa).
- `String.replace(find, text)` treats `$&`/`$1` in the new text as patterns — patches use slicing.
- Regex over WordprocessingML: count `<w:p>` nesting (text boxes nest paragraphs) and exclude
  self-closing / look-alike tags (`<w:p/>`, `<w:pPr>`, `<w:tcPr>`) or paragraph boundaries drift.
- Never delete the only paragraph of a table cell or one carrying `<w:sectPr>` — Word reports the
  file as corrupt. Blank it instead.
- Attachment URLs come from the client. Everything that downloads one goes through
  `fetchOwnBlob()` in `lib/safeUrl.js` (own Blob host only, https, no redirects, status checked,
  size-capped); the attachments array is rebuilt by `sanitizeAttachments()` before use/storage.
  Never call `fetch(a.url)` directly.

## Security hardening (Oct 2026 audit) — what was checked and changed
Checked and found sound: Telegram initData HMAC verification (constant-time, 24h expiry); every
`/api/miniapp/*` endpoint authenticates and scopes queries to the caller; chat ownership is enforced
on read/delete; invoice prices come from the server; chat bubbles render with `textContent`; no raw
SQL with user input (Drizzle parameterises).
Fixed:
- **SSRF / memory DoS** in `lib/attachments.js` (3 fetches of client URLs): now `fetchOwnBlob`
  (`lib/safeUrl.js`), download caps 25MB images / 30MB documents.
- **Unvalidated `attachments` array** stored in the DB: `sanitizeAttachments` (max 20, own-Blob URLs
  only, only url/name/type/bytes kept) — a bad one is a 400 `bad_attachments`.
- **Webhook secret** was skipped when `TELEGRAM_WEBHOOK_SECRET` was unset (anyone could forge
  updates, even "from the owner"): now constant-time compared, and in production (`VERCEL_ENV`)
  a missing secret refuses all calls (503 + log line). Set it and re-run setWebhook (README step 2).
- **Input caps** (mini app): message ≤ 30,000 chars (413), search query ≤ 500, memory/message
  content must be a string.
- **Frontend**: error text no longer goes through `innerHTML`; search-result links must be http(s).
- **One file at a time per person** (`claimFileSlot` / `releaseFileGenSlot` in `lib/limits.js`):
  the daily file count only moves after delivery, so simultaneous requests used to all pass the
  check. A passing `checkFileGenLimit` now claims an atomic 90s lease (a `file_pending` row in
  `usage_events` — no migration); every call site releases it after `recordFileGenUsage`. Verified on
  real PostgreSQL: 60 concurrent claims -> exactly 1 winner. Fails open on a DB error.
Known / not changed: Blob store is `access: "public"` (URLs are unguessable but not private);
`bytes` in usage accounting is the client's number; blob-upload doesn't force a path prefix.
Tests: `node --no-deprecation tests/security.test.mjs` (42 checks).

## Health check (Oct 2026)
`/health` (owner only) and `npm run check[:live]` run `lib/health.js`. Quick = free key/model-id validation;
live = one tiny "OK" per model (Gemini: only 3.5 Flash-Lite, never the 20/day model). It reads the model ids
from `providerCatalog()` in `lib/ai.js`, so adding a provider/model there is automatically covered; a NEW
provider type with a non-OpenAI-style API needs its own function in `lib/health.js`. Verified with a fake network
(54 checks) and the CLI against an empty environment; **not run against the real providers** — the first real
`/health live` is the real test (e.g. Cloudflare's token-verify/model-search endpoints, ModelScope/Z.ai `/models`
may behave differently than expected; those cases degrade to a ⚠️, never a false ✅).
Missing `VERCEL_ENV` is harmless: the webhook-secret rule also checks `NODE_ENV`.

### First real `/health live` run — what it found and what changed (10 Oct 2026)
Real problems fixed in the app: Groq fast model -> `openai/gpt-oss-20b` (reasoning_effort pinned to `low`); OpenRouter text/vision
-> Gemma 4 31B/26B `:free`; `cleanModelText()` in `lib/ai.js` strips gpt-oss control tokens (Cloudflare returned the literal text
`<|start|>assistant`) and treats an empty result as "no text" so the chain falls through.
Checker bugs fixed (it was too strict / too trusting): a Cloudflare catalog-search miss is now a warning (the 8B model still answered
live — probably deprecated); a model missing from a provider's list is re-checked at its own address before being called gone;
providers with a PUBLIC model list (ModelScope, Z.ai) are no longer shown as "key accepted" — only a live answer proves the key;
401/403 now show the provider's own message; live results are merged into the model's line; "Available now, for example: …"
suggestions for retired models; a "Needs attention" list at the end.
Still open (needs the owner): `TELEGRAM_BOT_USERNAME` didn't match the bot behind the token (invite links would point to the
wrong bot); ModelScope key returned 401; Mistral `mistral-large-2512` unverified (retest with the new check); SearXNG needs
`json` enabled in `search.formats`.

### Second real `/health live` run (10 Oct 2026, after the model fixes)
Green: Groq (gpt-oss-120b + gpt-oss-20b answer), Gemini, Cloudflare gpt-oss-120b + Gemma 4, Mistral Ministral 14B/8B, Tavily, DB, Blob, webhook.
Findings and what was done:
- **Mistral Large (Max mode) -> HTTP 403 "not available in your subscription tier".** The key works; the free plan can't use that model. Max mode
  silently falls through to the Standard chain until `MISTRAL_LARGE_MODEL` points at a model the plan can use (or the plan is upgraded). The checker
  now says "not allowed on your plan" (it wrongly said "key rejected") and lists what the key CAN list, bigger models first.
- The `mistral-small` / OpenRouter Gemma / Z.ai "rate-limited" warnings: Mistral's was caused by the check itself (4 parallel requests vs a ~2/min
  plan) -> Mistral live tests are now 2, strictly one at a time. 429s now carry the provider's message. Z.ai is tightly rate-limited by design.
- ModelScope 401 "Authentication failed ... valid ModelScope token" = the token itself is wrong (not account verification).
- SearXNG timed out (asleep on a free host). SearXNG is tried FIRST with a 9s timeout (`lib/search.js`), so while asleep every web search
  pays up to 9s before Tavily answers; its JSON output was also off in the first run. Recommended: unset `SEARXNG_URL` unless it is kept awake + fixed.
- Cloudflare `llama-3.1-8b-instruct-fp8-fast`: still answers; absent from the catalog search. Cloudflare's changelog (8 May 2026) says `-fast` variants
  stay active, so this is a watch item, not an outage. If it ever stops, `CF_FLASH_MODEL=@cf/meta/llama-3.3-70b-instruct-fp8-fast` still exists but costs
  ~6x the neurons per request.
- `TELEGRAM_BOT_USERNAME` still mismatched (needs the owner to change the env var).
- **Mistral Large follow-up.** The 403 is Mistral's own answer for the exact id `mistral-large-2512`; the owner pointed out Mistral's website
  assistant says all models (incl. Large 3 / Large 4 / Medium 3.5) are usable on the free $10 credit. Both can be true — the assistant talks about model
  families, the API about one id; Large 4 (`mistral-large-4`, public preview) launched 6 Oct 2026, so the older id may simply have been restricted. The
  cause is NOT established; the test is `MISTRAL_LARGE_MODEL=mistral-large-4` + `/health live`. `mistralLargePrice()` in `lib/ai.js` now makes the
  budget guard follow the model (Large 4 = list price $1.36/$4.18, unknown ids = the same) — before this it hard-coded Large 3's $0.50/$1.50.
- **Third `/health live` (11 Oct 2026): `mistral-large-4` ALSO returns 403 "not available in your subscription tier"** on the free key — so Large-class
  models are gated on this key (the website assistant's "everything is usable" does not hold for Large). The key's model list offers `mistral-medium-*`
  (3-5, 3.5, 3, 2604, -latest). Medium 3.5 = $1.50 in / $7.50 out per million (price-tracker sites quoting Mistral's list), i.e. DEARER than Large 4
  ($1.36/$4.18 list, ~$0.68/$2.09 on the launch sale) — ~$8 per 1,000 average Max replies, ~1,000 replies for the $8.50 guard.
  Correction: `mistralLargePrice()` previously priced unknown ids at Large 4's $1.36/$4.18, which would have UNDER-counted Medium 3.5's output by ~1.8x;
  unknown ids and `mistral-medium-*` now get $1.50/$7.50. Open decision for the owner: leave Max = Standard (Large keeps 403-ing, then the chain moves on),
  switch `MISTRAL_LARGE_MODEL=mistral-medium-3-5` (if the key can actually call it — /health live will say), or add a card to Mistral to unlock Large 4.
  OpenRouter `google/gemma-4-31b-it:free` returned 429 "Provider returned error" in two runs in a row (flaky upstream) — try `OPENROUTER_MODEL` = another :free id.

### Fourth `/health live` + the owner's Mistral console screenshots (11 Oct 2026)
- `TELEGRAM_BOT_USERNAME` fixed (now OK: @AskAssistAIBot). `MISTRAL_LARGE_MODEL=mistral-medium-3-5` was set: the key CAN call it (a plan block is 403;
  it answered 429 "Rate limit exceeded" - likely the owner using the Mistral Playground in the same minute; free plan ~2 requests/min).
- **Console model picker = what the key can use:** Codestral, Ministral 3B/8B/14B, Mistral Small 4, Mistral Medium (aliases mistral-medium, -3-5, -3.5, -3,
  -2604, magistral-medium-latest, vibe-cli), Labs Leanstral. NO Large 3 / Large 4 (matches the 403s). The website assistant's "everything is usable"
  was wrong for Large.
- **Console prices ($/1M in/out):** Medium $2.70/$8.10; Codestral $0.30/$0.90; Ministral 14B $0.20/$0.20; Ministral 8B $0.15/$0.15; Ministral 3B $0.10/$0.10;
  Small 4 $0.15/$0.60. The code's Small/14B/8B prices already matched. **Correction #2:** the Medium price I used from price-tracker sites ($1.50/$7.50)
  was wrong - `mistralLargePrice()` now uses the console's $2.70/$8.10 (and unknown ids get the same). Lesson: take prices from the owner's console, not aggregators.
- Defaults changed: Max model default `mistral-medium-3-5`; provider renamed "Mistral Max"; README/comments updated.
- **Open design risk (not changed):** paid plans have `maxPerDay: null` (no per-user cap on Max, `lib/limits.js`) and the Mistral credit is ONE shared budget
  (`lib/providerBudget.js`, $8.50). At ~$0.007-0.011 per Max reply (~800-1,200 a month) a few heavy Max users can exhaust it, which also turns off the cheap
  Mistral fallbacks (Small / Ministral). Options: per-plan `maxPerDay` caps, or a sub-budget so Max may use at most ~$5 of the $8.50.
- ModelScope: owner is creating a new token; the new UI offers Read-only / Write / Fine-grained / Admin. ModelScope's docs for these were not found; advice given
  was least-privilege-first (Fine-grained with an inference permission if offered, else Read-only; never Admin) and verify with `/health live` (401 = wrong token,
  403 = permission too low).

### Max-mode cost protection (11 Oct 2026) — answer to "can one user exhaust the Mistral credit?"
YES, and before this change nothing stopped it: Pro/Premium had `maxPerDay: null`; the only per-user bound was the monthly TOKEN allowance
(Pro 1.8M, Premium 4.5M, counted as the provider's `total_tokens`), which at Medium 3.5 prices is $5.83-$9.72 (Pro) / $14.58-$24.30 (Premium) if spent
entirely on Max, vs the $8.50 guard. The guard is monthly-only (no daily pacing) and shared, so when it tripped ALL Mistral models (incl. the cheap
Small/Ministral fallbacks) switched off for everyone.
Built: (1) per-user daily Max caps for paid plans (`TIER_LIMITS.pro/premium.maxPerDay` = 5 / 10 via `MAX_PER_DAY_PRO` / `MAX_PER_DAY_PREMIUM`, `unlimited`
removes it; the over-cap message no longer says "trial"); (2) a sub-budget `mistral_max` (`MISTRAL_MAX_BUDGET_USD`, default $5 of $8.50) —
`budgetsOf(provider)` in `lib/providerBudget.js`; `providerUsable` checks and `trackSpend` charges EVERY budget a provider declares (`budget` + `subBudget`);
(3) `/health` "Budgets" group (spent / cap per pot, warn at 70%, says what happens at 100%). No migration (new `usage_events` kind `mistral_max_microusd`, site user 0).
Capacity reality: $5 ~ 450-700 Max replies/month for the whole bot (~15-23/day). The defaults (5/10 per day) are a PROPOSAL — a handful of capped users can still
spend the slice; the real fix for more Max is a paid Mistral plan. NOT done: showing paid users a Max usage bar (only the over-cap message), a Max row in the in-app
plan comparison table (`public/miniapp/index.html`, "+ Max" with no number), per-user fairness inside the slice (first come, first served).
Tests: `tests/budgets.test.mjs` (19 checks incl. wiring guards), health tests for the Budgets group.

### Max limit shown to users (12 Oct 2026) + ModelScope
- `api/miniapp/usage.js` now returns `max: { perDay, used, resetAt }` (only when the plan's `maxPerDay > 0`); `maxUsageLast24h()` / the pure `maxWindowStatus()` in `lib/limits.js`
  (blocked iff used >= cap; room frees when the (used - cap + 1)-th oldest `max_tier` event passes 24h). `public/miniapp/index.html`: a "Max replies" bar in the menu footer
  (same `paintUsageLine`, so amber at 80% / red + countdown when full) and a "Max replies/day" row in Compare plans (reads `plans.limits.*.maxPerDay`: 0 = "—", null = "Unlimited").
  Verified by running the REAL page in jsdom for Free / Pro 2-of-5 / 4-of-5 / at-cap / Premium / uncapped (`tests/ui-max-bar.test.cjs`, 11 checks; jsdom is NOT a dependency — `npm i --no-save jsdom`).
- ModelScope: the owner's theory (needs Alibaba Cloud binding) is probably right for the NEXT error, but their 401 ("Authentication failed ... valid ModelScope token") was a different one — an invalid token.
  Two third-party guides say the free API needs an Alibaba Cloud account bound AND real-name verified (error text: "401 please bind your alibaba cloud account before use"; phone verification is real friction
  for international users). `/health` now translates that message and offers the way out (unset `MODELSCOPE_API_KEY`). It is the 5th image fallback (after Gemini, Cloudflare Gemma, OpenRouter Gemma, Z.ai) — recommended: skip it.

