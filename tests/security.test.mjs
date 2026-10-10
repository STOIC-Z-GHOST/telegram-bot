// Run from the project folder:  node --no-deprecation tests/security.test.mjs
// Checks lib/safeUrl.js and the way attachments.js uses it. No network, no database.

import { isOwnBlobUrl, fetchOwnBlob, readCapped, sanitizeAttachments, AttachmentFetchError, MAX_ATTACHMENTS } from "../lib/safeUrl.js";
import { analyzeAttachments } from "../lib/attachments.js";

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => { (cond ? pass++ : fail++); console.log(cond ? "ok  " : "FAIL", label, extra); };

// ---- which URLs may the server fetch?
const good = [
  "https://abc123.public.blob.vercel-storage.com/report.docx",
  "https://ABC123.public.blob.vercel-storage.com/a%20b.png?x=1",
];
const bad = [
  "http://abc123.public.blob.vercel-storage.com/a.png",              // not https
  "https://169.254.169.254/latest/meta-data/",                        // cloud metadata
  "https://localhost/a", "https://127.0.0.1/a", "https://[::1]/a", "https://10.0.0.5/a",
  "https://evil.com/blob.vercel-storage.com",                         // host is evil.com
  "https://blob.vercel-storage.com.evil.com/a",                       // suffix trick
  "https://evilblob.vercel-storage.com/a",                            // not a subdomain boundary
  "https://user:pw@abc.public.blob.vercel-storage.com/a",             // credentials
  "https://abc.public.blob.vercel-storage.com:8443/a",                // odd port
  "file:///etc/passwd", "javascript:alert(1)", "data:text/plain,hi", "", null, undefined, 42, {},
  "https://abc.public.blob.vercel-storage.com/" + "a".repeat(700),    // absurdly long
];
good.forEach((u) => check("allows " + u.slice(0, 55), isOwnBlobUrl(u) === true));
bad.forEach((u) => check("blocks " + String(u).slice(0, 55), isOwnBlobUrl(u) === false));

// ---- size cap (streamed, no content-length) and declared-length cap
const stream = (chunks) => new Response(new ReadableStream({ start(c) { for (const k of chunks) c.enqueue(k); c.close(); } }));
const kb = (n) => new Uint8Array(n * 1024);
check("readCapped: under cap", (await readCapped(stream([kb(100), kb(100)]), 1024 * 1024)).length === 200 * 1024);
let err; try { await readCapped(stream([kb(600), kb(600)]), 1024 * 1024); } catch (e) { err = e; }
check("readCapped: stops when streamed body passes the cap", err instanceof AttachmentFetchError, err?.message);
const declared = new Response(kb(1), { headers: { "content-length": String(5 * 1024 * 1024) } });
try { await readCapped(declared, 1024 * 1024); err = null; } catch (e) { err = e; }
check("readCapped: rejects on declared content-length", err instanceof AttachmentFetchError);

// ---- fetchOwnBlob with a fake fetch
const realFetch = globalThis.fetch;
let seen = [];
globalThis.fetch = async (url, opts) => { seen.push({ url, redirect: opts?.redirect }); return new Response(Buffer.from("hello"), { status: 200 }); };
const ok = await fetchOwnBlob(good[0], { maxBytes: 1024 });
check("fetchOwnBlob: returns the bytes", ok.toString() === "hello");
check("fetchOwnBlob: refuses redirects", seen[0]?.redirect === "error");
seen = [];
try { await fetchOwnBlob("https://169.254.169.254/x", { maxBytes: 1024 }); err = null; } catch (e) { err = e; }
check("fetchOwnBlob: bad host rejected BEFORE any request", err instanceof AttachmentFetchError && seen.length === 0, `requests made: ${seen.length}`);
globalThis.fetch = async () => new Response("nope", { status: 404 });
try { await fetchOwnBlob(good[0], { maxBytes: 1024 }); err = null; } catch (e) { err = e; }
check("fetchOwnBlob: 404 is an error", err instanceof AttachmentFetchError);
globalThis.fetch = async () => { throw new Error("redirect mode is error"); };
try { await fetchOwnBlob(good[0], { maxBytes: 1024 }); err = null; } catch (e) { err = e; }
check("fetchOwnBlob: a redirect/network failure is a friendly error", err instanceof AttachmentFetchError && !/redirect mode/.test(err.message), err?.message);

// ---- analyzeAttachments turns a refused download into a normal ⚠️ reply
globalThis.fetch = async () => { throw new Error("must not be called"); };
const r1 = await analyzeAttachments([{ url: "https://169.254.169.254/latest/meta-data/", name: "x.pdf", type: "application/pdf" }], "summarise");
check("analyzeAttachments: metadata URL -> ⚠️ reply, no fetch", /^⚠️/.test(r1.text) && r1.tokensUsed === null, r1.text);
const r2 = await analyzeAttachments([{ url: "https://internal.example/x.png", name: "x.png", type: "image/png" }], "what is this");
check("analyzeAttachments: image path too", /^⚠️/.test(r2.text), r2.text);
globalThis.fetch = realFetch;

// ---- the attachments array
const u = good[0];
const s1 = sanitizeAttachments([{ url: u, name: "a\u0000b\nc.txt", type: "text/plain", bytes: 10.7, generated: true, evil: { x: 1 } }]);
check("sanitize: keeps only url/name/type/bytes", s1.ok && Object.keys(s1.attachments[0]).sort().join() === "bytes,name,type,url", JSON.stringify(s1.attachments?.[0]));
check("sanitize: strips control chars, floors bytes", s1.attachments[0].name === "abc.txt" && s1.attachments[0].bytes === 10);
check("sanitize: empty type allowed (xlsx on some browsers)", sanitizeAttachments([{ url: u, name: "a.xlsx", type: "", bytes: 5 }]).ok);
check("sanitize: undefined/null -> empty list", sanitizeAttachments(undefined).attachments.length === 0 && sanitizeAttachments(null).ok);
check("sanitize: 20 images OK", sanitizeAttachments(Array.from({ length: MAX_ATTACHMENTS }, () => ({ url: u, name: "i.png", type: "image/png", bytes: 1 }))).ok);
check("sanitize: 21 rejected", !sanitizeAttachments(Array.from({ length: MAX_ATTACHMENTS + 1 }, () => ({ url: u, name: "i.png", type: "image/png", bytes: 1 }))).ok);
check("sanitize: a foreign URL anywhere rejects all", !sanitizeAttachments([{ url: u, name: "a" }, { url: "https://evil.com/a", name: "b" }]).ok);
check("sanitize: non-array rejected", !sanitizeAttachments("x").ok && !sanitizeAttachments({ url: u }).ok);
check("sanitize: bad bytes -> 0", sanitizeAttachments([{ url: u, name: "a", type: "", bytes: -5 }]).attachments[0].bytes === 0 && sanitizeAttachments([{ url: u, name: "a", type: "", bytes: "9" }]).attachments[0].bytes === 0);
check("sanitize: huge name truncated", sanitizeAttachments([{ url: u, name: "n".repeat(900), type: "" }]).attachments[0].name.length === 200);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
