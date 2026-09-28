// Renders the app icons and the iOS splash screens (PNG) from one SVG master with a
// local Edge/Chromium via Playwright. The mark is original (a painter's palette, no brand
// logos) — the same drawing as markArt() in src/ui/art.ts (ASSETS.md).
//   node scripts/icons.mjs
import { chromium } from "@playwright/test";
import { mkdirSync } from "node:fs";

const PAPER = "#FBF6EF";
const PALETTE = "M256 110C140 110 80 185 80 262c0 83 70 143 160 143 35 0 50-20 45-45-5-25 10-42 37-42 73 0 110-33 110-83 0-75-72-125-176-125z";

/** SVG master, 512×512. maskable = full-bleed background and the mark inside the 80% safe zone. */
const master = (maskable, bg = true) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#C96A43"/><stop offset="1" stop-color="#8E4526"/></linearGradient></defs>
  ${bg ? `<rect width="512" height="512" rx="${maskable ? 0 : 112}" fill="url(#g)"/>` : ""}
  <g transform="translate(256 262) scale(${maskable ? 0.74 : 0.9}) translate(-256 -256)">
    <path d="${PALETTE}" fill="#FBF3E6"/>
    <circle cx="172" cy="232" r="30" fill="#C8683F"/><circle cx="238" cy="172" r="30" fill="#E0A93B"/>
    <circle cx="322" cy="176" r="30" fill="#6F8F6A"/><circle cx="376" cy="236" r="30" fill="#5B7FA6"/>
    <circle cx="176" cy="324" r="30" fill="#B5657F"/>
  </g></svg>`;

const ICONS = [
  ["public/icons/icon-192.png", 192, false],
  ["public/icons/icon-512.png", 512, false],
  ["public/icons/maskable-512.png", 512, true],
  ["public/icons/apple-touch-icon.png", 180, true], // iOS rounds the corners itself; no transparency
];

// iPhone portrait splash screens: [css width, css height, device pixel ratio] — matches index.html
const SPLASH = [
  [440, 956, 3], [430, 932, 3], [402, 874, 3], [393, 852, 3], [428, 926, 3], [390, 844, 3],
  [375, 812, 3], [414, 896, 3], [414, 896, 2], [375, 667, 2],
];

const splashHtml = (w) => `<html><body style="margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:${Math.round(w * 0.06)}px;
  background:${PAPER};font-family:Georgia,'Times New Roman',serif">
  <div style="width:${Math.round(w * 0.34)}px;height:${Math.round(w * 0.34)}px">${master(false).replace("<svg ", '<svg width="100%" height="100%" ')}</div>
  <div dir="rtl" style="color:#8E4526;font-size:${Math.round(w * 0.08)}px;font-weight:700">השראה לציור</div></body></html>`;

mkdirSync("public/icons", { recursive: true });
const browser = await chromium.launch({ channel: "msedge" }).catch(() => chromium.launch());
let page = await browser.newPage();
for (const [file, size, maskable] of ICONS) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">${master(maskable).replace("<svg ", `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: file, omitBackground: !maskable, clip: { x: 0, y: 0, width: size, height: size } });
  console.log("wrote", file);
}
for (const [w, h, dpr] of SPLASH) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: dpr });
  page = await ctx.newPage();
  await page.setContent(splashHtml(w));
  const name = `splash-${w * dpr}x${h * dpr}.png`;
  await page.screenshot({ path: `public/icons/${name}` });
  await ctx.close();
  console.log("wrote", name);
}
await browser.close();
