# Patch needed in lib/imagegen.js (DO THIS BEFORE DEPLOYING)

`lib/imagegen.js` was not in the zip I received, so I could not edit it. The callers are already changed:

- `api/miniapp/messages.js` calls `generateImage(prompt, { allowShared })`
- `api/telegram-webhook.js` calls `generateImage(prompt, { allowShared })`

`allowShared` is `true` only for someone who turned Extended models on. Until `generateImage` honours it, people who said
"keep my chats private" still have their image descriptions sent to Pollinations (an unclassified service, so it counts as
shared), and the Details wording ("Your chats only go to models whose providers say they don't train on your data") would not be
true for image prompts.

## What to change

```js
// lib/imagegen.js
export async function generateImage(prompt, opts = {}) {
  const allowShared = opts.allowShared === true;   // missing = private

  // 1) try Cloudflare FLUX first, exactly as it does now
  // 2) the Pollinations fallback is for Extended models only:
  if (!allowShared) {
    throw new Error("PRIVATE_IMAGE_BUSY");          // Cloudflare failed or is out of neurons and the person said no
  }
  // ...existing Pollinations code...
}

// friendlyImageError(err): add one case
//   if (/PRIVATE_IMAGE_BUSY/.test(err.message)) return "Image generation is busy right now. Try again in a minute. (Turning on Extended models in Settings adds a backup.)";
```

Then add a line to `tests/dataSharing.test.mjs`: call `generateImage("a cat", { allowShared: false })` with Cloudflare failing and
check that `image.pollinations.ai` is never fetched. (I can write that test and apply this patch if you upload lib/imagegen.js.)
