// Draws the demo's pictures: eight original, synthetic SVG paintings (landscapes, flowers,
// sea). Nothing photographed, nothing downloaded. Output: src/demo/art/*.svg (committed).
//   node scripts/demo-art.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const OUT = join(process.cwd(), "src", "demo", "art");
mkdirSync(OUT, { recursive: true });

// small seeded random generator: the same pictures every time
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const f = (n) => Math.round(n * 10) / 10;
const grad = (id, stops, vertical = true) =>
  `<linearGradient id="${id}" x1="0" y1="0" x2="${vertical ? 0 : 1}" y2="${vertical ? 1 : 0}">${stops
    .map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join("")}</linearGradient>`;
// Numbers are separated by commas, not spaces (valid SVG): long runs of space-separated digits in
// path data look like card numbers to the repository's safety scan, which we never bypass.
const commas = (s) => s.replace(/(\d) (?=-?[\d.])/g, "$1,");
const wrap = (w, h, defs, body, label) =>
  commas(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${label}"><defs>${defs}</defs>${body}</svg>\n`);
const hill = (w, h, y, amp, color, s = 0) =>
  `<path d="M0 ${h}V${f(y)}C${f(w * .2)} ${f(y - amp + s)} ${f(w * .45)} ${f(y + amp * .7)} ${f(w * .65)} ${f(y - amp * .2)}S${f(w * .9)} ${f(y - amp * .6)} ${w} ${f(y)}V${h}Z" fill="${color}"/>`;
const cloud = (x, y, s, o = 0.85) =>
  `<g fill="#fff" opacity="${o}"><ellipse cx="${x}" cy="${y}" rx="${70 * s}" ry="${22 * s}"/><ellipse cx="${x + 40 * s}" cy="${y - 14 * s}" rx="${44 * s}" ry="${24 * s}"/><ellipse cx="${x - 38 * s}" cy="${y - 8 * s}" rx="${36 * s}" ry="${18 * s}"/></g>`;

const art = {};

// 1 — sunset over the sea
{
  const w = 800, h = 600, r = rng(1);
  let waves = "";
  for (let i = 0; i < 46; i++) {
    const y = 380 + r() * 210, x = r() * w, l = 40 + r() * 120;
    waves += `<rect x="${f(x)}" y="${f(y)}" width="${f(l)}" height="3" rx="1.5" fill="#fff" opacity="${f(0.10 + r() * 0.25)}"/>`;
  }
  let glow = "";
  for (let i = 0; i < 12; i++) glow += `<rect x="${f(400 - 90 + i * 6 - i * i * 0.4)}" y="${f(385 + i * 17)}" width="${f(180 - i * 6 + i * i * 0.8)}" height="4" rx="2" fill="#FFE2A8" opacity="${f(0.75 - i * 0.05)}"/>`;
  art["sunset-sea"] = wrap(w, h,
    grad("s", [[0, "#3B2F6B"], [.35, "#B4527A"], [.62, "#F2925B"], [1, "#FFD27A"]]) + grad("m", [[0, "#F0A46A"], [1, "#2E3F73"]]),
    `<rect width="${w}" height="${h}" fill="url(#s)"/>${cloud(170, 120, 1.2, .35)}${cloud(620, 190, 1, .3)}
     <circle cx="400" cy="380" r="78" fill="#FFF0BF"/><circle cx="400" cy="380" r="110" fill="#FFF0BF" opacity=".25"/>
     <rect y="380" width="${w}" height="${h - 380}" fill="url(#m)"/>${glow}${waves}
     <path d="M0 380H${w}" stroke="#FFF0BF" stroke-width="2" opacity=".6"/>`, "שקיעה מעל הים (ציור לדוגמה)");
}

// 2 — meadow with flowers
{
  const w = 800, h = 600, r = rng(2);
  let flowers = "";
  const cols = ["#F5D04C", "#F27B8A", "#FFFFFF", "#B48CE0", "#F59E4C"];
  for (let i = 0; i < 120; i++) {
    const y = 330 + r() * 260, x = r() * w, s = 3 + (y - 330) / 26, c = cols[Math.floor(r() * cols.length)];
    flowers += `<line x1="${f(x)}" y1="${f(y)}" x2="${f(x)}" y2="${f(y + s * 3)}" stroke="#3E7C3A" stroke-width="${f(s / 3)}"/><circle cx="${f(x)}" cy="${f(y)}" r="${f(s)}" fill="${c}"/><circle cx="${f(x)}" cy="${f(y)}" r="${f(s / 3)}" fill="#C47A1B"/>`;
  }
  art["meadow-flowers"] = wrap(w, h,
    grad("s", [[0, "#78B7EA"], [1, "#DDF0FF"]]) + grad("g", [[0, "#7DBB5A"], [1, "#3C7A3A"]]),
    `<rect width="${w}" height="${h}" fill="url(#s)"/>${cloud(200, 110, 1.3)}${cloud(560, 80, 1)}${cloud(700, 170, .8, .7)}
     ${hill(w, h, 300, 50, "#8CC46B")}${hill(w, h, 340, 40, "url(#g)", 20)}${flowers}`, "אחו עם פרחים (ציור לדוגמה)");
}

// 3 — mountains and a lake
{
  const w = 800, h = 600;
  const peaks = "M0 340L120 190L210 280L330 120L450 300L560 200L680 310L800 230V340Z";
  art["mountains-lake"] = wrap(w, h,
    grad("s", [[0, "#5F86C9"], [1, "#F2E3D0"]]) + grad("l", [[0, "#5E97B8"], [1, "#2F5F80"]]),
    `<rect width="${w}" height="${h}" fill="url(#s)"/><circle cx="640" cy="110" r="44" fill="#FFF3C9" opacity=".9"/>
     <path d="${peaks}" fill="#6D7FA3"/><path d="M330 120L292 180L330 165L360 190L396 172Z" fill="#fff" opacity=".9"/>
     <path d="M120 190L92 232L120 222L146 238Z" fill="#fff" opacity=".85"/>
     ${hill(w, 400, 330, 24, "#3F6E52")}
     <rect y="340" width="${w}" height="${h - 340}" fill="url(#l)"/>
     <g opacity=".35" transform="translate(0 680) scale(1 -1)"><path d="${peaks}" fill="#3B4C74"/></g>
     <g stroke="#fff" opacity=".25" stroke-width="2">${Array.from({ length: 18 }, (_, i) => `<line x1="${60 + i * 42}" y1="${380 + (i % 5) * 34}" x2="${100 + i * 42}" y2="${380 + (i % 5) * 34}"/>`).join("")}</g>`,
    "הרים ואגם (ציור לדוגמה)");
}

// 4 — a little village (portrait)
{
  const w = 600, h = 800, r = rng(4);
  const houses = [[70, 470, 130, 110, "#E6A57E", "#A24B34"], [230, 440, 150, 140, "#F0D6A4", "#8C3F2E"], [410, 480, 120, 100, "#C9D8E6", "#6E4B7A"]]
    .map(([x, y, bw, bh, wall, roof]) =>
      `<rect x="${x}" y="${y}" width="${bw}" height="${bh}" fill="${wall}"/><path d="M${x - 12} ${y}L${x + bw / 2} ${y - bh * .55}L${x + bw + 12} ${y}Z" fill="${roof}"/>
       <rect x="${x + bw * .2}" y="${y + bh * .25}" width="${bw * .22}" height="${bh * .28}" fill="#FFF3B0"/><rect x="${x + bw * .58}" y="${y + bh * .25}" width="${bw * .22}" height="${bh * .28}" fill="#FFF3B0"/>
       <rect x="${x + bw * .4}" y="${y + bh * .58}" width="${bw * .2}" height="${bh * .42}" fill="#6B4A36"/>`).join("");
  let birds = "";
  for (let i = 0; i < 5; i++) { const x = 100 + r() * 400, y = 90 + r() * 140; birds += `<path d="M${f(x)} ${f(y)}q10 -12 20 0q10 -12 20 0" fill="none" stroke="#3B3B4F" stroke-width="2.5" stroke-linecap="round"/>`; }
  art["village"] = wrap(w, h,
    grad("s", [[0, "#F7C9A0"], [1, "#BFE3F2"]]),
    `<rect width="${w}" height="${h}" fill="url(#s)"/>${cloud(150, 150, 1)}${cloud(450, 260, 1.1, .8)}${birds}
     ${hill(w, h, 430, 50, "#9CC48A")}${hill(w, h, 520, 30, "#6FA162", 12)}${houses}
     <rect y="580" width="${w}" height="${h - 580}" fill="#7DAE63"/><path d="M250 800Q300 660 300 580L340 580Q360 680 420 800Z" fill="#E6D3A8"/>`, "כפר קטן (ציור לדוגמה)");
}

// 5 — forest (portrait)
{
  const w = 600, h = 800, r = rng(5);
  let trees = "";
  for (let i = 0; i < 14; i++) {
    const x = 20 + r() * 560, base = 520 + r() * 260, s = 0.7 + (base - 520) / 260, g = ["#2F6B45", "#3F8A54", "#265A3B", "#4C9B5F"][Math.floor(r() * 4)];
    trees += `<rect x="${f(x - 7 * s)}" y="${f(base - 150 * s)}" width="${f(14 * s)}" height="${f(150 * s)}" fill="#5A3F2C"/>
      <circle cx="${f(x)}" cy="${f(base - 190 * s)}" r="${f(70 * s)}" fill="${g}"/><circle cx="${f(x - 42 * s)}" cy="${f(base - 150 * s)}" r="${f(48 * s)}" fill="${g}"/><circle cx="${f(x + 42 * s)}" cy="${f(base - 150 * s)}" r="${f(48 * s)}" fill="${g}"/>`;
  }
  art["forest"] = wrap(w, h,
    grad("s", [[0, "#CFE9C4"], [1, "#F8F3C9"]]) + grad("g", [[0, "#6BA65A"], [1, "#2E6B3A"]]),
    `<rect width="${w}" height="${h}" fill="url(#s)"/><circle cx="470" cy="150" r="60" fill="#FFF7C4" opacity=".8"/>
     ${hill(w, h, 420, 40, "#A8D194")}<rect y="520" width="${w}" height="${h - 520}" fill="url(#g)"/>${trees}
     <g opacity=".22" fill="#fff">${Array.from({ length: 7 }, (_, i) => `<polygon points="${60 + i * 80},0 ${100 + i * 80},0 ${20 + i * 80},520 ${-20 + i * 80},520"/>`).join("")}</g>`, "יער (ציור לדוגמה)");
}

// 6 — poppies
{
  const w = 800, h = 600, r = rng(6);
  let p = "";
  for (let i = 0; i < 90; i++) {
    const y = 300 + r() * 290, x = r() * w, s = 5 + (y - 300) / 12;
    p += `<line x1="${f(x)}" y1="${f(y)}" x2="${f(x + (r() - .5) * 10)}" y2="${f(y + s * 4)}" stroke="#4E7F3B" stroke-width="${f(s / 4)}"/>
      <circle cx="${f(x)}" cy="${f(y)}" r="${f(s)}" fill="#D8362B"/><circle cx="${f(x - s * .3)}" cy="${f(y - s * .2)}" r="${f(s * .7)}" fill="#EF5B45" opacity=".8"/><circle cx="${f(x)}" cy="${f(y)}" r="${f(s * .25)}" fill="#2B1E1B"/>`;
  }
  art["poppies"] = wrap(w, h,
    grad("s", [[0, "#F6E7C8"], [1, "#A9D0EA"]]) + grad("g", [[0, "#B6C66A"], [1, "#5F8F3F"]]),
    `<rect width="${w}" height="${h}" fill="url(#s)"/>${cloud(150, 100, 1, .9)}${cloud(640, 140, 1.2, .8)}${hill(w, h, 290, 26, "#9FBF6A")}<rect y="300" width="${w}" height="${h - 300}" fill="url(#g)"/>${p}`,
    "פרגים (ציור לדוגמה)");
}

// 7 — a sailboat
{
  const w = 800, h = 600, r = rng(7);
  let waves = "";
  for (let i = 0; i < 40; i++) { const y = 330 + r() * 260, x = r() * w; waves += `<path d="M${f(x)} ${f(y)}q14 -9 28 0q14 9 28 0" fill="none" stroke="#fff" stroke-width="3" opacity="${f(.25 + r() * .3)}" stroke-linecap="round"/>`; }
  art["sailboat"] = wrap(w, h,
    grad("s", [[0, "#8FD0F2"], [1, "#F9F3DA"]]) + grad("m", [[0, "#3E9BC9"], [1, "#1F5F93"]]),
    `<rect width="${w}" height="${h}" fill="url(#s)"/><circle cx="130" cy="120" r="52" fill="#FFE27A"/>${cloud(500, 110, 1.2)}${cloud(700, 200, .9, .7)}
     <rect y="320" width="${w}" height="${h - 320}" fill="url(#m)"/>${waves}
     <g transform="translate(420 330)"><path d="M-70 0H80L55 32H-45Z" fill="#8C3F2E"/><rect x="0" y="-210" width="5" height="212" fill="#5A3F2C"/>
     <path d="M12 -205L12 -20L108 -20Z" fill="#FFF7E6"/><path d="M-6 -190L-6 -20L-88 -20Z" fill="#F2B84B"/></g>`, "סירת מפרש (ציור לדוגמה)");
}

// 8 — hills at night
{
  const w = 800, h = 600, r = rng(8);
  let stars = "";
  for (let i = 0; i < 70; i++) stars += `<circle cx="${f(r() * w)}" cy="${f(r() * 300)}" r="${f(.8 + r() * 2)}" fill="#FFF6D6" opacity="${f(.5 + r() * .5)}"/>`;
  art["night-hills"] = wrap(w, h,
    grad("s", [[0, "#151B47"], [1, "#4B4E8F"]]),
    `<rect width="${w}" height="${h}" fill="url(#s)"/>${stars}<circle cx="600" cy="130" r="56" fill="#FFF3C9"/><circle cx="622" cy="116" r="50" fill="#232A63"/>
     ${hill(w, h, 380, 60, "#2B3B6E")}${hill(w, h, 450, 46, "#1F2C57", 30)}${hill(w, h, 520, 30, "#141D40", 8)}
     <rect x="250" y="440" width="46" height="34" fill="#0E1533"/><rect x="262" y="452" width="10" height="12" fill="#FFD36A"/><path d="M244 440L273 418L302 440Z" fill="#0A1029"/>`, "גבעות בלילה (ציור לדוגמה)");
}

for (const [name, svg] of Object.entries(art)) writeFileSync(join(OUT, `${name}.svg`), svg);
console.log(`wrote ${Object.keys(art).length} paintings to src/demo/art/`);
