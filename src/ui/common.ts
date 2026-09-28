// Small shared UI pieces.
import { html, type SafeHtml } from "../lib/html.ts";

export function banner(text: string | SafeHtml, kind: "info" | "warn" | "err" | "ok" = "info"): SafeHtml {
  return html`<div class="banner ${kind}" role="${kind === "err" ? "alert" : "status"}">${text}</div>`;
}

export function copyText(t: string): Promise<boolean> {
  return navigator.clipboard?.writeText(t).then(() => true, () => false) ?? Promise.resolve(false);
}

/** The phone's share sheet (WhatsApp, Mail…) when available, otherwise copy. Returns what happened. */
export async function shareLink(url: string, text: string): Promise<"shared" | "copied" | "failed"> {
  if (navigator.share) {
    try {
      await navigator.share({ title: "השראה לציור", text, url });
      return "shared";
    } catch (e: any) {
      if (e?.name === "AbortError") return "failed";
    }
  }
  return (await copyText(url)) ? "copied" : "failed";
}

export const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? "" : d.toLocaleDateString("he-IL", { day: "numeric", month: "numeric", year: "2-digit" });
};
