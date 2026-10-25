// Run from the project folder:  npm install --no-save jsdom && node tests/ui-extended-models.test.cjs
// (jsdom is NOT a project dependency — it is only for this check.)
// Runs the REAL public/miniapp/index.html script in jsdom with a pretend server and checks the Extended models UI:
// first-run sheet, the Settings row (name + More models chip + toggle + Details button), what gets saved, and failures.

const fs = require("fs");
const path = require("path");
const { JSDOM } = require("jsdom");

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => { (cond ? pass++ : fail++); console.log(cond ? "ok  " : "FAIL", label, extra); };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const COPY = {
  title: "Extended models", badge: "More models",
  summary: "You get more models when this is on. Some run on free services from other companies, which may keep your chats and use them to improve their AI.",
  detailsButton: "Details", hideDetailsButton: "Hide details",
  details: [{ heading: "What you get when it's on", text: "Extra models." }, { heading: "Never share sensitive information", text: "Don't send passwords." }],
  allowButton: "Turn on Extended models", denyButton: "Keep my chats private",
};

async function boot({ needsAnswer, allow = false, failSave = false, failLoad = false }) {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "miniapp", "index.html"), "utf8");
  const m = html.match(/<script type="module">([\s\S]*?)<\/script>/);
  // The page imports a browser helper from a CDN; jsdom can't load modules, and this check doesn't upload anything.
  const code = m[1].replace(/import \{ upload \} from "[^"]+";/, "const upload = async () => ({});");
  const bodyHtml = html.replace(/<script[\s\S]*?<\/script>/g, "");
  const dom = new JSDOM(bodyHtml, { runScripts: "outside-only", pretendToBeVisual: true, url: "https://example.test/miniapp/" });
  const w = dom.window;
  const posts = [];
  w.Telegram = { WebApp: { initData: "fake", ready() {}, expand() {}, disableVerticalSwipes() {}, onEvent() {}, themeParams: {}, initDataUnsafe: { user: { id: 1 } }, HapticFeedback: { impactOccurred() {} }, close() {} } };
  w.requestAnimationFrame = (f) => setTimeout(f, 0);
  w.matchMedia = w.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  w.fetch = async (url, opts = {}) => {
    const u = String(url);
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });
    if (u.endsWith("/api/miniapp/settings")) {
      if (opts.method === "POST") {
        const body = JSON.parse(opts.body);
        posts.push(body);
        if (failSave) return json({ error: "boom" }, 500);
        return json({ dataSharing: { allow: !!body.dataSharing, needsAnswer: false } });
      }
      if (failLoad) return json({ error: "column data_sharing does not exist" }, 500); // e.g. the migration has not been run yet
      return json({ memoryEnabled: false, dataSharing: { allow, choice: allow, needsAnswer, version: 1 }, dataSharingCopy: COPY });
    }
    if (u.includes("/api/miniapp/chats")) return json({ chats: [] });
    return json({});
  };
  w.eval(code);
  await wait(60);
  return { w, doc: w.document, posts };
}
const $ = (doc, id) => doc.getElementById(id);
// What a person actually sees: the browser's computed display (so a CSS rule beating the hidden attribute would be caught), not just .hidden.
const visible = (w, el) => !el.hidden && w.getComputedStyle(el).display !== "none";

