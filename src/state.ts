// App state (one studio at a time).
import type { Perm, Perms, Role } from "./domain/perms.ts";

export type View =
  | "loading" | "noconfig" | "signin" | "join" | "mfa-challenge" | "mfa-enroll" | "nostudio" | "app" | "admin" | "install";

export interface Studio { id: string; name: string; role: Role; perms: Perms }

export const S = {
  view: "loading" as View,
  user: null as null | { id: string; email: string },
  myName: "",
  aal: { current: "aal1", next: "aal1" } as { current: string; next: string },
  hasFactor: false,
  isAdmin: false,
  studios: [] as Studio[],
  sid: null as string | null,
  painterName: "",
  joinToken: null as string | null,
  offline: false,
  menu: false,
  flash: null as null | { text: string; kind: "ok" | "err" | "info" | "warn" },
  extra: {} as Record<string, any>,
};

export const studio = () => S.studios.find((s) => s.id === S.sid) ?? null;
export const isPainter = () => studio()?.role === "painter";
export const can = (p: Perm) => {
  const s = studio();
  return !!s && (s.role === "painter" || s.perms[`can_${p}`]);
};

let renderer: () => void = () => {};
export const setRenderer = (fn: () => void) => { renderer = fn; };
export const rerender = () => renderer();

export function flash(text: string, kind: "ok" | "err" | "info" | "warn" = "ok") {
  S.flash = { text, kind };
  rerender();
  const mine = S.flash;
  setTimeout(() => { if (S.flash === mine) { S.flash = null; rerender(); } }, kind === "err" ? 7000 : 3500);
}
