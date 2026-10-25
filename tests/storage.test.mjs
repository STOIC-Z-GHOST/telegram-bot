// Run from the project folder:  npm install --no-save @electric-sql/pglite && node --no-deprecation tests/storage.test.mjs
// (pglite is a real Postgres running inside Node — it is NOT a project dependency, only used here.)
// Checks lib/storage.js and the early_access queries against actual SQL, so the jsonb queries and the quota rules are proven,
// not just imagined: who sees which files, what a quota refuses, what delete and the daily cleanup remove (and what they must not).

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";

process.env.DATABASE_URL ||= "postgres://u:p@localhost.invalid/db";
const storage = await import("../lib/storage.js");
const { depsFor } = await import("../lib/earlyAccess.js");
const { messages } = await import("../db/schema.js");
const { sql } = await import("drizzle-orm");

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => { (cond ? pass++ : fail++); console.log(cond ? "ok  " : "FAIL", label, extra); };

const pg = new PGlite();
const database = drizzle(pg);
await pg.exec(`
  CREATE TABLE chats (id serial PRIMARY KEY, telegram_user_id bigint NOT NULL, title text NOT NULL DEFAULT 'New chat',
    created_at timestamp NOT NULL DEFAULT now(), updated_at timestamp NOT NULL DEFAULT now(), last_search_context text, last_search_at timestamp, pinned_at timestamp);
  CREATE TABLE messages (id serial PRIMARY KEY, chat_id integer NOT NULL REFERENCES chats(id) ON DELETE CASCADE, role text NOT NULL, content text NOT NULL,
    attachment_url text, attachment_name text, attachment_type text, attachments jsonb, created_at timestamp NOT NULL DEFAULT now());
  CREATE TABLE early_access (telegram_user_id bigint PRIMARY KEY, granted_at timestamp NOT NULL DEFAULT now());
`);

const MB = 1024 * 1024;
const NOW = new Date("2026-11-10T12:00:00Z");
const daysAgo = (d) => new Date(NOW.getTime() - d * 86400000).toISOString().replace("T", " ").replace("Z", "");
const blob = (name) => `https://abc123.public.blob.vercel-storage.com/${name}`;
const chat = async (user, title) => (await pg.query("INSERT INTO chats (telegram_user_id, title) VALUES ($1, $2) RETURNING id", [user, title])).rows[0].id;
const msg = async (chatId, role, attachments, ageDays = 1) =>
  (await pg.query("INSERT INTO messages (chat_id, role, content, attachments, created_at) VALUES ($1, $2, 'x', $3::jsonb, $4) RETURNING id", [chatId, role, attachments === null ? null : JSON.stringify(attachments), daysAgo(ageDays)])).rows[0].id;
const attachmentsOf = async (id) => (await pg.query("SELECT attachments FROM messages WHERE id = $1", [id])).rows[0].attachments;

// ---- pure helpers
check("only our own Blob storage counts as a file url", storage.isBlobUrl(blob("a.png")) && !storage.isBlobUrl("https://evil.example/a.png") && !storage.isBlobUrl("http://x.public.blob.vercel-storage.com/a") && !storage.isBlobUrl("not a url") && !storage.isBlobUrl("https://blob.vercel-storage.com.evil.com/a"));
check("storageDecision: under the quota is fine", storage.storageDecision({ used: 5 * MB, quota: 20 * MB, adding: 4 * MB }).allowed);
check("storageDecision: a file that would pass the quota is refused with the numbers and where to fix it", (() => { const d = storage.storageDecision({ used: 18 * MB, quota: 20 * MB, adding: 4 * MB }); return !d.allowed && /20 MB/.test(d.reason) && /18 MB/.test(d.reason) && /Settings → Storage/.test(d.reason); })());
check("storageDecision: someone at the quota cannot add even a tiny file; someone just under can add a file that lands exactly on it", !storage.storageDecision({ used: 20 * MB, quota: 20 * MB, adding: 1 }).allowed && storage.storageDecision({ used: 19 * MB, quota: 20 * MB, adding: 1 * MB }).allowed);
check("storageDecision: the owner and 'no quota' are never refused", storage.storageDecision({ used: 999 * MB, quota: 20 * MB, adding: MB, owner: true }).allowed && storage.storageDecision({ used: 999 * MB, quota: null, adding: MB }).allowed);
{
  const a = [{ url: blob("1"), name: "a", type: "image/png", bytes: 5 }, { url: blob("2"), name: "b", type: "application/pdf", bytes: 7 }, null, { name: "no url" }];
  const m = storage.markRemoved(a, [blob("1")], NOW);
  check("markRemoved turns only the chosen file into a placeholder (name, type, size kept; url gone) and leaves the rest alone", m[0].removed === true && m[0].url === undefined && m[0].name === "a" && m[0].bytes === 5 && m[1] === a[1] && m[2] === null && m[3] === a[3]);
  check("markRemoved on junk input returns an empty array instead of throwing", storage.markRemoved(null, [blob("1")]).length === 0);
}
check("a file's expiry follows its source: uploads 7 days, things the bot made 30", (() => { const up = { createdAt: new Date("2026-11-01T00:00:00Z"), source: "upload" }, gen = { createdAt: new Date("2026-11-01T00:00:00Z"), source: "generated" }; return storage.expiresAtFor(up).toISOString().startsWith("2026-11-08") && storage.expiresAtFor(gen).toISOString().startsWith("2026-12-01"); })());

