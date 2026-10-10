# Telegram AI Bot — Gemini primary, Groq fallback

Runs the same way your EcoFurnish Telegram bot does: as a Vercel serverless
function, not a program that has to stay running. Telegram sends each
message straight to a URL on your Vercel project, the function wakes up,
answers, and goes back to sleep. There is no "12 hour session," nothing to
restart, and no PC or laptop needs to be on.

## 1. Deploy

1. Push this folder to a new GitHub repo (or `vercel deploy` from inside it
   with the Vercel CLI — either works, same as EcoFurnish).
2. Import it in Vercel → New Project.
3. In Project Settings → Environment Variables, add these 5:

   | Key | Value |
   |---|---|
   | `TELEGRAM_BOT_TOKEN` | your bot token from BotFather |
   | `OWNER_CHAT_ID` | your own numeric chat ID — see "Access control" below |
   | `GEMINI_API_KEY` | your Gemini key |
   | `GROQ_API_KEY` | your Groq key from console.groq.com (free, no card) |
   | `TELEGRAM_WEBHOOK_SECRET` | any random string you make up yourself |

   This is the "dedicated place for API keys" you're thinking of — Vercel
   encrypts these and only your functions can read them at runtime; they're
   never in your code or repo.
4. Add the one extra dependency this version needs, for reading `.docx`
   files:
   ```
   npm install mammoth
   ```
   (PDFs don't need this — Gemini reads those natively, same as images.)
5. Deploy. You'll get a URL like `https://your-project.vercel.app`.

## 2. Point Telegram at it (one-time, do this once after every deploy of a new URL)

Run this once in a browser or terminal, filling in your own values:

```
https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook?url=https://your-project.vercel.app/api/telegram-webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>
```

You should get back `{"ok":true,"result":true,...}`. That's it — Telegram
now pushes messages to your function instead of you having to poll for them.

## 3. Test

Message your bot `/start`, then ask it anything. Send `/image a red fox
in a snowy forest` (or `/img ...`) and it'll reply with a generated picture
instead of text. Send it any photo — with or without a caption — and it'll
analyze it (see below).

## Photo / vision

- Send a photo with a caption and the caption is used as your question
  ("what's the joke in this?", "translate the sign", etc).
- Send a photo with no caption and it defaults to: if there's a question,
  problem, or text in the image (a homework screenshot, a quiz, a math
  problem), read it and answer it directly — otherwise, describe the image.
- Uses the same `GEMINI_API_KEY` you already set — Gemini's `generateContent`
  endpoint takes text and image together in one request, so no extra key or
  setup is needed.
- No Groq fallback for vision specifically — Groq's only current vision
  model is a preview model in their own docs (their previous stable one was
  just deprecated), so failures here return a plain error message rather
  than silently falling back to something less reliable. Text chat and
  image *generation* both still have their normal fallbacks.

## Document reading

- Send a PDF, `.docx`, or plain-text (`.txt`) file — with or without a
  caption — and the bot reads it.
- With a caption, the caption is used as your question ("what's the total
  on page 2?", "translate this to English", etc). Without one, it defaults
  to: answer any question/problem in the document if there is one,
  otherwise summarize it.
- **PDFs** go straight to Gemini the same way photos do (no extraction
  step) — this also means it can handle scanned/image-only PDFs, since
  Gemini is reading the actual pages, not parsed text.
- **`.docx`** files have their text pulled out first with the `mammoth`
  package (Gemini's document understanding doesn't accept `.docx` directly
  the way it does PDFs and images), then sent as a normal text prompt.
- **`.txt`** files are read directly as plain text.
- **`.xlsx`, `.pptx`, `.md`, `.csv`, code and data files** (`.json`, `.py`,
  `.js`, `.sql`, `.log`, …) are read too — Excel and PowerPoint text is
  extracted in-process (`exceljs`, `jszip`), no external API or key. Which
  plan may send which type is one list in `lib/fileTypes.js`: Free gets
  images, PDF, Word and text/Markdown/CSV; Excel, PowerPoint and the code/data
  types are Pro and Premium. Office files are size-checked from the zip's
  table of contents before parsing so a tiny "zip bomb" can't exhaust memory.
- Old-format `.doc`, videos, archives and other types aren't supported — the
  bot says so rather than failing silently.
- If Gemini can't read a PDF (usually its small free daily quota running out),
  **Mistral OCR** (`lib/ocr.js`, uses your existing `MISTRAL_API_KEY`) turns
  it into text and a normal text model answers from that. It only runs as that
  safety net, so cost stays small.
- Telegram bots can only download files up to 20MB — anything bigger gets
  a clear "too big" message instead of a failed/hanging request.
- Uses `getAiReply` (Gemini → Groq fallback) for `.docx`/`.txt`, and the
  vision path (Gemini only, no fallback — see above) for PDFs, since PDFs
  go through the same multimodal call as images.

## Mini app (chat with saved history)

A second way to use the bot: a proper chat interface, opened inside
Telegram itself, where you can create multiple chats and switch between
them — unlike the DM commands above, which don't remember anything between
messages.

**How it's built:** the frontend is one static file
(`public/miniapp/index.html`) served by Vercel automatically — no separate
hosting needed. It talks to two new API routes:

- `api/miniapp/chats.js` — list / create your chats
- `api/miniapp/messages.js` — load a chat's messages, send a new one and
  get the AI's reply (using the whole thread as context, unlike the DM
  chat)

Everything is stored in Neon Postgres (see `db/schema.js`), and every
request is checked against `initData` — the signed proof-of-identity
Telegram gives the page — via `lib/telegramAuth.js`, so no chat is ever
reachable by anyone but the Telegram user who made it.

### One-time setup

1. **Set `DATABASE_URL`.** Create a Neon Postgres database through Vercel's
   Storage tab (search "Neon" in the marketplace) — this sets the env var
   for you automatically. Then run `db/setup.sql` once in Neon's SQL
   editor to create the tables.
2. **Set `MINI_APP_URL`** to your deployed URL, e.g.
   `https://your-project.vercel.app/miniapp/index.html`.
3. **Register it with @BotFather:**
   - Message `@BotFather` → `/mybots` → select your bot → **Bot Settings**
     → **Menu Button** → **Configure Menu Button**.
   - Send your `MINI_APP_URL` when asked for the URL, then send a short
     label (e.g. "Chat") when asked for the button text.
   - This adds a persistent button next to the message box in your chat
     with the bot that opens the mini app directly.
4. Redeploy. The bot's `/start` message will now also include an "Open
   Chat App" inline button (it only appears once `MINI_APP_URL` is set).

### Image generation

Type `/image <description>` (or `/img`) in any chat — same command as the
DM bot's `/image`, kept consistent across both surfaces. Generates via
Pollinations, then re-uploads the result to your own Blob store (rather
than leaving it pointing at Pollinations' URL) so it stays reliably
viewable in that chat's history later. No extra setup — reuses the Blob
store from file uploads above.

### File / photo uploads

Tap 📎 in the composer to attach an image, PDF, `.docx`, or `.txt` file —
same set of types the DM bot reads. Multiple **images** can be selected
together (Gemini looks at all of them in one call) — the count allowed at
once and the file-size cap both scale with plan tier (see "Plans and
limits" below). PDF/.docx/.txt still work one at a time only — Gemini's
multi-image support is specific to images, and combining several documents
into one analysis isn't the same kind of request.

Images are also downscaled before they're sent (to at most ~1568px on the
longest side, via `lib/imageResize.js`) — a phone photo doesn't need
anywhere near its original resolution for Gemini to read it, and sending
less data means a faster reply.

**Why this needed its own storage:** Vercel serverless functions cap a
request body at 4.5MB — far below even the Free tier's 50MB cap — so a
file can't be POSTed through one of our own API routes. Instead, the
browser uploads directly to **Vercel Blob** storage, and
`api/miniapp/blob-upload.js` only ever issues a short-lived, size/type-
limited upload token — the file bytes never pass through our server on
the way up.

Setup:

1. In Vercel's Storage tab, create a **new** Blob store for this project
   (not one you're already using elsewhere) — this sets
   `BLOB_READ_WRITE_TOKEN` for you automatically.
2. That's it — no further config. Redeploy and the 📎 button works.

### Web search

A 🔍 toggle next to Think in the mini app's composer — tap it once, it
applies to your next message only (same one-shot pattern as Think), and
tells the bot to look up current web results before answering instead of
relying only on what the model already knows.

**How it decides where to search:** `lib/search.js` tries three sources in
order, falling through to the next only if the one before it is
unconfigured or fails:

1. **Self-hosted SearXNG** (`SEARXNG_URL`) — a metasearch engine you host
   yourself, free with no per-query cap, since nothing is billing you per
   search. The trade-off: it's a real service you have to stand up and
   keep running, and a free-tier host can go to sleep after a stretch of
   no traffic (see setup below).
2. **Tavily** (`TAVILY_API_KEY`) — a hosted search API built for feeding
   LLMs, free up to 1,000 searches/month, no card required. Catches
   SearXNG being asleep, down, or not set up yet.
3. **Gemini's own Google Search grounding** — the true last resort, and
   different in kind from the two above: instead of a list of raw results
   to hand to whichever model answers (Groq or Gemini), Gemini searches
   *and* writes the final answer itself in one call. Reuses the
   `GEMINI_API_KEY` you already have set — no extra key needed. Free up to
   5,000 grounded prompts/month as of writing; check
   [ai.google.dev/pricing](https://ai.google.dev/pricing) if that's
   changed since you're reading this.

Leave `SEARXNG_URL` and `TAVILY_API_KEY` both unset and the feature still
works — it just goes straight to Gemini grounding every time. If *all
three* fail for a given search (rare, since Gemini grounding is the
fallback of the fallback), the bot answers without search context rather
than erroring the message out.

**Setting up SearXNG (optional — the only one of the three with no
per-query cap at all):**

1. Deploy [SearXNG](https://github.com/searxng/searxng) to a host that
   runs a persistent service — Vercel can't do this (serverless functions
   only, no long-running containers). [Render](https://render.com)'s free
   web-service tier works well: create a new Web Service from SearXNG's
   own `Dockerfile`, deploy.
2. Set `SEARXNG_URL` to that service's URL, e.g.
   `https://your-searxng.onrender.com`.
3. Redeploy this project.

Worth knowing: Render's free tier sleeps a service after 15 minutes with
no incoming requests, and the next request after that pays a one-time
cold-start cost (roughly 15-60 seconds, not a fixed number). `lib/search.js`
budgets for this — it only gives SearXNG a 9-second window before falling
through to Tavily, so a sleeping instance costs the user a few extra
seconds, not the full cold-boot wait. If search mode gets used at least
once every 15 minutes by anyone, the service simply stays warm and every
search is fast. (Deliberately not using a keep-alive cron ping to force it
to always stay warm — Render's own support has said that goes against the
spirit of the free tier.)

**Setting up Tavily:** sign up at [tavily.com](https://tavily.com), copy
your API key from the dashboard, set `TAVILY_API_KEY`. No card required
for the free tier.

**Limits:** same one-shot-per-message shape as `/think`, enforced the same
way — a `searchPerDay` cap per tier in `TIER_LIMITS` (`lib/limits.js`),
checked/recorded via `checkSearchLimit`/`recordSearchUsage` right next to
the existing `checkThinkingLimit`/`recordThinkingUsage` calls. This mainly
exists to bound how much of Tavily's and Gemini-grounding's free monthly
quota one user could burn through in a day — SearXNG itself has no such
cap to protect, since nothing bills you per search there.

## Image generation

- Uses Pollinations.ai's `image.pollinations.ai` endpoint — genuinely free,
  no signup, no API key. (Pollinations also has a newer `gen.pollinations.ai`
  unified endpoint, but that one now requires a paid API key — this bot
  deliberately avoids it.)
- Anonymous use is rate-limited to roughly 1 request per 15 seconds, which
  is a non-issue for a bot only you use.
- No fallback provider for images (Groq doesn't do image generation) — if
  the Pollinations call fails, you'll get a text error back instead of a
  picture.

## How powerful is this, and can it be stronger for free?

`gemini-3.6-flash` is Google's current fast-tier model — it's already the
strongest model available on Gemini's free tier. As of April 2026, Google
moved the Pro-tier models (the actually-stronger reasoning models) to
paid-only, so there's no free model swap that makes this meaningfully
smarter. What this bot does instead, for free: a `SYSTEM_PROMPT` constant
near the top tells the model how to behave (concise, specific, plain text)
— this doesn't make the model itself smarter, but it noticeably improves
answer quality and consistency, at zero cost. If you want a bigger upgrade
later, the next real lever is conversation memory (the bot currently
treats every message independently) — that needs somewhere to store chat
history between requests, since Vercel functions don't keep state between
invocations. A free external store like Upstash Redis, or your existing
EcoFurnish database if you ever merge this bot into that project, would
both work.

## Voice input

Speak instead of type. In the mini app the 🎤 button records a short clip and
puts the transcript in the message box for you to check and send; in the DM
bot a voice note is transcribed, shown back as "🎤 …", and answered like a
typed message. Transcription is **Groq Whisper** (`whisper-large-v3-turbo`, your
existing `GROQ_API_KEY`) with a Gemini audio fallback (`lib/transcribe.js`).

Groq's free plan is shared by everyone using the bot and limits audio *seconds*
as well as requests (about 28,800 audio-seconds and 2,000 requests a day), so
voice is budgeted three ways in `lib/limits.js`: clips per day, seconds of
audio per day, and the maximum length of one clip, per plan (Free 3 clips /
1.5 min, Pro 30 / 20 min, Premium 100 / 60 min), plus site-wide ceilings at
about 60% of Groq's limits. **Run `db/migrate_voice_seconds_v14.sql` once on
Neon before deploying** — it adds the `seconds` column those budgets use.

## Model tiers (mini app)

The pill under the message box picks the model for the next replies:

| Tier | Model | Who |
|---|---|---|
| ⚡ Flash | Llama 3.1 8B on Groq — fastest | Everyone |
| Standard | `gpt-oss-120b` on Groq, then the fallback chain | Everyone |
| Max | Mistral Large | Pro and Premium |
| 💎 Extra | Gemini 3.8 → 3.7 → 3.5 → 3 Flash, then Max's model | Premium |

Every tier falls back to the Standard chain on failure, so the worst case is
"you got Standard's answer", never "you got nothing".

**Extra and Google's free tier.** Google's free tier gives each Gemini model
its own small quota. On this project every Flash model is 5 requests/minute and
20 requests/day for *all users together*; Gemini 2.5 Pro and 3.1 Pro show 0
(not available on the free tier). Extra therefore chains four Flash models —
separate quotas, about 80 replies a day in total — instead of relying on one.
It is protected by a per-user cap (10/day) and a site-wide cap
(`EXTRA_SITE_DAILY_CAP`, default 60); hitting either never errors — the reply
runs on Max and says so. Your real numbers are on
`aistudio.google.com/usage?timeRange=last-28-days&tab=rate-limit`, and the
free tier lets Google use submitted content to improve its products.

Vision, PDFs, voice-note fallback and the last-resort text fallback use
`gemini-3.6-flash` first (20/day) and then `gemini-3.5-flash-lite`
(500/day) so they don't stop after 20 uses.

## Roadmap: Extra bonus add-ons (not built yet)

Ideas to make Extra different from the other tiers. **None of these exist yet
— build them once there are real users to justify them.** All three use
Google's Gemini Live API, which the free tier shows with unlimited requests
per day (the limit is tokens per minute — 65K for 3.8 Live, 20K for the
translate/transcribe models — plus a small number of simultaneous connections,
roughly 3–5). Google hasn't published rate limits specific to the Live models
and free-tier content may be used to improve its products, so re-check the
AI Studio rate-limit page before building. Live models are voice agents: they
take text, audio, images or video in and answer with *audio* (text only as a
transcript of that audio), over a WebSocket — so they are **not** a good
replacement for the text chat models above.

1. **Voice replies ("talk to the bot").** Send a voice note, get a spoken
   answer back. Uses `gemini-3.8-live` (or its "Extended Thinking" sibling
   for harder questions). Work involved: open a WebSocket per
   exchange from the function, collect the audio, and convert it to a format
   Telegram plays as a voice note (the model returns raw PCM, and Vercel has
   no ffmpeg — use a WASM Opus encoder or send WAV), and give it its own daily
   cap so one user can't use up the shared connection/token allowance.
2. **Live translation.** Speak in one language, hear/read another, using the
   `Gemini 3.5 Live Translate` model. Same plumbing as #1 with a translation
   config.
3. **Priority voice-to-text.** `Gemini 3.5 Transcribe Live` as a second
   transcription path next to Groq Whisper (`lib/transcribe.js`), so Extra
   users never hit the Whisper site-wide ceilings. (On the free tier the
   non-live `Gemini 3.5 Transcribe` shows only 3 requests/min and 25/day; the
   Live version shows unlimited requests, limited by tokens per minute.)

Until these exist, the mini app only says "New features coming soon" on the
Extra card and in the plan table — deliberately vague so it builds anticipation
without promising specific features. Remove that wording from
`public/miniapp/index.html` (search for "New features") if you decide not to
build any of them. Don't sell Premium on features that aren't live yet.

## Access control

The bot is public — anyone can message it and land on the Free tier
immediately, no approval needed:

- **You (`OWNER_CHAT_ID`)** always have full access, and are the only one
  who can ban or unban anyone else.
- **Anyone else** who messages the bot for the first time is auto-approved
  on the spot and starts using it right away, on Free tier limits.
- **Approved** users can use the DM chat and the mini app — the mini app
  checks the same access list, so approval on one covers both.
- **Banned** users (via `/remove`) get a flat "access revoked" message —
  no self-serve way back in; they'd need to reach out to you directly.
- **`/users`** (you only) lists everyone currently approved, each with a
  one-tap **Remove** button — this bans them.

All of this lives in `access_requests` in Neon (see `db/schema.js` and
`lib/access.js`) — shared between the DM bot and the mini app, so there's
one access list, not two that could drift out of sync. The table name and
status lifecycle (`approved` / `denied`) are left over from when this was
an invite-only bot with manual review; `denied` now just means "banned."

## Creating files (HTML, Word, PDF, Markdown, text)

The bot can hand people a real file. In the **mini app**: `/file pdf a weekly study plan`
(format optional — Word is the default), or just ask ("build me a website for my bakery",
"write a Word document about…"), or convert the last reply ("give me that as a PDF" —
instant, no AI call). In the **DM bot**: `/file <html|docx|pdf|md|txt> <what to make>`.

How it works (`lib/fileGen/`): the AI writes only TEXT — Markdown for documents, one HTML
page for websites — and the server builds the file: `docx.js` (Word, via the `docx` package),
`pdf.js` (hand-laid-out with `pdf-lib`, embedded Noto Sans + Noto Sans Ethiopic so English and
Amharic can share a page; other scripts show "?"), `markdown.js` (shared parser). Detection is
plain keyword rules in `detect.js`, not an instruction to the AI — an explicit `/file` over its
limit is an error, a natural-language guess over its limit falls back to a normal text reply.

- **Limits:** `filesPerDay` per rolling 24h — Free 1, Pro 5, Premium 15 (trials 3 / 8) — plus a
  site-wide cap `FILE_SITE_DAILY_CAP` (default 150). Only a delivered file spends allowance.
- **Tokens:** the tokens a file uses are added to the person's token count (and it counts as one
  message), whether or not the file succeeded. Export-of-last-reply uses none.
- **Always the Standard model chain**, 5,000 output-token ceiling, 48s total time budget.
- **HTML is stored as a download** (octet-stream, `downloadUrl`), never as a page served from
  your blob domain — a generated fake login page must not be shareable as a live link.
- **Not built:** PowerPoint output / editing, PDF editing, Word->PDF conversion (impossible on
  Vercel). Editing uploaded files (Phases 2 and 3) is in the next section.

## Health check: are the keys and models really connected?

Two ways to run the same check (`lib/health.js`):

- **In the bot (owner only):** send `/health` for the quick check or `/health live` for the live one.
  It tests the keys that are actually set on Vercel, from the running deployment.
- **Before deploying:** copy `.env.example` to `.env.local`, fill it in (or `vercel env pull .env.local`),
  then `npm run check` or `npm run check:live`. It exits with code 1 if anything is broken.

| | Quick (default) | Live |
|---|---|---|
| What it does | Asks each provider free questions: "is this key valid?" and "does this exact model id exist?" | Also sends ONE tiny "reply with OK" to each model |
| Cost | No generation quota, no money | A handful of requests: 1 of OpenRouter's 50/day; 1 Gemini call on the roomy 3.5 Flash-Lite model (never the 20/day one); a few Cloudflare neurons; a fraction of a cent of Mistral. No image is generated. |

It checks: every required setting; the Neon database **and that every table exists** (a missing one names the
migration file to run); the Telegram bot token, that a webhook is set and what Telegram's last delivery error was;
the Vercel Blob token; every Gemini model id; and each provider (Groq, Cerebras, Cloudflare, OpenRouter, Mistral,
ModelScope, Z.ai, SearXNG, Tavily) with the exact model ids `lib/ai.js` calls — taken from the same constants,
so a retired or mistyped model shows up here instead of as a silent fallback. ✅ ok, ⚠️ works but look
(rate-limited right now, provider hiccup), ❌ fix this, ⏭️ not configured (optional). No key is ever printed:
provider messages are scrubbed first. Tests: `node --no-deprecation tests/health.test.mjs` (54 checks, fake network).

## Editing files people upload (Phases 2 and 3)

Send a file with what to change and get the edited copy back (`name-edited.ext`).

- **Mini app:** attach the file and write the change as the message — "fix the typos", "add a
  Total column" — or use `/file edit <change>` (with nothing attached it edits the file most
  recently shared in that chat, including one the bot made).
- **DM bot:** send the file as a document with the caption `/file edit <change>` (or a plain
  caption like "fix the typos").
- Natural-language detection (`lib/fileGen/editDetect.js`) is deliberately cautious: exactly one
  editable file attached, an edit verb, and not a question or an "explain/summarise" request.
  `/file edit` always works. Over the file allowance, a natural-language guess falls back to the
  normal "read the file" reply; the explicit command shows the limit message.
- **Counts like creating a file:** one `filesPerDay` unit (only if delivered), one message, and
  the tokens used. Plan gating for the *upload* is unchanged (Excel and code/data files are Pro+).

What can be edited (`lib/fileGen/edit/`):

| File | How | Notes |
|---|---|---|
| Text, code, HTML, Markdown, CSV, JSON, config… (`text.js`) | Up to ~8,000 characters: the model returns the whole new file. Larger (to 30,000): it returns `{find, replace}` patches we apply ourselves. | Result is checked: JSON must still parse, a page keeps `</html>`, a file can't quietly lose most of its content, CRLF line endings and the final newline are preserved. |
| Excel `.xlsx` (`xlsx.js`) | The model sees a grid and returns JSON operations (set / formula / fill / clear / append_row / insert_row / delete_rows / style / add_sheet); we validate and apply them with `exceljs`. | Workbooks with charts, pivot tables, slicers or macros are **refused** (exceljs would drop them). Formulas calculate when the file is opened. Formulas that call out of the workbook (WEBSERVICE, HYPERLINK, DDE…) are blocked. Inserting/deleting rows doesn't rewrite formulas that point below them — the person is warned. |
| Word `.docx`, in place (`docx.js`) | Body paragraphs are numbered; the model returns changes by number; only those paragraphs are rewritten in `word/document.xml`. | Styles, images, tables, headers, footers, numbering and section breaks are untouched. An edited paragraph keeps its style and the look of its first words but loses mid-sentence formatting (one bold word). Paragraphs with fields, links, text boxes, equations, content controls or tracked changes are **locked**. Headers/footers/text boxes are not editable. Output is re-checked (balanced tags, still readable) before it is sent. |
| PDF, PowerPoint, images | Not editable — the person gets a short explanation (and, for PDF, the "send it as Word" suggestion). | A natural-language "translate this PDF" is just answered in chat. |

**One file at a time:** a person can only have one file being made or edited at once (a second
request gets "I'm still working on your previous file"). The daily file count only moves when a file
is delivered, so without this a burst of simultaneous requests would all pass the check together.

Tests: `node --no-deprecation tests/phase23-edit.test.mjs` (55 checks on real .txt/.xlsx/.docx
files with a mocked model) and `tests/phase1-create.test.mjs`. No new dependencies or env vars.

## Provider chains and shared budgets

Two providers give you a shared *budget* rather than a per-model request count,
so each has a site-wide guard (`lib/providerBudget.js`, no migration needed):

| Provider | Free allowance | Guard stops at | Env var to change it |
|---|---|---|---|
| Cloudflare Workers AI | 10,000 neurons per UTC day, all models and users | 9,000 | `CF_NEURON_DAILY_CAP` |
| Mistral | $10/month API credit, shared with OCR | $8.50 | `MISTRAL_MONTHLY_BUDGET_USD` |

Both fail open (if the budget check itself errors the call is allowed) and a
429/403/404 from any provider just moves on to the next in the chain.
Cloudflare resets at 00:00 UTC; the Mistral guard counts the UTC calendar
month, so if your credit cycle starts on another day, lower the budget for the
month you're in. Confirm which Mistral plan you're on in the console's
Billing/Usage page (a dollar credit balance means the $10 rule applies).

Chains (first available wins, then the next):

- **Standard:** Groq gpt-oss-120b -> Cerebras (if keyed) -> Cloudflare gpt-oss-120b -> OpenRouter -> Ministral 14B -> Mistral Small -> Gemini
- **Flash:** Groq llama-3.1-8b -> Cloudflare llama-3.1-8b -> Ministral 8B -> Standard chain
- **Max:** Mistral Large 3 (pinned `mistral-large-2512`) -> Standard chain
- **Extra:** four Gemini Flash models -> Max -> Standard chain
- **Think mode** skips Cloudflare (reasoning tokens bill as output and drain the shared pool)
- **Image generation:** Cloudflare FLUX.1 [schnell] -> Pollinations Flux 1024 -> Pollinations defaults
- **Image questions:** Gemini -> Gemini Flash-Lite -> Cloudflare Gemma 4 -> OpenRouter Qwen-VL -> ModelScope -> Z.ai (Pixtral was retired by Mistral and removed)

Cloudflare needs **both** `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`
(a token with Workers AI permission); with either missing it is skipped.
Model ids are env vars because both vendors retire models:
`CF_STANDARD_MODEL`, `CF_FLASH_MODEL`, `CF_VISION_MODEL`,
`MISTRAL_SMALL_MODEL`, `MISTRAL_LARGE_MODEL`, `MISTRAL_14B_MODEL`,
`MISTRAL_8B_MODEL`. Ids are pinned instead of `-latest` because an alias can
resolve to a model with a much lower rate limit.

After deploying, check Cloudflare once with a real message and look at the
Vercel logs for "Cloudflare answered"; if the endpoint path is wrong you'll see
a 404 there and the chain will quietly skip it.

## Trials and the Plan sheet

Open the menu (☰) and tap **Plan**, right below Settings. It shows the current
plan with a countdown, the free trials the person can start, and the Stars
subscribe buttons. **Run `db/migrate_plan_trials_v15.sql` once on Neon BEFORE
deploying** — starting a trial writes to the new `plan_trials` table.

| | Pro promo | Premium trial |
|---|---|---|
| Length | 14 days | 3 days |
| Who | the first 100 *activations* (`PRO_PROMO_SLOTS`) | once per account |
| Max-model replies | 2 / day | 5 / day |
| Extra-model replies | — | 3 / day |
| Tokens | free allowance + 300K | free allowance + 150K |
| Other caps | 5 thinking, 5 searches, 10 voice clips, 5 images/mo | 10, 10, 20, 10 |

- **The clock starts when the user taps Start**, not at signup, so a trial never
  ends before they knew it was on. Remaining days are not banked.
- A trial is an ordinary `subscriptions` row (charge id `trial:<kind>`), so it
  unlocks that plan's tiers and file types everywhere. A real Stars payment
  overwrites it (the leftover trial days are forfeited — the sheet says so).
- Not allowed while on a paid plan or while another trial is running; each kind
  once per account (primary key on `plan_trials`).
- `TRIAL_DAILY_START_CAP` (default 20) limits new trials per rolling 24h across
  everyone, which bounds what second accounts can cost the shared free quotas.
- Max-model replies are the costly ones (~$0.0014 each against Mistral's shared
  $10 credit), so trials cap them per day; over the cap a reply runs on Standard
  with a one-line note. Paid Pro/Premium have no per-user cap.
- A banner reminder appears once per visit when 2 days or fewer remain.
- Numbers live in `TRIAL_KINDS` in `lib/limits.js`; the Plan sheet reads them
  from the server, so changing them there changes what users see.

## Usage bars and when limits free up

The menu (☰) footer shows a thin bar per limit — **Messages** and **Tokens**, each on its
own line, plus a **trial** line (with its remaining days) while a trial is running. A bar
fills as the limit is used, turns amber at 80%, and when it is full shows a live
countdown instead of the numbers.

Every window is **rolling**, not clock-aligned (no midnight reset, no timezone to pick):

| Limit | Window | Full-bar countdown means |
|---|---|---|
| Messages, Free | rolling 24 hours | "next message in …" — when the oldest message ages out |
| Messages, Pro/Premium | rolling hour | same, hourly |
| Tokens | rolling `TOKEN_WINDOW_DAYS` (default 30) | "frees up in …" — when enough old usage ages out to fit the next one |

So a full bar doesn't empty all at once — room frees up one message at a time as the
oldest ones pass 24 hours. `TOKEN_WINDOW_DAYS=1` would make tokens a daily limit, but
the `maxTokens` numbers in `lib/limits.js` mean "per window", so change them with it.

## Plans and limits

Three tiers, checked against real usage (see `lib/limits.js`) — you, as
owner, are exempt from all of it:

| | Free | Pro (300 ⭐/mo) | Premium (600 ⭐/mo) |
|---|---|---|---|
| Messages | 15 / day | 100 / hour | 1000 / hour (shown to users as "Unlimited") |
| Token allowance | 300,000 / 30 days | 1,800,000 / 30 days | 4,500,000 / 30 days |
| File size cap | 5MB | 200MB | 500MB |
| Images per message | 5 | 10 | 20 |
| Attachments per chat (lifetime) | 2 | 100 | 100,000 (shown to users as "Unlimited") |
| Image generations | 3 / 30 days | 10 / 30 days | 1000 / 30 days (shown to users as "Unlimited") |
| `/think` uses | 3 / day | 15 / day | 40 / day |
| 🔍 Search uses | 5 / day | 40 / day | 200 / day |
| 🎤 Voice | 3 clips · 1.5 min / day | 30 clips · 20 min / day | 100 clips · 60 min / day |
| 💎 Extra model replies | — | — | 10 / day |
| Model tiers | Flash, Standard | + Max | + Extra |
| Video generation | coming soon for paid tiers — see note below | | |

Free's numbers above are the *base* tier — a given free user's actual
limits are usually higher once their referral bonus is added in (see
"Referrals" below). `limitsFor()` in `lib/limits.js` is what returns the
real, referral-adjusted numbers; `TIER_LIMITS` is just the base table.

`/think <question>` trades speed for depth — Groq gets `reasoning_effort:
"high"` and Gemini gets a real `thinkingConfig.thinkingBudget`, both only
when this command is used. Every tier gets the exact same reasoning depth
per call; what changes by tier is `thinkingPerDay`, how many times you can
call it before the daily cap kicks in — a free user hits that wall fastest,
Premium slowest. The mini app has the same feature as a 🧠 toggle button
next to the attach button — tap it once, it applies to your next message
only, then turns itself back off — going through the same `checkThinkingLimit`/
`recordThinkingUsage` calls in `lib/limits.js`, so the daily cap is shared
across the DM and the mini app rather than being two separate quotas.

🔍 Search mode works the same one-shot way — tap it once in the composer,
applies to your next message only, then turns itself back off. Unlike
`/think`, it's mini-app-only (there's no DM equivalent yet), and its daily
cap (`searchPerDay`) is really there to bound how much of Tavily's and
Gemini-grounding's *free* monthly quota one user could burn through in a
day, not to ration a paid resource of your own — see "Web search" under
"Mini app" above for the full setup.

Worth knowing on "images per message": Gemini's own technical ceiling is
much higher than any of these numbers (thousands of images, bounded mainly
by a 20MB total request size) — these tiers are sized for a snappy reply,
not to chase Gemini's actual max. Since images already get downscaled
before sending (see "File / photo uploads" above), even Premium's 20 sits
comfortably under that 20MB ceiling in practice.

"Attachments per chat" is a lifetime count for that one chat thread, not
the user's overall usage — a heavy chat never eats into any of their other
chats' allowance. It counts both new multi-image messages and any older
single-attachment messages sent before this was added.

`/plans` (any user) or the "Compare plans" button in the mini app's
Settings shows this same table live, pulled directly from `TIER_LIMITS` so
it can't drift out of sync with what's actually enforced. It shows base
free numbers, not any individual user's referral-boosted ones — `/invite`
shows a user their own current bonus.

## Referrals

Free users can raise their own limits by inviting friends — `/invite`
gives them a personal `https://t.me/<bot>?start=ref_<their id>` link (or a
plain `/start ref_<id>` code if `TELEGRAM_BOT_USERNAME` isn't set).
Everything lives in `lib/referrals.js`:

- A referral is **pending** the moment someone opens the bot via that
  link, and becomes **credited** the moment they send their first real
  message — not just from opening the bot. This is deliberate: it's the
  difference between someone actually trying the bot and someone who
  clicked a link and left.
- Credited referrals unlock a stacking ladder of bonuses on top of the
  base Free limits (`REFERRAL_TIERS`) — more messages/day at 5 and 15
  invites, image generations at 15 and 25, attachments/chat at 25 and
  100, a token top-up (per 30 days) at 35, and file size at 75. It tops out at
  100 invites, and every number on it is kept well short of Pro on
  purpose — this rewards social free users, it isn't meant to make paying
  pointless.
- The ladder counts only referrals credited in the **last 60 days**
  (`REFERRAL_WINDOW_DAYS`), not a lifetime total — someone's count quietly
  drifts down as old invites age out, the same way the hourly/daily
  message limits already work. Nothing is ever deleted from the
  `referrals` table; the window only affects what currently counts toward
  the bonus, not the historical record. There's no reset job anywhere —
  it's just a different WHERE clause on a query that already existed.
- A referrer can only have 5 referrals credited per rolling 24 hours
  (`DAILY_CREDIT_CAP`) — mostly to stop a burst of invites landing at once
  and jumping someone several tiers in an afternoon, not real fraud
  prevention (a Telegram account needs a real phone number, which is
  already meaningful friction on its own).

**How payment works:** `/upgrade` in the DM, or the Upgrade section in the
mini app's Settings — both create a real Telegram Stars **subscription**
(`subscription_period` locked to 30 days by Telegram, not something we
chose). The first charge happens the moment they pay; Telegram renews it
automatically every 30 days after that and sends a fresh payment
confirmation each time — there's no cron job or scheduler anywhere in this
project doing that re-billing. A user cancels any time from Telegram's own
subscription management UI; when they do, the subscription simply stops
renewing and their access quietly reverts to Free once the current period
ends — nothing here needs to react to a cancellation event specifically.

**Changing prices without a redeploy:** prices live in Neon (`plan_prices`
table), not hardcoded — as owner, send `/setprice pro 300` or
`/setprice premium 600` in the DM and it takes effect immediately, no
redeploy needed. `lib/subscriptions.js`'s `FALLBACK_PRICES_STARS` is only
used until the first time a price is ever set for that tier.

**Video generation** isn't wired to anything yet — deliberately. Unlike
image generation (genuinely free via Pollinations, no matter the volume),
there's no free equivalent for video: every real provider (Kling,
PixVerse, Google's Veo, etc.) charges per-video or per-month, and OpenAI's
Sora API is being shut down entirely. Offering it on the Free tier would
mean you personally eating a real, ongoing cost per user. The comparison
tables only say "coming soon for paid tiers" as a placeholder — building it
for real is a separate decision once there's actual subscriber demand to
justify a provider account and a price that covers it.

**On "premium" and the AI model:** Premium currently gets the same
Groq/Gemini Flash models as everyone else — just higher numeric limits.
Giving Premium a stronger model (e.g. a paid Gemini Pro tier) is a real
option, but a materially different cost basis: Pro-tier Gemini runs
roughly $2 per million input tokens / $12 per million output tokens (no
free tier), versus $0 for Flash. If you want to add that later, it's a
model-selection change in `lib/ai.js` gated on tier — but reprice Premium
first if you do, since 600 Stars/month (~$6) doesn't cover a heavy user's
worth of Pro-tier tokens on its own.

**The branded footer** (`FOOTER_TEXT` / `FOOTER_CHANCE` in
`api/telegram-webhook.js`) is the other growth lever, alongside referrals:
roughly 1 in 4 of a **free** user's replies gets a small "🤖 Generated by
@assist_ai — try it free!" line appended, which travels along for free if
they forward that message to a friend or group. Never shown to Pro/Premium
— losing the footer is a small, real, no-effort perk of paying, on top of
the higher limits. Currently only wired into the DM's text/`/think`/
document replies (via `maybeAddFooter`), not image captions or
photo/PDF-vision answers.

**Natural-language image requests and the Flash tier.** In the mini app the model
itself decides when a message is an image request (it answers with a
`[GENERATE_IMAGE: ...]` marker). Flash's small model misread "build a simple
website" as one, and each false positive spends one of a free user's few monthly
image generations. So on Flash the instruction is only offered when the message
plausibly asks for a picture (`plausiblyImageRequest` in `lib/imagegen.js`: image
words in English and a few other languages; mostly non-Latin text such as Amharic
always passes). Standard, Max and Extra are unchanged. `/image` always works on
every tier.

**Image generation — providers, quality and failures.** Order: **Cloudflare
FLUX.1 [schnell]** (when `CLOUDFLARE_ACCOUNT_ID` + `CLOUDFLARE_API_TOKEN` are set and
the day's neuron budget has room; ~58 neurons per 1024px image at 4 steps) -> Pollinations
Flux 1024 -> Pollinations defaults. All attempts together stay under 50s to fit the 60s
function limit. A prompt Cloudflare refuses for safety reasons is final — it is not
retried on another provider. Optional env vars: `CF_IMAGE_MODEL` (default
`@cf/black-forest-labs/flux-1-schnell`; a model that returns raw image bytes also works)
and `CF_IMAGE_STEPS` (1-8, default 4). Pollinations notes: Left to its defaults,
Pollinations' no-key tier uses a small fast model (an error it returned listed
`model: sana`, 768x768), which is why pictures were soft and any text was gibberish.
`generateImage` in `lib/imagegen.js` now asks for Flux at 1024x1024 first and, if that
fails, tries the plain defaults once; the DM bot and the mini app share that one path.
When both fail, people see a short "the image service is busy, try again in a minute"
message — the provider's raw JSON error goes to the logs only. A failed generation
never spends image allowance. Image models can't really write text whatever the model:
keep any wanted text to a few big words.

**Viewing and saving images (mini app).** Tapping a picture in a chat opens a
full-screen viewer: tap the picture to zoom, ‹ › to move between several, ✕ or the
dark area to close, **Save** to keep it. Save uses Telegram's own downloader
(`downloadFile`, Telegram 8.0+), which is the only thing that works reliably inside
the app; on older versions it opens the image in the browser (press and hold to
save), and in a plain browser it downloads directly.

**Assist AI badge on generated images.** `lib/brandImage.js` stamps a small badge
(logo + name, from `lib/badgeData.js`) in the bottom-LEFT of every picture from
`/image` or a natural-language request, in both the DM bot and the mini app. It
sits away from Pollinations' own watermark in the bottom-right and never covers
it — Pollinations removes its watermark itself for accounts with an API key, which
is the supported way if you ever want it gone. If stamping fails for any reason the
original image is sent unchanged. To change the badge, regenerate
`lib/badgeData.js` from `public/logo.png`.

**The announcement channel** (`lib/channel.js`) is no longer a bonus. The old
`/channelbonus` image-generation reward was removed once free trials existed; now
`/start` simply ends with "Join @channel for updates and more info about the bot"
plus a **📢 Join for updates & info** button, taken from `TELEGRAM_CHANNEL_USERNAME`
(unset = the prompt is left out). It is a prompt, not a gate — nobody is blocked
from using the bot until they join. Anyone who still sends `/channelbonus` gets a
one-line "retired" reply with the join button. The `channel_memberships` table is
now unused; it's harmless to leave, or drop it with
`DROP TABLE IF EXISTS channel_memberships;`.

**Identity.** What the assistant says when asked "who are you" lives in
`lib/identity.js` and is shared by the DM bot and the mini app: it answers in the
first person as **Assist AI** (change with the `BOT_NAME` env var or in that file),
says what it can do, and — when asked about the model — says honestly that it runs
on a mix of models and can't see which one is answering, without naming providers.

## Notes

- **Product branding.** The `/start` reply signs off with `@assist_ai`
  instead of a personal name — see `PRODUCT_CREDIT` in
  `api/telegram-webhook.js` if you want to change it.
- **Model IDs** (`gemini-3.6-flash`, `gemini-3.5-flash-lite`, the Extra list in `lib/ai.js`, `openai/gpt-oss-120b`) are current as of Oct 2026.
  If either provider retires a model later, just change the constant near
  the top of `api/telegram-webhook.js`.
- **No domain needed.** The free `your-project.vercel.app` address is a full
  HTTPS endpoint — that's all a webhook needs. A separate domain (like an
  `ecofurnish.de5.net`-style free forwarding address) wouldn't run any code
  or make this faster; it would just be a different name pointing at
  something.
