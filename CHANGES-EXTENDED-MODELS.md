# Extended models (privacy setting) — what this zip is

A superset of health-patch.zip (the /health, /limits and Max-chain work) plus the finished privacy setting. Copy the files over the
project (baseline: telegram-bot-model-fixes (9).zip). Read README.md -> "Extended models" first.

## Before you deploy (in this order)
1. Run `db/migrate_data_sharing_v16.sql` in the Neon SQL editor (the settings API reads the new columns).
2. Apply `PATCH-imagegen.md` to `lib/imagegen.js` (that file was not in the upload).
3. In Vercel, delete `OPENROUTER_MAX_MODEL` and `OPENROUTER_IN_STANDARD` if they are still set (the free NVIDIA route logs prompts).
4. Deploy, then `/start` in the DM bot and open the mini app: both should ask once. Run `/limits`: each provider shows 🔒 or 🧩.

## Tests (run from the project folder)
- `node --no-deprecation tests/dataSharing.test.mjs`            44 checks, privacy rules end to end (new)
- `npm install --no-save jsdom && node tests/ui-extended-models.test.cjs`   16 checks on the real page (new)
- `node tests/upload-path.test.cjs`                              11 checks on the upload-path fix (new)
- models, health, providerLimits still pass (51 / 170 / 52). budgets, security and phase23-edit need files that were not in the upload
  (api/miniapp/usage.js and others): run them on your full project.

## Also fixed in this zip: "Vercel Blob: This blob already exists"
Cause: the mini app uploaded every attachment under its bare file name, so a second upload of "core 1 exercise.pdf" (another account, a
re-send, or two same-named files in one message) was refused. Fix (public/miniapp/index.html): each upload goes to `<random id>/<name>`,
and a failed upload shows "Couldn't upload "<name>". Please try again." instead of the storage error. Do NOT use allowOverwrite: it
would let one person replace another person's file. Test: `node tests/upload-path.test.cjs` (11 checks).
Optional second layer: in api/miniapp/blob-upload.js (not in my upload) return `addRandomSuffix: true` from onBeforeGenerateToken.

## Rules kept
12 serverless functions (no file added under api/), the assistant never names providers or models, migrations are manual SQL,
ESLint no-undef is clean on every file in this zip.
