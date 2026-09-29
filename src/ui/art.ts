// Our own flat illustrations (ASSETS.md — original work), drawn as inline SVG that
// takes its colors from the theme tokens, so dark mode recolors them.
// Decorative only (aria-hidden): the text next to each one carries the meaning.
import { raw, type SafeHtml } from "../lib/html.ts";

const A = "var(--accent)", D = "var(--accent-deep)", G = "var(--sage)", M = "var(--mustard)", B = "var(--sky)";
const F = "var(--surface)", L = "var(--line)", SOFT = "var(--accent-soft)";
const svg = (vb: string, body: string, cls = "art"): SafeHtml =>
  raw(`<svg class="${cls}" viewBox="${vb}" aria-hidden="true" focusable="false">${body}</svg>`);

/** Palette outline shared with scripts/icons.mjs (the app icon). */
export const PALETTE_PATH = "M256 110C140 110 80 185 80 262c0 83 70 143 160 143 35 0 50-20 45-45-5-25 10-42 37-42 73 0 110-33 110-83 0-75-72-125-176-125z";

/** The app mark: a painter's palette with four paint dots. */
export const markArt = () => svg("0 0 512 512", `<rect width="512" height="512" rx="112" fill="${A}"/>
  <g transform="translate(256 262) scale(.9) translate(-256 -256)">
    <path d="${PALETTE_PATH}" fill="#FBF3E6"/>
    <circle cx="172" cy="232" r="30" fill="#C8683F"/><circle cx="238" cy="172" r="30" fill="#E0A93B"/>
    <circle cx="322" cy="176" r="30" fill="#6F8F6A"/><circle cx="376" cy="236" r="30" fill="#5B7FA6"/>
    <circle cx="176" cy="324" r="30" fill="#B5657F"/>
  </g>`, "mark");

export const art = {
  /** An easel with a blank canvas — empty gallery. */
  easel: () => svg("0 0 200 150", `<ellipse cx="100" cy="140" rx="70" ry="7" fill="${SOFT}"/>
    <path d="M70 140 92 30M130 140 108 30M100 30v112" stroke="${D}" stroke-width="5" stroke-linecap="round"/>
    <rect x="55" y="22" width="90" height="72" rx="6" fill="${F}" stroke="${L}" stroke-width="3"/>
    <circle cx="80" cy="46" r="9" fill="${M}"/>
    <path d="M62 86c14-18 24-24 36-14s22 4 40-14" fill="none" stroke="${G}" stroke-width="5" stroke-linecap="round"/>
    <path d="M56 98h88" stroke="${D}" stroke-width="6" stroke-linecap="round"/>`),
  /** A little envelope with a heart — suggestions from the family. */
  letter: () => svg("0 0 200 150", `<ellipse cx="100" cy="140" rx="64" ry="7" fill="${SOFT}"/>
    <rect x="45" y="40" width="110" height="80" rx="10" fill="${F}" stroke="${L}" stroke-width="3"/>
    <path d="M48 46l52 40 52-40" fill="none" stroke="${B}" stroke-width="4" stroke-linejoin="round"/>
    <path d="M100 30c-6-10-22-8-22 4 0 10 14 18 22 24 8-6 22-14 22-24 0-12-16-14-22-4z" fill="${A}"/>`),
  /** A cloud without a line — offline. */
  offline: () => svg("0 0 200 150", `<ellipse cx="100" cy="140" rx="60" ry="7" fill="${SOFT}"/>
    <path d="M60 100a24 24 0 0 1 6-47 32 32 0 0 1 62-6 26 26 0 0 1 12 53z" fill="${F}" stroke="${L}" stroke-width="3"/>
    <path d="M78 118l44-44" stroke="${D}" stroke-width="5" stroke-linecap="round"/>`),
};
