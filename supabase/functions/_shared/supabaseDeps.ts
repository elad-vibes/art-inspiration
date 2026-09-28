// Real dependencies for the Deno Edge Runtime. (Not type-checked by the Node
// tsconfig; checked with `deno check` — see package.json "check:functions".)
import { createClient } from "@supabase/supabase-js";
import type { Claims, Deps } from "./deps.ts";

function env(name: string, fallback = ""): string {
  return Deno.env.get(name) ?? fallback;
}

export function createDeps(): Deps {
  const url = env("SUPABASE_URL");
  const secret = env("SB_SECRET_KEY") || env("SUPABASE_SERVICE_ROLE_KEY");
  // The publishable (public) key: only used to call functions as the signed-in user.
  // Set SB_PUBLISHABLE_KEY as a function secret if the platform doesn't provide SUPABASE_ANON_KEY.
  const publishable = env("SB_PUBLISHABLE_KEY") || env("SUPABASE_ANON_KEY");
  const noSession = { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false };
  const admin = createClient(url, secret, { auth: noSession });

  return {
    env: {
      allowedOrigins: env("ALLOWED_ORIGINS", "https://elad-vibes.github.io").split(",").map((s) => s.trim()).filter(Boolean),
      requireOrigin: env("REQUIRE_ORIGIN", "true") !== "false",
      appUrl: env("APP_URL", "https://elad-vibes.github.io/painting-inspiration/"),
      cronSecret: env("CRON_SECRET"),
    },

    async verifyJwt(token: string): Promise<Claims | null> {
      const { data, error } = await admin.auth.getClaims(token);
      if (error || !data?.claims) return null;
      const c = data.claims as Record<string, unknown>;
      return { sub: String(c.sub ?? ""), email: c.email as string | undefined, aal: c.aal as string | undefined, role: c.role as string | undefined };
    },

    async rpc(fn, args) {
      const { data, error } = await admin.rpc(fn, args);
      if (error) {
        const e = new Error(`rpc ${fn} failed`);
        (e as any).code = error.code;
        throw e;
      }
      return data;
    },

    async userRpc(token, fn, args) {
      // a client that carries the caller's own token: the database sees THEM, not the service role
      const asUser = createClient(url, publishable, { auth: noSession, global: { headers: { Authorization: `Bearer ${token}` } } });
      const { data, error } = await asUser.rpc(fn, args);
      if (error) {
        const e = new Error(`user rpc ${fn} failed`);
        (e as any).code = error.code;
        (e as any).pgMessage = error.message;
        throw e;
      }
      return data;
    },

    storage: {
      async remove(paths) {
        const { error } = await admin.storage.from("images").remove(paths);
        if (error) throw new Error("storage_remove_failed");
      },
    },

    admin: {
      async createUser(email) {
        const { error } = await admin.auth.admin.createUser({ email, email_confirm: true });
        if (!error) return "created";
        if ((error as any).code === "email_exists" || /already/i.test(error.message)) return "exists";
        throw new Error("create_user_failed");
      },
    },

    log(event, fields = {}) {
      console.log(JSON.stringify({ event, ...fields }));
    },
    now: () => new Date(),
  };
}
