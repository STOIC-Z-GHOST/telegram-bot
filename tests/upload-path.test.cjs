// Run from the project folder:  node tests/upload-path.test.cjs
// Guards the "Vercel Blob: This blob already exists" bug: two people (or two files in one message) sending a file with the same
// name must never get the same storage path, and the page must never upload under a bare file name again.

const fs = require("fs");
const path = require("path");
const html = fs.readFileSync(path.join(__dirname, "..", "public", "miniapp", "index.html"), "utf8");

let pass = 0, fail = 0;
const check = (label, cond, extra = "") => { (cond ? pass++ : fail++); console.log(cond ? "ok  " : "FAIL", label, extra); };

const m = html.match(/function uniqueUploadPath\(fileName\) \{[\s\S]*?\n  \}\n/);
check("the page has uniqueUploadPath()", !!m);
const uniqueUploadPath = new Function(`${m[0]}; return uniqueUploadPath;`)();

const a = uniqueUploadPath("core 1 exercise (3).pdf");
const b = uniqueUploadPath("core 1 exercise (3).pdf");
check("the same file name gives a different path every time (two accounts, or two files in one message)", a !== b, `${a} | ${b}`);
check("the original name is kept after the random folder", /^[^/]+\/core 1 exercise \(3\)\.pdf$/.test(a), a);
check("exactly one folder level, and the random id is long enough to never collide", a.split("/").length === 2 && a.split("/")[0].length >= 20);
check("slashes, backslashes and control characters in a name cannot change the folder", uniqueUploadPath("../../etc/passwd").split("/").length === 2 && !/\.\./.test(uniqueUploadPath("../x").split("/")[1]) && !/[\\:*?"<>|\u0000-\u001f]/.test(uniqueUploadPath("a\\b:c*d?e\u0001f.txt").split("/")[1]));
check("a very long name is cut to a safe length", uniqueUploadPath("x".repeat(500) + ".pdf").split("/")[1].length <= 120);
check("an empty or missing name still works", uniqueUploadPath("").endsWith("/file") && uniqueUploadPath(undefined).endsWith("/file"));
check("100 uploads of one name give 100 different paths", new Set(Array.from({ length: 100 }, () => uniqueUploadPath("a.pdf"))).size === 100);
check("the send code uploads with uniqueUploadPath, never a bare file.name", /upload\(uniqueUploadPath\(file\.name\)/.test(html) && !/upload\(file\.name/.test(html));
check("overwriting is NOT turned on (it would let one person replace another's file)", !/allowOverwrite/.test(html));
check("a failed upload shows a friendly message, not the storage provider's error", /Couldn't upload "\$\{file\.name\}"\. Please try again\./.test(html));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