// ---- real SQL: who sees what
const A = await chat(1, "Exam help"), B = await chat(1, "Pictures"), C = await chat(2, "Someone else's chat");
const upload1 = await msg(A, "user", [{ url: blob("u1"), name: "core 1 exercise.docx", type: "application/vnd.openxmlformats", bytes: 2 * MB }, { url: blob("u2"), name: "notes.pdf", type: "application/pdf" }], 3);
const gen1 = await msg(B, "assistant", [{ url: blob("g1"), name: "a red fox.jpg", type: "image/jpeg", bytes: 300 * 1024 }], 2);
const oldRemoved = await msg(A, "user", [{ name: "gone.png", type: "image/png", bytes: 5, removed: true, removedAt: "2026-10-01" }], 20);
await msg(A, "assistant", null, 1);
await msg(A, "assistant", [], 1);
const theirs = await msg(C, "user", [{ url: blob("other1"), name: "theirs.png", type: "image/png", bytes: 9 * MB }], 1);

{
  const s = await storage.getStorage(1, { quota: 20 * MB, now: NOW, database });
  check("a person sees exactly their own live files, newest first, and never someone else's", s.files.map((f) => f.name).join("|") === "a red fox.jpg|core 1 exercise.docx|notes.pdf", s.files.map((f) => f.name).join("|"));
  check("used space adds up what is known (a file with no recorded size counts as 0)", s.usedBytes === 2 * MB + 300 * 1024 && s.quotaBytes === 20 * MB, String(s.usedBytes));
  check("each file says whether it is an upload or made by the bot, which chat, and when it will be deleted", s.files[0].source === "generated" && s.files[1].source === "upload" && s.files[1].chatTitle === "Exam help" && s.files.every((f) => typeof f.daysLeft === "number"));
  check("the retention days are reported so the screen can say them out loud", s.uploadDays === 7 && s.generatedDays === 30);
}
{
  const ok = await storage.checkStorageQuota(1, 1 * MB, { quota: 20 * MB, database });
  const tooBig = await storage.checkStorageQuota(1, 19 * MB, { quota: 20 * MB, database });
  const full = await storage.checkStorageQuota(1, 1, { quota: 2 * MB, database });
  check("quota check against the real numbers: small file ok, big file refused, full storage refuses everything", ok.allowed && !tooBig.allowed && !full.allowed);
  const other = await storage.checkStorageQuota(2, 5 * MB, { quota: 10 * MB, database });
  check("another person's files count only against them (9 MB + 5 MB > 10 MB for them, but not for the first person)", !other.allowed);
}

// ---- verifying sizes the browser claimed
{
  const out = await storage.verifiedAttachments([{ url: blob("a"), name: "a", bytes: 1 }, { url: blob("b"), name: "b", bytes: 7 }], { size: async (u) => (u.endsWith("a") ? 5 * MB : (() => { throw new Error("head failed"); })()) });
  check("sizes are read back from storage (a lie of '1 byte' becomes 5 MB); if storage can't say, the claimed size is kept", out[0].bytes === 5 * MB && out[1].bytes === 7);
}

