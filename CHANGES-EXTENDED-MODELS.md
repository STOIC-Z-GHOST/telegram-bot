# What changed in this version of the project (Oct 2026)

This is the whole project (your telegram-bot-fixed (3) plus everything below, merged and tested together). Sections: the Extended models
privacy setting, early access, Storage, reading Word and PDF files properly, voice and photo fixes, and an audit of the files that were
not seen earlier. Read README.md -> "Extended models", "Early access" and "Storage" for how each works.

## Before you deploy (in this order)
1. `npm install` (new dependency: `unpdf`, for reading PDFs on the server).
2. In the Neon SQL editor run `db/migrate_data_sharing_v16.sql` and `db/migrate_early_access_v17.sql` (both safe to run twice).
3. In Vercel set `CRON_SECRET` (any long random string) and, when you want early access, `EARLY_ACCESS_SLOTS` (see README -> Early access).
   `vercel.json` already contains the daily cleanup cron. Delete `OPENROUTER_MAX_MODEL` and `OPENROUTER_IN_STANDARD` if still set.
4. Deploy, then with a brand-new Telegram account (Extended models off): `/start`, send a digital PDF, a scanned PDF or photo, a voice note and the
   exam .docx; open Settings -> Storage; then run `/health live`, `/early` and `/limits` as owner.

## Tests (run from the project folder)
- All of them: `for t in tests/*.test.mjs; do node --no-deprecation $t; done` and `node tests/*.test.cjs` (the .cjs ones need `npm i --no-save jsdom`; storage.test.mjs needs `npm i --no-save @electric-sql/pglite`)
- `node --no-deprecation tests/pdfText.test.mjs` (15) and `tests/imagegen.test.mjs` (9) are new in this version
- `node --no-deprecation tests/dataSharing.test.mjs`            46 checks, privacy rules end to end (new)
- `npm install --no-save jsdom && node tests/ui-extended-models.test.cjs`   23 checks on the real page (new)
- `node --no-deprecation tests/docxText.test.mjs`                17 checks on reading numbered Word files (new)
- `node --no-deprecation tests/media.test.mjs`                   23 checks on voice, spreadsheets, big Word files and error wording (new)
- `node tests/upload-path.test.cjs`                              11 checks on the upload-path fix (new)
- models, health, providerLimits still pass (51 / 170 / 52). budgets, security and phase23-edit need files that were not in the upload
  (api/miniapp/usage.js and others): run them on your full project.

## Also fixed in this zip: "Vercel Blob: This blob already exists"
Cause: the mini app uploaded every attachment under its bare file name, so a second upload of "core 1 exercise.pdf" (another account, a
re-send, or two same-named files in one message) was refused. Fix (public/miniapp/index.html): each upload goes to `<random id>/<name>`,
and a failed upload shows "Couldn't upload "<name>". Please try again." instead of the storage error. Do NOT use allowOverwrite: it
would let one person replace another person's file. Test: `node tests/upload-path.test.cjs` (11 checks).
Optional second layer: in api/miniapp/blob-upload.js (not in my upload) return `addRandomSuffix: true` from onBeforeGenerateToken.

## Also fixed: the Details button showed nothing
The explanation text only came from the server. If the settings request failed (most likely cause: db/migrate_data_sharing_v16.sql not
run yet, so the query for the new columns errors), the Details panel opened empty. Now the page carries its own copy of the wording
(generated from lib/dataUse.js by `node scripts/sync-sharing-copy.mjs`; tests/dataSharing.test.mjs fails if they ever differ), so Details
always works, and when the setting cannot be read the switch is locked and says "Couldn't load this setting". Run the migration first.

## Also fixed: wrong question numbers when reading a Word file ("answer from question 25" started at 11 or 13)
Cause: in an exam paper like core 1 exercise (3).docx the labels "1." and "A." are Word's automatic list numbering. The reader the bot
used (mammoth) drops them, so the AI received 25 unnumbered questions and had to count them itself, which every model got wrong, then it
relabelled its own count as 25. New lib/docxText.js rebuilds the labels from the file's numbering definitions (decimal, letters, roman,
nested levels, restarts, start overrides, numbering from a paragraph style, tables, tracked changes) and writes them into the text
the AI gets; lib/attachments.js uses it when a file has numbered lists and keeps the old plain text otherwise (or if the numbered
text looks incomplete). If mammoth cannot open a file, the new reader now rescues it. The document prompt also says to use the
document's own numbers and never renumber. On the real file: 50 questions numbered 1 to 50, no gaps, question 25 is the 25th.
Test: `node --no-deprecation tests/docxText.test.mjs` (17 checks). No new dependency (jszip and mammoth were already there).

## Also checked and fixed: voice, spreadsheets, photos (21-22 Oct audit; things I could not see are listed at the end)
- Voice: Whisper invents words on silence ("Thank you.", "Thanks for watching!"). The bot now asks Groq for per-segment confidence and drops
  segments that are probably not speech, so silence returns "couldn't hear anything". If Groq refuses that request format it retries as before.
  The audio format is read from the bytes (a Safari clip labelled webm is really mp4 and was sent under the wrong name). The mini app's
  byte ceiling was exactly 128 kbps for 30 s, so a high-bitrate phone could be told its 30-second clip was "too long"; it now has headroom.