(async () => {
  // ---- someone who has never answered
  {
    const { doc, posts } = await boot({ needsAnswer: true });
    const sheet = $(doc, "consent-sheet");
    await wait(20);
    check("a person who hasn't answered is shown the first-run sheet", sheet.classList.contains("open") && !$(doc, "consent-overlay").hidden);
    check("the sheet shows the name, a 'More models' chip and the benefit-first summary", $(doc, "consent-title").textContent === "Extended models" && $(doc, "consent-chip").textContent === "More models" && /more models when this is on/i.test($(doc, "consent-summary").textContent));
    check("the two buttons say what they do and nothing is pre-chosen", $(doc, "consent-allow-btn").textContent === "Turn on Extended models" && $(doc, "consent-deny-btn").textContent === "Keep my chats private" && !$(doc, "shared-toggle").checked);
    const dBtn = $(doc, "consent-details-btn"), dPanel = $(doc, "consent-details");
    check("the details are hidden until the Details button is pressed", dPanel.hidden === true && dBtn.textContent === "Details");
    dBtn.click();
    check("pressing Details shows every section (including the sensitive-data warning) and the button becomes Hide details", dPanel.hidden === false && /Never share sensitive information/.test(dPanel.textContent) && dBtn.textContent === "Hide details" && dBtn.getAttribute("aria-expanded") === "true");
    dBtn.click();
    check("pressing it again hides them", dPanel.hidden === true && dBtn.textContent === "Details");
    $(doc, "consent-deny-btn").click();
    await wait(30);
    check("'Keep my chats private' saves exactly { dataSharing: false } and closes the sheet", posts.length === 1 && posts[0].dataSharing === false && !sheet.classList.contains("open") && $(doc, "shared-toggle").checked === false);
  }
  {
    const { doc, posts } = await boot({ needsAnswer: true });
    await wait(20);
    $(doc, "consent-allow-btn").click();
    await wait(30);
    check("'Turn on Extended models' saves { dataSharing: true }, closes the sheet and the Settings toggle shows ON", posts.length === 1 && posts[0].dataSharing === true && !$(doc, "consent-sheet").classList.contains("open") && $(doc, "shared-toggle").checked === true);
  }
  {
    const { doc, posts } = await boot({ needsAnswer: true, failSave: true });
    await wait(20);
    $(doc, "consent-allow-btn").click();
    await wait(30);
    check("if saving fails the sheet stays open with an error and nothing looks turned on", $(doc, "consent-sheet").classList.contains("open") && $(doc, "consent-error").hidden === false && $(doc, "shared-toggle").checked === false && posts.length === 1);
    check("the buttons work again after a failure", $(doc, "consent-allow-btn").disabled === false && $(doc, "consent-deny-btn").disabled === false);
  }

  // ---- someone who already answered
  {
    const { doc, posts } = await boot({ needsAnswer: false, allow: true });
    await wait(20);
    check("someone who already answered is NOT asked again", !$(doc, "consent-sheet").classList.contains("open"));
    check("their Settings toggle reflects their saved answer (on)", $(doc, "shared-toggle").checked === true);
    check("the Settings row has the name, the chip, a hint, the toggle and a Details button underneath", $(doc, "shared-title").textContent === "Extended models" && $(doc, "shared-chip").textContent === "More models" && $(doc, "shared-details-btn").textContent === "Details" && $(doc, "shared-details").hidden === true);
    $(doc, "shared-details-btn").click();
    check("Details in Settings expands the explanation", $(doc, "shared-details").hidden === false && /Never share sensitive information/.test($(doc, "shared-details").textContent));
    const t = $(doc, "shared-toggle");
    t.checked = false; t.dispatchEvent(new doc.defaultView.Event("change"));
    await wait(30);
    check("switching the toggle off saves { dataSharing: false }", posts.length === 1 && posts[0].dataSharing === false && t.checked === false);
  }
  {
    const { doc } = await boot({ needsAnswer: false, allow: false, failSave: true });
    await wait(20);
    const t = $(doc, "shared-toggle");
    t.checked = true; t.dispatchEvent(new doc.defaultView.Event("change"));
    await wait(30);
    check("if saving the toggle fails it flips back (never shows ON when it isn't saved)", t.checked === false && t.disabled === false);
  }

  // ---- the server can't be read (e.g. the migration hasn't been run): Details must still work, the switch must be locked
  {
    const { w, doc, posts } = await boot({ needsAnswer: false, failLoad: true });
    await wait(40);
    const panel = $(doc, "shared-details"), btn = $(doc, "shared-details-btn");
    check("server unreachable: the panel starts hidden, and the Details button is there", !visible(w, panel) && btn.textContent === "Details");
    btn.click();
    check("server unreachable: Details still opens, with the whole explanation, visibly", visible(w, panel) && /Never share sensitive information/.test(panel.textContent) && panel.textContent.length > 100 && btn.textContent === "Hide details", panel.textContent.slice(0, 60));
    btn.click();
    check("server unreachable: Details hides again, visibly", !visible(w, panel) && btn.textContent === "Details");
    check("server unreachable: the switch is locked off and says why, and the first-run sheet does not open", $(doc, "shared-toggle").disabled === true && $(doc, "shared-toggle").checked === false && visible(w, $(doc, "shared-error")) && !$(doc, "consent-sheet").classList.contains("open"));
    check("server unreachable: nothing was saved", posts.length === 0);
  }
  {
    const { w, doc } = await boot({ needsAnswer: false, allow: false });
    await wait(30);
    const panel = $(doc, "shared-details"), btn = $(doc, "shared-details-btn");
    btn.click();
    check("normal load: Details is visible after a tap and hidden after a second tap (computed display, not just the attribute)", visible(w, panel) && (btn.click(), !visible(w, panel)));
    check("normal load: the error line is hidden and the switch is usable", !visible(w, $(doc, "shared-error")) && $(doc, "shared-toggle").disabled === false);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