// ---- self-service delete
{
  const removedFromBlob = [];
  const ops = { del: async (urls) => { removedFromBlob.push(...urls); } };
  const r = await storage.deleteUserFiles(1, { urls: [blob("u1"), blob("other1"), "https://evil.example/x", 42] }, { ops, database, now: NOW });
  check("delete removes the person's own file from storage and nothing else (another person's url and junk are ignored)", r.filesRemoved === 1 && removedFromBlob.join() === blob("u1"), JSON.stringify(r));
  const after = await attachmentsOf(upload1);
  check("the chat message keeps its other file and shows the deleted one as removed (no url)", after[0].removed === true && after[0].url === undefined && after[0].name === "core 1 exercise.docx" && after[1].url === blob("u2"), JSON.stringify(after));
  check("another person's message was not touched", (await attachmentsOf(theirs))[0].url === blob("other1"));
  const again = await storage.deleteUserFiles(1, { urls: [blob("u1")] }, { ops, database, now: NOW });
  check("deleting the same file twice does nothing the second time", again.filesRemoved === 0 && removedFromBlob.length === 1);
  const s = await storage.getStorage(1, { quota: 20 * MB, now: NOW, database });
  check("the storage view and the used space update", s.files.length === 2 && s.usedBytes === 300 * 1024);
}
{
  const failing = { del: async () => { throw new Error("blob service down"); } };
  const e = console.error; console.error = () => {};
  const r = await storage.deleteUserFiles(1, { urls: [blob("g1")] }, { ops: failing, database, now: NOW });
  console.error = e;
  check("if storage can't delete, the file is NOT marked removed (so nothing is lost silently) and the failure is reported", r.filesRemoved === 0 && r.failed === 1 && (await attachmentsOf(gen1))[0].url === blob("g1"), JSON.stringify(r));
}
{
  const removedFromBlob = [];
  const r = await storage.deleteUserFiles(1, { all: true }, { ops: { del: async (u) => removedFromBlob.push(...u) }, database, now: NOW });
  check("'delete all' removes every remaining file of that person and none of anyone else's", r.filesRemoved === 2 && !removedFromBlob.includes(blob("other1")) && (await attachmentsOf(theirs))[0].url === blob("other1"), JSON.stringify(r));
  check("after that their storage is empty", (await storage.getStorage(1, { quota: 20 * MB, now: NOW, database })).files.length === 0);
}

// ---- cleaning up files from refused messages
{
  const gone = [];
  const n = await storage.discardUnreferencedBlobs([blob("other1"), blob("fresh-orphan"), blob("fresh-orphan"), "https://evil.example/z"], { ops: { del: async (u) => gone.push(...u) }, database });
  check("a refused upload is removed, but a file that a chat already points at (someone else's) never is, and non-storage urls are ignored", n === 1 && gone.join() === blob("fresh-orphan"), gone.join());
}

// ---- the daily cleanup
{
  const D = await chat(3, "Cleanup test");
  const oldUpload = await msg(D, "user", [{ url: blob("old-up"), name: "old.pdf", type: "application/pdf", bytes: 1 }], 10);
  const freshUpload = await msg(D, "user", [{ url: blob("fresh-up"), name: "new.pdf", type: "application/pdf", bytes: 1 }], 2);
  const midGenerated = await msg(D, "assistant", [{ url: blob("mid-gen"), name: "mid.jpg", type: "image/jpeg", bytes: 1 }], 20);
  const oldGenerated = await msg(D, "assistant", [{ url: blob("old-gen"), name: "old.jpg", type: "image/jpeg", bytes: 1 }], 40);
  const mixed = await msg(D, "user", [{ url: blob("mixed-old"), name: "m1.pdf", type: "application/pdf", bytes: 1 }, { name: "was removed", removed: true }], 9);
  // 320 old messages whose files are all gone already: they must not use up the daily batch
  await pg.exec(`INSERT INTO messages (chat_id, role, content, attachments, created_at)
                 SELECT ${D}, 'user', 'x', '[{"name":"x","removed":true}]'::jsonb, now() - interval '60 days' FROM generate_series(1, 320)`);
  const gone = [];
  const r = await storage.cleanupExpiredFiles({ now: NOW, ops: { del: async (u) => gone.push(...u) }, database });
  check("cleanup deletes uploads older than 7 days and things the bot made older than 30, and nothing newer", gone.sort().join() === [blob("mixed-old"), blob("old-gen"), blob("old-up")].sort().join(), gone.join());
  check("newer files are untouched", (await attachmentsOf(freshUpload))[0].url === blob("fresh-up") && (await attachmentsOf(midGenerated))[0].url === blob("mid-gen"));
  check("the expired ones become 'removed' in their chats, and a message with an already-removed entry keeps it", (await attachmentsOf(oldUpload))[0].removed === true && (await attachmentsOf(oldGenerated))[0].removed === true && (await attachmentsOf(mixed)).every((a) => a.removed === true));
  check("hundreds of already-emptied old messages do not use up the batch (the expired files behind them were still reached)", r.filesRemoved === 3 && r.more === false, JSON.stringify(r));
  const again = await storage.cleanupExpiredFiles({ now: NOW, ops: { del: async () => { throw new Error("should not be called"); } }, database });
  check("running it again the same day removes nothing and never calls storage (the 20-day-old generated image is looked at but kept)", again.filesRemoved === 0 && again.failed === 0 && again.looked === 1, JSON.stringify(again));
}