- Spreadsheets: Excel files often claim a million formatted-but-empty rows; reading one took over a second here and longer on Vercel. A sheet is
  now cut off after 2,000 empty rows in a row.
- Photos: for anyone who has not turned Extended models on, Cloudflare was the ONLY photo reader. Mistral (8B Ministral, training switch off)
  is now the second private reader. Unverified: whether your Mistral key accepts images on that model. `/health live` now sends it the test
  image; if it says the model rejected the image, set MISTRAL_VISION_MODEL=ministral-14b-2512 or ministral-3b-2512.
- DM bot: a failed photo or file used to print the raw internal error into the chat (storage or provider wording, sometimes a response
  body), and one reply said "Both Groq and Gemini failed". Both are now plain, friendly messages; the real reason is still logged.
- Tests: `node --no-deprecation tests/media.test.mjs` (23 checks); dataSharing 46; health 170 (its Mistral count now includes the photo row).

## New: early access, and Storage (quota, delete your own files, daily cleanup)
- Early access (lib/earlyAccess.js, db/migrate_early_access_v17.sql, README -> Early access): the first EARLY_ACCESS_SLOTS people get the
  Premium plan, switchable from the environment (SLOTS=0 ends it for everyone, EARLY_ACCESS_ENDS ends it on a date, EARLY_ACCESS_PLAN moves
  everyone between premium and pro). Every plan lookup (limits.js, messages.js, the DM webhook) goes through it. Owner command `/early`.
- Storage (lib/storage.js, README -> Storage): per-person quota, Settings -> Storage to see and delete your own files, removed files shown as
  "removed" in old chats, refused uploads cleaned up, and a daily cleanup (inside the webhook function, via Vercel Cron: add the crons entry to
  vercel.json and set CRON_SECRET). Uploaded files are measured from storage, not from what the browser claims. No storage migration.
- Tests: `tests/earlyAccess.test.mjs` (28), `tests/storage.test.mjs` (43, runs real SQL in an in-process Postgres: `npm install --no-save
  @electric-sql/pglite`), `tests/ui-storage.test.cjs` (31, real page in jsdom).
- Now that usage.js, blob-upload.js and chats.js were uploaded: usage.js shows the early-access plan (label, badge, Plan sheet), keeps Subscribe visible,
  still offers the invite link, and returns the storage numbers (without this an early-access person's usage bar would have shown a blank
  message limit); blob-upload.js uses the early-access plan for file types and size, refuses an upload when storage is full BEFORE any bytes are
  sent, and limits one file to the space left; the file picker warns instantly when files won't fit; Compare plans has a Storage row.
  chats.js needed no change (deleting a chat already removes its files; removed files have no url so it skips them).
- Big files go sooner: over STORAGE_LARGE_MB (50) = deleted after STORAGE_LARGE_DAYS (3), shown on the Storage screen.
- Your uploaded messages.js, settings.js and transcribe.js were the versions I started from (messages.js had my first image-generation edit);
  the ones in this zip are supersets, so just replace yours.

## Rules kept
12 serverless functions (no file added under api/), the assistant never names providers or models, migrations are manual SQL,
ESLint no-undef is clean on every file in this zip.

## Audit of the files that were not in the earlier uploads (now that the full project is here)
- lib/imagegen.js: the privacy patch is applied (`generateImage(prompt, { allowShared })`: without a yes only Cloudflare is used, never Pollinations; a
  clear "busy, try again" message when Cloudflare is out). `tests/imagegen.test.mjs` (9 checks). PATCH-imagegen.md is no longer needed.
- lib/ocr.js + new lib/pdfText.js: for everyone who has not turned Extended models on, Mistral OCR was the ONLY PDF reader. It is billed per
  page out of the same ~$8.50 monthly credit as chat (a 10-page PDF costs about as much as 30 chat replies), takes seconds, depends on your
  Mistral key allowing OCR (nothing checked that), and sends the whole document to another company. PDFs that already contain text (most of
  them) are now read on the server with `unpdf` (a new dependency, 2.6 MB, no native code; run `npm install`): instant, free, private. Only PDFs
  that are pictures of pages go to OCR. Short headers or page numbers on a scan are not mistaken for text; garbled text (fonts with no mapping)
  falls back to OCR; a damaged or locked file falls back to OCR; reading never throws. Amharic and mixed-language PDFs were tested.
  `tests/pdfText.test.mjs` (15 checks, real PDFs, incl. the whole route a private person's PDF takes with a recording network).
- The file picker (public/miniapp/index.html, `uniqueUploadPath`): the server only accepts storage addresses up to 600 characters, and an address
  percent-encodes every non-ASCII letter (an Amharic letter is 9 characters). My per-upload folder (37 characters) plus a long Amharic file name
  could cross that and the message was refused as "attachments couldn't be read". The picker now shortens a name by its ENCODED length (about 240),
  keeping the ending (".docx"), so addresses stay near 340 characters. lib/safeUrl.js is unchanged. Tests in upload-path.test.cjs.
- lib/fileTypes.js, lib/imageResize.js: read, no problems found (HEIC photos from the Files app are the one gap: they are passed on as they are).
- The rest of the project's own tests (budgets 48, security 42, phase23-edit 55, phase1-create) pass with all of this merged in.

## Rules kept
12 serverless functions (no file added under api/), the assistant never names providers or models, migrations are manual SQL,
ESLint no-undef is clean on lib, api, db, scripts and tests.
