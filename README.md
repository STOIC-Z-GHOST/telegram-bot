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
https://api.telegram.org/bot8882813632:AAH7iD8G8dAClpwB400EK2-rBuy45rhc-CM/setWebhook?url=https://telegram-bot-rho-amber.vercel.app/api/telegram-webhook&secret_token=667c44e5638d0b1caf151a21413c9d6864dcb50bea28ea625df94a76c81d22fe 
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
- Old-format `.doc`, `.pptx`, `.xlsx`, and other file types aren't wired up
  yet — the bot will tell you it can't read them rather than failing
  silently.
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

## Plans and limits

Three tiers, checked against real usage (see `lib/limits.js`) — you, as
owner, are exempt from all of it:

| | Free | Pro (300 ⭐/mo) | Premium (600 ⭐/mo) |
|---|---|---|---|
| Messages | 15 / day | 100 / hour | 1000 / hour (shown to users as "Unlimited") |
| Token allowance | 20,000 lifetime | 1,000,000 lifetime | 10,000,000 lifetime |
| File size cap | 5MB | 200MB | 500MB |
| Images per message | 5 | 10 | 20 |
| Attachments per chat (lifetime) | 2 | 100 | 100,000 (shown to users as "Unlimited") |
| Image generations | 3 / 30 days | 10 / 30 days | 1000 / 30 days (shown to users as "Unlimited") |
| `/think` uses | 3 / day | 15 / day | 40 / day |
| Video generation | 🚧 under production — see note below | | |

Free's numbers above are the *base* tier — a given free user's actual
limits are usually higher once their referral bonus is added in (see
"Referrals" below). `limitsFor()` in `lib/limits.js` is what returns the
real, referral-adjusted numbers; `TIER_LIMITS` is just the base table.

`/think <question>` trades speed for depth — Groq gets `reasoning_effort:
"high"` and Gemini gets a real `thinkingConfig.thinkingBudget`, both only
when this command is used. Every tier gets the exact same reasoning depth
per call; what changes by tier is `thinkingPerDay`, how many times you can
call it before the daily cap kicks in — a free user hits that wall fastest,
Premium slowest.

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
  100, a lifetime token top-up at 35, and file size at 75. It tops out at
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
mean you personally eating a real, ongoing cost per user. It's listed in
the comparison table as "under production" as a placeholder — building it
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
@@Chat_assistai_bot — try it free!" line appended, which travels along for free if
they forward that message to a friend or group. Never shown to Pro/Premium
— losing the footer is a small, real, no-effort perk of paying, on top of
the higher limits. Currently only wired into the DM's text/`/think`/
document replies (via `maybeAddFooter`), not image captions or
photo/PDF-vision answers.

**`/channelbonus`** (`lib/channel.js`) is a separate free-tier bonus from
referrals — joining `TELEGRAM_CHANNEL_USERNAME` unlocks
`CHANNEL_BONUS_IMAGES` (+3) image generations/month for 30 days.
Verification is explicit and on-demand (running the command), not
automatic on every message — polling Telegram's `getChatMember` per
message would add real latency for no real benefit. The bonus simply
lapses if a user never re-runs `/channelbonus` before the 30 days are up
(e.g. because they left the channel), rather than the bot needing to
detect that they left.

## Notes

- **Product branding.** The `/start` reply signs off with `@@Chat_assistai_bot`
  instead of a personal name — see `PRODUCT_CREDIT` in
  `api/telegram-webhook.js` if you want to change it.
- **Model IDs** (`gemini-3.6-flash`, `openai/gpt-oss-120b`) are current as of Aug 2026.
  If either provider retires a model later, just change the constant near
  the top of `api/telegram-webhook.js`.
- **No domain needed.** The free `your-project.vercel.app` address is a full
  HTTPS endpoint — that's all a webhook needs. A separate domain (like an
  `ecofurnish.de5.net`-style free forwarding address) wouldn't run any code
  or make this faster; it would just be a different name pointing at
  something.