// ---- big files go sooner
{
  const big = (days, bytes, source = "upload") => ({ messageId: 1, chatId: 1, chatTitle: "t", role: source === "generated" ? "assistant" : "user", createdAt: new Date(NOW.getTime() - days * 86400000), attachments: [{ url: blob(`big-${days}-${bytes}-${source}`), name: "x", type: "application/zip", bytes }] });
  const expired = (rows) => storage.selectExpired(rows, NOW).flatMap((e) => e.urls).length;
  check("a file over 50 MB is deleted after 3 days, not 7", expired([big(4, 60 * MB)]) === 1 && expired([big(2, 60 * MB)]) === 0);
  check("a file at or under 50 MB keeps the normal 7 days", expired([big(4, 50 * MB)]) === 0 && expired([big(4, 20 * MB)]) === 0 && expired([big(8, 20 * MB)]) === 1);
  check("it applies to things the bot made too (30 days normally, 3 when big)", expired([big(4, 60 * MB, "generated")]) === 1 && expired([big(4, 20 * MB, "generated")]) === 0);
  const f = (bytes, source = "upload") => ({ createdAt: new Date("2026-11-01T00:00:00Z"), source, bytes });
  check("the Storage screen shows the shorter date for a big file", storage.expiresAtFor(f(80 * MB)).toISOString().startsWith("2026-11-04") && storage.expiresAtFor(f(1 * MB)).toISOString().startsWith("2026-11-08") && storage.expiresAtFor(f(80 * MB, "generated")).toISOString().startsWith("2026-11-04"));
  check("the big-file rule only ever shortens (a 1-day rule would still win over it; a 10-day one never lengthens)", storage.selectExpired([big(4, 60 * MB)], NOW, 7, 30, 50 * MB, 10).length === 0 && storage.selectExpired([big(4, 60 * MB)], NOW, 2, 30, 50 * MB, 10).length === 1);
}
{
  const E = await chat(4, "Big files");
  const bigOld = await msg(E, "user", [{ url: blob("huge"), name: "huge.zip", type: "application/zip", bytes: 120 * MB }], 4);
  const smallSame = await msg(E, "user", [{ url: blob("small4"), name: "small.pdf", type: "application/pdf", bytes: 2 * MB }], 4);
  const gone = [];
  const r = await storage.cleanupExpiredFiles({ now: NOW, ops: { del: async (u) => gone.push(...u) }, database });
  check("the daily cleanup reaches a 4-day-old big file (the SQL cutoff follows the shortest rule) and leaves the small one", gone.includes(blob("huge")) && !gone.includes(blob("small4")) && (await attachmentsOf(bigOld))[0].removed === true && (await attachmentsOf(smallSame))[0].url === blob("small4"), JSON.stringify(r));
  const s = await storage.getStorage(4, { quota: 250 * MB, now: NOW, database });
  check("the storage view reports the big-file rule so the screen can say it", s.largeMB === 50 && s.largeDays === 3);
}

// ---- the one-query total matches the list
{
  const F = await chat(5, "Totals");
  await msg(F, "user", [{ url: blob("t1"), name: "a", type: "x", bytes: 3 * MB }, { url: blob("t2"), name: "b", type: "x" }, { name: "removed", removed: true, bytes: 99 * MB }], 1);
  await msg(F, "assistant", [{ url: blob("t3"), name: "c", type: "image/png", bytes: 500 }], 1);
  await msg(F, "user", null, 1);
  await pg.query("INSERT INTO messages (chat_id, role, content, attachments) VALUES ($1, 'user', 'x', $2::jsonb)", [F, JSON.stringify([{ url: blob("t4"), name: "junk size", type: "x", bytes: "not a number" }])]);
  const total = await storage.storageUsedBytes(5, database);
  const list = (await storage.getStorage(5, { quota: 1, now: NOW, database })).usedBytes;
  check("storageUsedBytes equals the file list's total (3 MB + 500 B; removed files, empty sizes and junk sizes count as 0)", total === 3 * MB + 500 && total === list, `${total} vs ${list}`);
  check("a person with no files has 0 stored", (await storage.storageUsedBytes(424242, database)) === 0);
}

// ---- early access, against real SQL
{
  const deps = depsFor(database);
  check("early access: the first people are let in while places remain", (await deps.grant(101, 2)) === true && (await deps.grant(102, 2)) === true);
  check("early access: when the places are full the next person is refused, and the table keeps exactly 2", (await deps.grant(103, 2)) === false && (await deps.taken()) === 2);
  check("early access: someone already in is recognised, and asking again never adds a second row", (await deps.readRow(101)) === true && (await deps.grant(101, 5)) === false && (await deps.taken()) === 2);
  check("early access: a person not in is not recognised", (await deps.readRow(999)) === false);
  check("early access: raising the places lets the next person in", (await deps.grant(103, 3)) === true && (await deps.taken()) === 3);
}

console.log(`\n${pass} passed, ${fail} failed`);
await pg.close();
process.exit(fail ? 1 : 0);
