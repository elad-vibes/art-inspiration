// Lucide icons as inline SVG (stroke = currentColor). Decorative: the text next to them carries the meaning.
import { raw, type SafeHtml } from "../lib/html.ts";
import { LUCIDE } from "./lucide.ts";

export function icon(name: string): SafeHtml {
  const inner = LUCIDE[name] ?? "";
  return raw(`<svg class="lu" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${inner}</svg>`);
}
