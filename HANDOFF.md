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
- Groq free: gpt-oss-120b 8K tokens/min & 200K/day, llama-8b 6K/min & 500K/day — the per-minute
  limit is the real ceiling; the chain exists to spill over.
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
