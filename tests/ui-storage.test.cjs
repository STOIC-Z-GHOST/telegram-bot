// Run from the project folder:  npm install --no-save jsdom && node tests/ui-storage.test.cjs
// Runs the REAL public/miniapp/index.html in jsdom with a pretend server and checks Settings -> Storage:
// the usage line and bar, the list, selecting, the confirmation, what gets sent, failures, and how a removed file looks in a chat.

const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => { (cond ? pass++ : fail++); console.log(cond ? "ok  " : "FAIL", label, extra); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const MB = 1024 * 1024;

const COPY = { title: "Extended models", badge: "More models", summary: "s", detailsButton: "Details", hideDetailsButton: "Hide details", details: [], allowButton: "a", denyButton: "d" };
const file = (n, o = {}) => ({ url: `https://x.public.blob.vercel-storage.com/${n}`, name: `${n}.pdf`, type: "application/pdf", bytes: MB, source: "upload", chatTitle: "Exam help", daysLeft: 3, ...o });

async function boot({ storage, failLoad = false, failDelete = false, chats = [], history = [], confirmAnswer = true, usage = null }) {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "miniapp", "index.html"), "utf8");
  const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  const code = m[1].replace(/import \{ upload \} from "[^"]+";/, "const upload = async () => ({});");
  const dom = new JSDOM(html.replace(/<script[\s\S]*?<\/script>/g, ""), { runScripts: "outside-only", pretendToBeVisual: true, url: "https://example.test/miniapp/" });
  const w = dom.window;
  const calls = [];
  w.confirm = () => confirmAnswer;
  const alerts = []; w.alert = (m) => alerts.push(m);
  w.Telegram = { WebApp: { initData: "fake", ready() {}, expand() {}, disableVerticalSwipes() {}, onEvent() {}, themeParams: {}, initDataUnsafe: { user: { id: 1 } }, HapticFeedback: { impactOccurred() {} }, close() {}, BackButton: { show() {}, hide() {}, onClick() {} } } };
  w.requestAnimationFrame = (f) => setTimeout(f, 0);
  w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  let current = storage;
  w.fetch = async (url, opts = {}) => {
    const u = String(url);
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (u.includes("/api/miniapp/settings?section=storage")) return failLoad ? json({ error: "x" }, 500) : json(current);
    if (u.endsWith("/api/miniapp/settings")) {
      if (opts.method === "POST") {
        const body = JSON.parse(opts.body);
        calls.push(body);
        if (body.storageDelete) {
          if (failDelete) return json({ error: "boom" }, 500);
          const gone = new Set(body.storageDelete.urls);
          const files = current.files.filter((f) => !gone.has(f.url));
          current = { ...current, files, usedBytes: files.reduce((s, f) => s + f.bytes, 0) };
          return json({ filesRemoved: gone.size, failed: 0, storage: current });
        }
        return json({});
      }
      return json({ memoryEnabled: false, dataSharing: { allow: false, choice: false, needsAnswer: false, version: 1 }, dataSharingCopy: COPY });
    }
    if (u.endsWith("/api/miniapp/usage")) return usage ? json(usage) : json({ error: "x" }, 500);
    if (u.includes("/api/miniapp/messages?chatId=")) return json(history);
    if (u.includes("/api/miniapp/chats")) return json(chats);
    return json({});
  };
  w.eval(code);
  await wait(60);
  return { w, doc: w.document, calls, alerts };
}
const $ = (doc, id) => doc.getElementById(id);
const openSettings = async (doc) => { doc.getElementById("open-settings-btn").click(); await wait(60); };
const visible = (w, el) => !el.hidden && w.getComputedStyle(el).display !== "none";

