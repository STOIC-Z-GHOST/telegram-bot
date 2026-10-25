// Run from the project folder:  node --no-deprecation tests/imagegen.test.mjs
// Picture descriptions only go to the anonymous image service when the person turned Extended models on.

process.env.DATABASE_URL ||= "postgres://u:p@localhost.invalid/db";
process.env.CLOUDFLARE_ACCOUNT_ID = "acct";
process.env.CLOUDFLARE_API_TOKEN = "tok";
const Jimp = (await import("jimp")).default;
const jpeg = await new Jimp(64, 64, 0x3366ccff).getBufferAsync(Jimp.MIME_JPEG);
const { generateImage, friendlyImageError } = await import("../lib/imagegen.js");

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => { (cond ? pass++ : fail++); console.log(cond ? "ok  " : "FAIL", label, extra); };

const realFetch = globalThis.fetch;
const log = [];
let cloudflare = "ok";
const origWarn = console.warn; console.warn = () => {};
globalThis.fetch = async (url) => {
  const u = String(url); const host = new URL(u).host; log.push(host);
  if (host === "api.cloudflare.com") {
    if (cloudflare === "ok") return new Response(JSON.stringify({ result: { image: jpeg.toString("base64") } }), { status: 200, headers: { "content-type": "application/json" } });
    return new Response("busy", { status: 503 });
  }
  if (host === "image.pollinations.ai") return new Response(jpeg, { status: 200, headers: { "content-type": "image/jpeg" } });
  return new Response("{}", { status: 500 }); // the database driver and anything else: not available in this test
};
const run = async (opts, cf) => { log.length = 0; cloudflare = cf; try { const r = await generateImage("a red fox", opts); return { ok: true, hosts: [...new Set(log)], r }; } catch (e) { return { ok: false, hosts: [...new Set(log)], err: e }; } };

{
  const r = await run({ allowShared: false }, "ok");
  check("without a yes, Cloudflare working: the picture is made and nothing else is called", r.ok && !r.hosts.includes("image.pollinations.ai") && r.hosts.includes("api.cloudflare.com"));
}
{
  const r = await run({ allowShared: false }, "down");
  check("without a yes, Cloudflare down: Pollinations is NEVER called and the failure says it is a private-service problem", !r.ok && !r.hosts.includes("image.pollinations.ai") && r.err.privateBusy === true, r.hosts.join());
  check("the person is told to try again, that Extended models adds a backup, and that no allowance was spent", /try again in a minute/.test(friendlyImageError(r.err)) && /Extended models/.test(friendlyImageError(r.err)) && /didn't use any of your image allowance/.test(friendlyImageError(r.err)));
}
{
  const r = await run({}, "down");
  check("a caller that forgets the option is treated as private", !r.ok && !r.hosts.includes("image.pollinations.ai") && r.err.privateBusy === true);
  const r2 = await run(undefined, "down");
  check("no options at all is private too", !r2.ok && !r2.hosts.includes("image.pollinations.ai"));
  const r3 = await run({ allowShared: "yes" }, "down");
  check("only exactly true counts as a yes (a truthy string does not)", !r3.ok && !r3.hosts.includes("image.pollinations.ai"));
}
{
  const r = await run({ allowShared: true }, "down");
  check("with a yes, Cloudflare down: Pollinations rescues it", r.ok && r.hosts.includes("image.pollinations.ai"), r.hosts.join());
  const r2 = await run({ allowShared: true }, "ok");
  check("with a yes and Cloudflare working: Cloudflare still goes first and Pollinations is not needed", r2.ok && !r2.hosts.includes("image.pollinations.ai"));
}
check("an ordinary failure's wording is unchanged", /busy right now/.test(friendlyImageError(new Error("Pollinations error 503"))) && !/Extended models/.test(friendlyImageError(new Error("Pollinations error 503"))));

console.warn = origWarn;
globalThis.fetch = realFetch;
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
