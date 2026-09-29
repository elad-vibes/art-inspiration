import { defineConfig, loadEnv, type Plugin } from "vite";
import { VitePWA } from "vite-plugin-pwa";
import { fileURLToPath } from "node:url";

// Resolve everything from this folder, whatever the current directory is.
const ROOT = fileURLToPath(new URL(".", import.meta.url));

// Served from GitHub Pages at /painting-inspiration/ (DECISIONS 12).
const BASE = "/painting-inspiration/";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, ROOT, "");
  // Only the URL and the PUBLISHABLE key may reach the browser bundle.
  const url = env.VITE_SUPABASE_URL || env.SUPABASE_URL || "";
  const key = env.VITE_SUPABASE_PUBLISHABLE_KEY || env.SUPABASE_ANON_KEY || "";
  if (/^sb_secret_/.test(key) || /service_role/.test(key)) {
    throw new Error("Refusing to build: the key given to the browser is a SECRET key. Use the publishable (anon) key.");
  }
  const host = url ? new URL(url).host : "";

  // Image hosts (Supabase Storage, Openverse/Commons thumbnails) are added in the
  // phase that needs them — never a wildcard.
  const csp = [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",           // style="" attributes for small layout tweaks
    "img-src 'self' data: blob:",                  // TOTP QR code, illustrations
    "font-src 'self'",
    `connect-src 'self'${host ? ` https://${host} wss://${host}` : ""}`,
    "worker-src 'self'",
    "manifest-src 'self'",
    "base-uri 'self'",
    "form-action 'self'",
    "object-src 'none'",
    "frame-src 'none'",
    "upgrade-insecure-requests",
  ].join("; ");

  const cspPlugin: Plugin = {
    name: "inject-csp",
    apply: "build",
    transformIndexHtml: (html) => html.replace("<!--CSP-->", `<meta http-equiv="Content-Security-Policy" content="${csp}">`),
  };

  return {
    root: ROOT,
    base: BASE,
    define: {
      "import.meta.env.VITE_SUPABASE_URL": JSON.stringify(url),
      "import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY": JSON.stringify(key),
    },
    plugins: [
      cspPlugin,
      VitePWA({
        strategies: "injectManifest",
        srcDir: "src",
        filename: "sw.ts",
        injectRegister: false,
        manifest: {
          name: "השראה לציור",
          short_name: "השראה לציור",
          description: "תמונות לציור: חיפוש, אוספים, הצעות מהמשפחה ויצירת תמונות.",
          lang: "he",
          dir: "rtl",
          start_url: BASE,
          scope: BASE,
          id: BASE,
          display: "standalone",
          orientation: "portrait",
          background_color: "#FBF6EF",
          theme_color: "#FBF6EF",
          icons: [
            { src: "icons/icon-192.png", sizes: "192x192", type: "image/png" },
            { src: "icons/icon-512.png", sizes: "512x512", type: "image/png" },
            { src: "icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
          ],
        },
        injectManifest: {
          globPatterns: ["**/*.{js,css,html,png,svg,webmanifest}", "**/*hebrew*.woff2", "**/*latin-[0-9]*-normal*.woff2"],
          globIgnores: ["icons/splash-*.png"], // iOS reads splash screens at install; no need to precache them
        },
        devOptions: { enabled: false },
      }),
    ],
    // keep /*! @license */ notices (Lucide icons, ASSETS.md) in the minified bundle
    build: { target: "es2022", sourcemap: false, rolldownOptions: { output: { comments: { legal: true } } } },
    server: { port: 5173, strictPort: true },
    preview: { port: 4173, strictPort: true },
  };
});
