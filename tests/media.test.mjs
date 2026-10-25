// Run from the project folder:  node --no-deprecation tests/media.test.mjs
// Voice, spreadsheets and big files: things that make a first impression when they go wrong.
//   - voice: the real audio format is detected from the bytes, silence is not turned into "Thank you.", a failed verbose request
//     falls back, and a 30-second clip at a high bitrate is not refused as too long
//   - spreadsheets: a sheet that claims a million empty rows cannot make the function time out
//   - Word files: a very large numbered document is read quickly

import ExcelJS from "exceljs";
import JSZip from "jszip";

process.env.DATABASE_URL ||= "postgres://u:p@localhost.invalid/db";
process.env.GROQ_API_KEY = "g";
process.env.GEMINI_API_KEY = "k";

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => { (cond ? pass++ : fail++); console.log(cond ? "ok  " : "FAIL", label, extra); };

const { sniffAudioExt, speechFromVerbose, transcribeAudio, isSupportedAudioMime } = await import("../lib/transcribe.js");
const { extractDocumentText } = await import("../lib/attachments.js");
const { extractDocxNumbered } = await import("../lib/docxText.js");

// ---- the format is read from the bytes
const bytes = (...a) => Buffer.from([...a, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
const withAscii = (at, s, total = 16) => { const b = Buffer.alloc(total); b.write(s, at, "latin1"); return b; };
check("sniff: ogg, wav, flac, webm, mp4/m4a, mp3 (tag and frame) are recognised",
  sniffAudioExt(withAscii(0, "OggS")) === "ogg" && sniffAudioExt(Buffer.concat([withAscii(0, "RIFF"), withAscii(0, "    WAVE", 12).subarray(0, 12)]).subarray(0, 16)) !== undefined &&
  sniffAudioExt(withAscii(0, "fLaC")) === "flac" && sniffAudioExt(bytes(0x1a, 0x45, 0xdf, 0xa3)) === "webm" && sniffAudioExt(withAscii(4, "ftypM4A ")) === "m4a" &&
  sniffAudioExt(withAscii(0, "ID3")) === "mp3" && sniffAudioExt(bytes(0xff, 0xfb, 0x90)) === "mp3");
const wav = Buffer.alloc(16); wav.write("RIFF", 0, "latin1"); wav.write("WAVE", 8, "latin1");
check("sniff: wav needs RIFF and WAVE", sniffAudioExt(wav) === "wav" && sniffAudioExt(withAscii(0, "RIFF")) === null);
check("sniff: random bytes and tiny buffers are not guessed", sniffAudioExt(Buffer.from("hello world, not audio")) === null && sniffAudioExt(Buffer.alloc(3)) === null && sniffAudioExt(null) === null);
check("audio types the mini app and Telegram send are accepted (incl. codecs suffix)", ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg", "audio/ogg;codecs=opus", "audio/mpeg", "audio/x-m4a"].every(isSupportedAudioMime) && !isSupportedAudioMime("") && !isSupportedAudioMime("text/plain"));

// ---- silence must not become "Thank you."
const seg = (text, nsp, lp) => ({ text, no_speech_prob: nsp, avg_logprob: lp });
check("real speech is kept", speechFromVerbose({ text: "hello there", segments: [seg("hello there", 0.02, -0.2)] }) === "hello there");
check("a segment that is very probably not speech is dropped (silence -> empty)", speechFromVerbose({ text: " Thank you.", segments: [seg(" Thank you.", 0.93, -0.9)] }) === "");
check("a doubtful, low-confidence segment is dropped (no_speech 0.7, logprob -1.4)", speechFromVerbose({ text: "you", segments: [seg("something odd", 0.7, -1.4)] }) === "");
check("a stock phantom phrase is dropped only when the model also doubts there was speech", speechFromVerbose({ segments: [seg(" Thanks for watching!", 0.45, -0.5)] }) === "");
check("a person really saying 'thank you' (clearly speech) is kept", speechFromVerbose({ segments: [seg(" Thank you.", 0.03, -0.15)] }) === "Thank you.");
check("a mix keeps the spoken part and drops the phantom tail", speechFromVerbose({ segments: [seg(" Call me tomorrow.", 0.02, -0.2), seg(" Thank you for watching.", 0.5, -0.6)] }) === "Call me tomorrow.");
check("no segments in the reply -> falls back to the plain text field", speechFromVerbose({ text: " plain text " }) === "plain text" && speechFromVerbose({}) === "" && speechFromVerbose(null) === "");

// ---- the Groq request itself (pretend network)
const sent = [];
const realFetch = globalThis.fetch;
let mode = "verbose";
globalThis.fetch = async (url, opts) => {
  const form = opts.body;
  const fmt = form.get("response_format");
  sent.push({ url: String(url), fmt, name: form.get("file").name });
  if (mode === "verbose-rejected" && fmt === "verbose_json") return new Response(JSON.stringify({ error: { message: "response_format not supported" } }), { status: 400 });
  if (mode === "down") return new Response("nope", { status: 500 });
  if (fmt === "verbose_json") return new Response(JSON.stringify({ text: " Thank you.", segments: [{ text: " Thank you.", no_speech_prob: 0.95, avg_logprob: -1.1 }] }), { status: 200 });
  return new Response(JSON.stringify({ text: "plain json answer" }), { status: 200 });
};
{
  const r = await transcribeAudio(withAscii(4, "ftypM4A "), "audio/webm", {});
  check("a clip labelled webm that is really mp4 is sent as voice.m4a", sent[0].name === "voice.m4a", sent[0].name);
  check("silence comes back as an empty transcript, not an invented phrase", r.text === "" && r.provider === "groq", JSON.stringify(r));
  check("the request asks for per-segment confidence", sent[0].fmt === "verbose_json");
  sent.length = 0; mode = "verbose-rejected";
  const r2 = await transcribeAudio(withAscii(0, "OggS"), "audio/ogg", {});
  check("if Groq rejects verbose_json it retries with plain json and still transcribes", sent.map((x) => x.fmt).join() === "verbose_json,json" && r2.text === "plain json answer", sent.map((x) => x.fmt).join());
  sent.length = 0; mode = "down";
  let threw = false; try { await transcribeAudio(withAscii(0, "OggS"), "audio/ogg", {}); } catch { threw = true; }
  check("a real outage still throws (the callers show 'please type it instead') and is not retried as json", threw && sent.length === 1);
}
globalThis.fetch = realFetch;

// ---- the byte ceiling in the mini app's voice endpoint leaves room for a high-bitrate phone
{
  const fs = await import("fs"); const path = await import("path"); const { fileURLToPath } = await import("url");
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "api", "miniapp", "transcribe.js"), "utf8");
  const rate = Number(src.match(/MAX_BYTES_PER_SECOND = (\d+) \* 1024/)[1]) * 1024;
  check("a 30-second clip at 128 kbps (16 KB/s, 480 KB) fits under the free plan's 30-second byte cap", 30 * 16 * 1024 <= 30 * rate);
}

// ---- spreadsheets
{
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sales");
  ws.addRow(["Item", "Qty"]); ws.addRow(["Pen", 3]); ws.addRow(["Book", 5]);
  ws.getRow(1048576).height = 20; // "formatted" last row: the sheet now claims 1,048,576 rows
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const t0 = Date.now();
  const r = await extractDocumentText(buf, "xlsx", "sales.xlsx");
  const ms = Date.now() - t0;
  check("a sheet that claims a million rows is read in a fraction of a second (the unguarded loop takes over a second here)", !r.error && ms < 500, `${ms} ms`);
  check("and the real rows are all there", /Item\tQty/.test(r.text) && /Pen\t3/.test(r.text) && /Book\t5/.test(r.text), r.text);
}

// ---- a large numbered Word file
{
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  const paras = []; for (let i = 0; i < 30000; i++) paras.push(`<w:p><w:pPr><w:numPr><w:ilvl w:val="${i % 5 === 0 ? 0 : 1}"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>Line number ${i} with some words to read</w:t></w:r></w:p>`);
  const z = new JSZip();
  z.file("word/document.xml", `<?xml version="1.0"?><w:document ${W}><w:body>${paras.join("")}</w:body></w:document>`);
  z.file("word/numbering.xml", `<?xml version="1.0"?><w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl><w:lvl w:ilvl="1"><w:start w:val="1"/><w:numFmt w:val="upperLetter"/><w:lvlText w:val="%2."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`);
  const buf = await z.generateAsync({ type: "nodebuffer" });
  const t0 = Date.now();
  const r = await extractDocxNumbered(buf);
  const ms = Date.now() - t0;
  check("a 30,000-paragraph numbered document is read in about a second or two, not minutes", ms < 5000 && r.labelled === 30000, `${ms} ms`);
}

// ---- what people see when something fails: no internal error text, no provider names
{
  const fs = await import("fs"); const path = await import("path"); const { fileURLToPath } = await import("url");
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  const hook = fs.readFileSync(path.join(root, "api", "telegram-webhook.js"), "utf8");
  const toUser = [...hook.matchAll(/sendTelegramMessage\([^;]*\$\{(?:err|err2|error|e)\.message\}[^;]*\)/g)];
  check("the DM bot never sends a raw error message to a person", toUser.length === 0, toUser.map((m) => m[0]).join(" | ").slice(0, 200));
  check("the DM bot's file/photo failures use the friendly message", (hook.match(/friendlyReadError\(/g) || []).length >= 4);
  check("no reply names the AI providers ('Both Groq and Gemini failed')", !/Both Groq and Gemini/.test(hook));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