(async () => {
  const base = { quotaBytes: 20 * MB, uploadDays: 7, generatedDays: 30, largeMB: 50, largeDays: 3 };
  const files = [file("a", { bytes: 2 * MB, daysLeft: 1 }), file("b", { name: "fox.jpg", type: "image/jpeg", bytes: 300 * 1024, source: "generated", daysLeft: 20 }), file("c", { bytes: 0, daysLeft: 0 })];
  const storage = { ...base, usedBytes: 2 * MB + 300 * 1024, files };

  // ---- the Settings row
  {
    const { doc } = await boot({ storage });
    await openSettings(doc);
    check("Settings shows how much is used of the plan's allowance", /2\.3 MB of 20 MB used/.test($(doc, "storage-summary").textContent), $(doc, "storage-summary").textContent);
    check("the bar is filled in proportion (2.3 of 20 MB is about 11%) and the Manage button works", $(doc, "storage-bar-fill").style.width === "11%" && $(doc, "storage-open-btn").disabled === false, $(doc, "storage-bar-fill").style.width);
  }
  {
    const { doc } = await boot({ storage: { ...base, usedBytes: 20 * MB, files } });
    await openSettings(doc);
    check("a full store says so plainly and turns the bar red", /full/.test($(doc, "storage-summary").textContent) && $(doc, "storage-bar-fill").classList.contains("full"));
  }
  {
    const { doc } = await boot({ storage: { ...base, usedBytes: 17 * MB, files } });
    await openSettings(doc);
    check("close to full (85%) turns the bar amber", $(doc, "storage-bar-fill").classList.contains("warn") && !$(doc, "storage-bar-fill").classList.contains("full"));
  }
  {
    const { doc } = await boot({ storage: { ...base, quotaBytes: null, usedBytes: 5 * MB, files } });
    await openSettings(doc);
    check("no quota (the owner) shows just what is used", $(doc, "storage-summary").textContent === "5 MB used" && $(doc, "storage-bar-fill").style.width === "0%", $(doc, "storage-summary").textContent);
  }
  {
    const { doc } = await boot({ storage, failLoad: true });
    await openSettings(doc);
    check("if storage can't be loaded the row says so and Manage is switched off", /Couldn't load your storage/.test($(doc, "storage-summary").textContent) && $(doc, "storage-open-btn").disabled === true);
  }

  // ---- the sheet
  {
    const { w, doc, calls } = await boot({ storage, confirmAnswer: false });
    await openSettings(doc);
    $(doc, "storage-open-btn").click();
    await wait(30);
    const rows = [...doc.querySelectorAll("#storage-list .storage-item")];
    check("the sheet opens and lists every file with its name", doc.getElementById("storage-sheet").classList.contains("open") && rows.length === 3 && rows[1].textContent.includes("fox.jpg"));
    check("each row says its size, whether you sent it or the bot made it, and when it will be deleted", /2 MB · you sent · deletes tomorrow/.test(rows[0].textContent) && /300 KB · made by the bot · deletes in 20 days/.test(rows[1].textContent) && /deletes today/.test(rows[2].textContent), rows.map((r) => r.querySelector(".storage-item-meta").textContent).join(" | "));
    check("a picture shows a thumbnail, other files a document icon", !!rows[1].querySelector(".storage-thumb img") && rows[0].querySelector(".storage-thumb").textContent === "📄");
    check("the sheet says how long things are kept", /7 days/.test($(doc, "storage-note").textContent) && /30 days/.test($(doc, "storage-note").textContent) && /removed/.test($(doc, "storage-note").textContent));
    check("nothing is selected at first and Delete is off", $(doc, "storage-delete-btn").disabled === true && $(doc, "storage-selected-count").textContent === "");

    rows[0].querySelector("input").click();
    check("selecting one file counts it and turns Delete on", $(doc, "storage-selected-count").textContent === "1 selected" && $(doc, "storage-delete-btn").disabled === false && $(doc, "storage-delete-btn").textContent === "Delete 1 file");
    $(doc, "storage-select-all").click();
    check("Select all picks every file and the button becomes Select none", [...doc.querySelectorAll("#storage-list input")].every((b) => b.checked) && $(doc, "storage-delete-btn").textContent === "Delete 3 files" && $(doc, "storage-select-all").textContent === "Select none");
    $(doc, "storage-select-all").click();
    check("Select none clears the choice", $(doc, "storage-delete-btn").disabled === true);

    rows[1].querySelector("input").click();
    $(doc, "storage-delete-btn").click();
    await wait(30);
    check("if you say no to 'this can't be undone', nothing is sent", calls.filter((c) => c.storageDelete).length === 0 && doc.querySelectorAll("#storage-list .storage-item").length === 3);
    check("the sheet closes with Done", (() => { $(doc, "storage-close-btn").click(); return !doc.getElementById("storage-sheet").classList.contains("open"); })());
    void w;
  }
  {
    const { doc, calls } = await boot({ storage, confirmAnswer: true });
    await openSettings(doc);
    $(doc, "storage-open-btn").click();
    await wait(30);
    const rows = [...doc.querySelectorAll("#storage-list .storage-item")];
    rows[1].querySelector("input").click();
    rows[2].querySelector("input").click();
    $(doc, "storage-delete-btn").click();
    await wait(60);
    const sent = calls.find((c) => c.storageDelete);
    check("confirming sends exactly the chosen files' urls", !!sent && sent.storageDelete.urls.length === 2 && sent.storageDelete.urls.includes(files[1].url) && sent.storageDelete.urls.includes(files[2].url) && !sent.storageDelete.all, JSON.stringify(sent));
    check("afterwards the list, the totals and the Settings bar all update", doc.querySelectorAll("#storage-list .storage-item").length === 1 && /^2 MB of 20 MB used$/.test($(doc, "storage-sheet-summary").textContent) && /2 MB of 20 MB used/.test($(doc, "storage-summary").textContent), $(doc, "storage-sheet-summary").textContent);
    check("and nothing is left selected", $(doc, "storage-delete-btn").disabled === true);
  }
  {
    const { doc } = await boot({ storage, confirmAnswer: true, failDelete: true });
    await openSettings(doc);
    $(doc, "storage-open-btn").click();
    await wait(30);
    doc.querySelector("#storage-list .storage-item input").click();
    $(doc, "storage-delete-btn").click();
    await wait(60);
    check("if deleting fails the files stay listed, an error shows, and Delete stays available", doc.querySelectorAll("#storage-list .storage-item").length === 3 && $(doc, "storage-error").hidden === false && $(doc, "storage-delete-btn").disabled === false);
  }
  {
    const { doc } = await boot({ storage: { ...base, usedBytes: 0, files: [] } });
    await openSettings(doc);
    $(doc, "storage-open-btn").click();
    await wait(30);
    check("with nothing stored the sheet says so and hides the select button", $(doc, "storage-empty").hidden === false && $(doc, "storage-select-all").hidden === true);
  }

  // ---- a removed file inside an old chat
  {
    const history = [
      { id: 1, role: "user", content: "see this", createdAt: new Date().toISOString(), attachments: [{ name: "core 1 exercise.docx", type: "application/vnd.openxmlformats", bytes: 1000, removed: true, removedAt: "2026-11-01" }] },
      { id: 2, role: "user", content: "and this", createdAt: new Date().toISOString(), attachments: [{ name: "photo.png", type: "image/png", bytes: 1000, removed: true }, { url: "https://x.public.blob.vercel-storage.com/live.pdf", name: "live.pdf", type: "application/pdf" }] },
    ];
    const { w, doc } = await boot({ storage, chats: [{ id: 5, title: "Exam help", updatedAt: new Date().toISOString() }], history });
    doc.querySelector(".chat-row").click();
    await wait(80);
    const chips = [...doc.querySelectorAll(".bubble-attachment-file")];
    const removed = chips.filter((c) => c.classList.contains("removed"));
    check("in an old chat a removed document shows as '🗑️ name — removed'", removed.some((c) => c.textContent === "🗑️ core 1 exercise.docx — removed"), chips.map((c) => c.textContent).join(" | "));
    check("a removed picture is a placeholder too, not a broken image", removed.some((c) => c.textContent === "🗑️ photo.png — removed") && doc.querySelectorAll(".bubble-attachment-image").length === 0);
    check("a file that still exists next to it is shown normally", chips.some((c) => c.textContent === "📎 live.pdf" && !c.classList.contains("removed")));
    void w; void visible;
  }


  // ---- early access + storage numbers coming from the usage endpoint
  const usage = { isOwner: false, tier: "premium", paidTier: "free", earlyAccess: true, trial: null, messageWindow: "hour", messagesUsed: 3, messagesLimit: 100,
    tokensUsed: 1000, maxTokens: 4500000, tokenWindowDays: 30, imagesLast30Days: 0, imageGenPerMonth: 1000, maxImagesPerMessage: 5, proFileExts: [], canUseProFiles: true,
    voice: { perDay: 100, used: 0, maxSeconds: 180 }, messagesResetAt: null, tokensResetAt: null, storage: { usedBytes: 19 * MB, quotaBytes: 20 * MB },
    referrals: { credited: 0, nextMilestoneAt: 5, code: "abc", link: "https://t.me/AskAssistAIBot?start=abc" } };
  {
    const { doc } = await boot({ storage, usage });
    await wait(60);
    check("an early-access person's plan says 'Premium (early access)' and the menu badge says 'Early access'", /Current plan: Premium \(early access\)/.test($(doc, "current-tier-label").textContent) && $(doc, "plan-menu-badge").textContent === "Early access" && $(doc, "plan-menu-badge").hidden === false, $(doc, "current-tier-label").textContent);
    check("they still see the invite link (that is how early access spreads) and the Subscribe buttons", $(doc, "invite-section").hidden === false && /start=abc/.test($(doc, "invite-link-input").value) && $(doc, "upgrade-premium-btn").hidden === false);
  }
  {
    const pick = async (doc, w, sizesMB) => {
      const input = doc.getElementById("file-input");
      const list = sizesMB.map((mb, i) => { const f = new w.File(["x"], `f${i}.pdf`, { type: "application/pdf" }); Object.defineProperty(f, "size", { value: mb * MB }); return f; });
      Object.defineProperty(input, "files", { value: list, configurable: true });
      input.dispatchEvent(new w.Event("change"));
      await wait(20);
      return input;
    };
    const a = await boot({ storage, usage });
    await wait(60);
    await pick(a.doc, a.w, [3]);
    check("choosing a file bigger than the space left (3 MB with 1 MB left) is stopped at once, kindly, before any upload", a.alerts.length === 1 && /1 MB of storage you have left/.test(a.alerts[0]) && /Settings → Storage/.test(a.alerts[0]), a.alerts.join("|"));
    const b = await boot({ storage, usage });
    await wait(60);
    await pick(b.doc, b.w, [0.5]);
    check("a file that fits is accepted without any warning", b.alerts.length === 0);
    const c = await boot({ storage, usage: { ...usage, storage: { usedBytes: 20 * MB, quotaBytes: 20 * MB } } });
    await wait(60);
    await pick(c.doc, c.w, [0.1]);
    check("with storage completely full, even a tiny file is stopped and told to delete something", c.alerts.length === 1 && /storage is full/.test(c.alerts[0]), c.alerts.join("|"));
    const d = await boot({ storage, usage: { ...usage, storage: null } });
    await wait(60);
    await pick(d.doc, d.w, [3]);
    check("if the server couldn't say how much is used, the picker does not guess (the server still checks)", d.alerts.length === 0);
  }
  {
    const { doc } = await boot({ storage: { ...storage, largeMB: 50, largeDays: 3 } });
    await openSettings(doc);
    $(doc, "storage-open-btn").click();
    await wait(30);
    check("the Storage sheet says that files over 50 MB are deleted after 3 days", /Files over 50 MB are deleted after 3 days/.test($(doc, "storage-note").textContent), $(doc, "storage-note").textContent);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
