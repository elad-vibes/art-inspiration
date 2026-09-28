// Proves the demo build is what it claims to be: no Supabase, no keys, no network code, nothing
// stored in the browser, a Content-Security-Policy that forbids every connection, and the
// "demo" banner text. Run after `npm run build:demo`.
//   node scripts/check-demo.mjs
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join } from "node:path";

const DIR = join(process.cwd(), "dist-demo");
if (!existsSync(join(DIR, "index.html"))) {
  console.error("dist-demo/index.html is missing — run `npm run build:demo` first.");
  process.exit(2);
}

const files = [];
(function walk(d) {
  for (const n of readdirSync(d)) {
    const p = join(d, n);
    statSync(p).isDirectory() ? walk(p) : files.push(p);
  }
})(DIR);

const problems = [];
const ALLOWED = new Set([".html", ".js", ".css", ".svg", ".woff", ".woff2"]);
const FORBIDDEN = [
  [/supabase/i, "a Supabase reference"], [/sb_(publishable|secret)/, "a Supabase key"],
  [/\beyJ[A-Za-z0-9_-]{10,}\./, "a JWT"], [/\/(auth|rest|functions|storage)\/v1/, "a Supabase API path"],
  [/example\.invalid/, "the placeholder Supabase host"], [/\bfetch\s*\(/, "fetch()"], [/XMLHttpRequest/, "XMLHttpRequest"],
  [/WebSocket|EventSource|sendBeacon/, "a network channel"], [/localStorage|sessionStorage|indexedDB|document\.cookie/, "browser storage"],
  [/serviceWorker/, "a service worker"],
];

for (const f of files) {
  const rel = f.slice(DIR.length + 1).replace(/\\/g, "/");
  const ext = extname(f).toLowerCase();
  if (!ALLOWED.has(ext)) { problems.push(`${rel}: unexpected file type ${ext}`); continue; }
  if (![".html", ".js", ".css", ".svg"].includes(ext)) continue;
  const text = readFileSync(f, "utf8");
  for (const [re, what] of FORBIDDEN) if (re.test(text)) problems.push(`${rel}: contains ${what}`);
  if (ext === ".svg") {
    if (/<script|onload=|onclick=|<foreignObject/i.test(text)) problems.push(`${rel}: an SVG with active content`);
    if ((text.match(/https?:\/\//g) ?? []).length > 1) problems.push(`${rel}: an SVG that points somewhere`);
  }
}

const html = readFileSync(join(DIR, "index.html"), "utf8");
for (const need of ["default-src 'none'", "connect-src 'none'", "worker-src 'none'", 'name="robots" content="noindex,nofollow"']) {
  if (!html.includes(need)) problems.push(`index.html: missing ${need}`);
}
const js = files.filter((f) => f.endsWith(".js")).map((f) => readFileSync(f, "utf8")).join("\n");
if (!js.includes("גרסת הדגמה – שום דבר לא נשמר")) problems.push("the fixed demo banner text is not in the bundle");

if (problems.length) {
  console.error("demo check FAILED:\n - " + problems.join("\n - "));
  process.exit(1);
}
const kb = Math.round(files.reduce((n, f) => n + statSync(f).size, 0) / 1024);
console.log(`demo check ok — ${files.length} files, ${kb} KB, no Supabase, no keys, no network code, no browser storage, CSP connect-src 'none'`);
