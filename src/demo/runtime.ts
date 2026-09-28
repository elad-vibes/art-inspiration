// The demo's one shared state: which role is being shown, and the in-memory database.
// The paintings are SVG files drawn in code (scripts/demo-art.mjs) and bundled with the demo.
import { DemoDb, type Who } from "./db.ts";

const arts = import.meta.glob("./art/*.svg", { query: "?url", import: "default", eager: true }) as Record<string, string>;

const art = (name: string): string => {
  const u = arts[`./art/${name}.svg`];
  if (!u) throw new Error(`demo painting missing: ${name}`);
  return u;
};

export const demo = {
  who: "mom" as Who,
  // a "web" picture's thumbnail must be an https URL: the paintings are served from this same site
  db: new DemoDb({ art, webArt: (name) => new URL(art(name), location.href).href }),
};
