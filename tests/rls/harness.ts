// Test harness for the RLS suite (same approach as "הכסף של הבית", DECISIONS 2).
//
// Local (default): a real Postgres (PGlite, WASM — no Docker) with a small shim of
// Supabase's auth schema and roles, then our migrations applied in order.
// Remote (RLS_TARGET=remote): the live Supabase database from .env.local. The whole
// suite runs inside ONE transaction that is rolled back at the end, so no test data
// is ever left behind.
//
// Either way, queries run as `authenticated` with JWT claims, exactly as PostgREST does.
import { PGlite } from "@electric-sql/pglite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { NAMES } from "../fixtures/synthetic.ts";

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

const SUPABASE_SHIM = `
create role anon nologin noinherit;
create role authenticated nologin noinherit;
create role service_role nologin noinherit bypassrls;
create schema auth;
create table auth.users (id uuid primary key, email text unique, created_at timestamptz default now());
create table auth.mfa_factors (
  id uuid primary key, user_id uuid not null references auth.users (id) on delete cascade,
  friendly_name text, factor_type text not null, status text not null,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(), secret text);
create function auth.uid() returns uuid language sql stable as $$
  select coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid
$$;
create function auth.jwt() returns jsonb language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb
$$;
create function auth.role() returns text language sql stable as $$
  select nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role'
$$;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on all functions in schema auth to anon, authenticated, service_role;
grant usage on schema public to anon, authenticated, service_role;
-- Supabase's default privileges: everything in public is granted to the API roles;
-- RLS (and our explicit revokes) are what actually protect the data.
alter default privileges in schema public grant all on tables to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;
`;

export type Row = Record<string, any>;
export type Actor = { role: "anon" | "authenticated" | "service_role"; uid?: string; aal?: "aal1" | "aal2" };

interface Driver {
  query(sql: string, params: unknown[]): Promise<{ rows: Row[]; affected: number }>;
  exec(sql: string): Promise<Row[]>; // multi-statement, returns rows of the last one
  close(): Promise<void>;
  remote: boolean;
}

function pgliteDriver(pg: PGlite): Driver {
  return {
    remote: false,
    async query(sql, params) {
      const r = await pg.query<Row>(sql, params);
      return { rows: r.rows, affected: r.affectedRows ?? 0 };
    },
    async exec(sql) {
      const results = await pg.exec(sql);
      return (results[results.length - 1]?.rows ?? []) as Row[];
    },
    async close() {
      await pg.close();
    },
  };
}

async function remoteDriver(): Promise<Driver> {
  // @ts-ignore — optional dev dependency, only needed for RLS_TARGET=remote
  const { default: pg } = await import("pg");
  const { loadEnv, projectRef } = await import("../../scripts/lib/env.mjs");
  const env = loadEnv();
  const host = readFileSync(join(process.cwd(), "supabase", ".temp", "pooler-host"), "utf8").trim();
  const client = new pg.Client({
    host, port: 5432, database: "postgres", user: `postgres.${projectRef(env)}`,
    password: env.SUPABASE_DB_PASSWORD, ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  return {
    remote: true,
    async query(sql, params) {
      const r = await client.query(sql, params as any[]);
      return { rows: r.rows, affected: r.rowCount ?? 0 };
    },
    async exec(sql) {
      const r: any = await client.query(sql);
      const last = Array.isArray(r) ? r[r.length - 1] : r;
      return last?.rows ?? [];
    },
    async close() {
      await client.end();
    },
  };
}

export class TestDb {
  constructor(private d: Driver) {}

  /** Runs SQL as the database owner (setup / verification). */
  async sql(query: string, params: unknown[] = []): Promise<Row[]> {
    if (!params.length) return this.d.exec(query);
    return (await this.d.query(query, params)).rows;
  }

  /** Runs one statement as the given actor. Throws on error. */
  async as(actor: Actor, query: string, params: unknown[] = []): Promise<{ rows: Row[]; affected: number }> {
    const claims = JSON.stringify({ sub: actor.uid ?? null, role: actor.role, aal: actor.aal ?? "aal1" });
    const [open, ok, bad] = this.d.remote
      ? ["savepoint t", "release savepoint t", "rollback to savepoint t"]
      : ["begin", "commit", "rollback"];
    await this.d.exec(open);
    try {
      await this.d.query("select set_config('request.jwt.claims', $1, true)", [claims]);
      await this.d.exec(`set local role ${actor.role}`);
      const res = await this.d.query(query, params);
      if (this.d.remote) await this.d.exec("reset role; select set_config('request.jwt.claims', '', true)");
      await this.d.exec(ok);
      return res;
    } catch (e) {
      await this.d.exec(bad);
      if (this.d.remote) await this.d.exec("reset role");
      throw e;
    }
  }

  /** Same as `as` but returns the error message instead of throwing (null = success). */
  async fails(actor: Actor, query: string, params: unknown[] = []): Promise<string | null> {
    try {
      await this.as(actor, query, params);
      return null;
    } catch (e) {
      return (e as Error).message;
    }
  }

  async close() {
    if (this.d.remote) await this.d.exec("rollback");
    await this.d.close();
  }
}

export async function createTestDb(): Promise<TestDb> {
  if (process.env.RLS_TARGET === "remote") {
    const d = await remoteDriver();
    await d.exec("begin");
    return new TestDb(d);
  }
  const pg = new PGlite();
  await pg.exec(SUPABASE_SHIM);
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith(".sql")).sort();
  for (const f of files) {
    try {
      await pg.exec(readFileSync(join(MIGRATIONS, f), "utf8"));
    } catch (e) {
      throw new Error(`migration ${f} failed: ${(e as Error).message}`);
    }
  }
  return new TestDb(pgliteDriver(pg));
}

// Deterministic synthetic ids
export const U = {
  painter: "00000000-0000-4000-8000-00000000a001",   // Mom, studio A
  sender: "00000000-0000-4000-8000-00000000a002",    // family: send only
  viewer: "00000000-0000-4000-8000-00000000a003",    // family: view + comment
  painterB: "00000000-0000-4000-8000-00000000b001",  // another studio
  outsider: "00000000-0000-4000-8000-00000000c001",  // signed in, no studio
  admin: "00000000-0000-4000-8000-00000000d001",
  newbie: "00000000-0000-4000-8000-00000000e001",
  newbie2: "00000000-0000-4000-8000-00000000e002",
};
export const S = {
  A: "00000000-0000-4000-8000-0000000000aa",
  B: "00000000-0000-4000-8000-0000000000bb",
};

const user = (uid: string, aal: "aal1" | "aal2" = "aal1"): Actor => ({ role: "authenticated", uid, aal });
export const as = {
  painter: user(U.painter),
  sender: user(U.sender),
  viewer: user(U.viewer),
  painterB: user(U.painterB),
  outsider: user(U.outsider),
  admin: user(U.admin, "aal2"),
  admin1: user(U.admin, "aal1"),
  newbie: user(U.newbie),
  newbie2: user(U.newbie2),
  anon: { role: "anon" } as Actor,
  service: { role: "service_role" } as Actor,
};

/** Two studios: A (painter + two family members), B (another painter). */
export async function seed(db: TestDb) {
  await db.sql(`
    insert into auth.users (id, email) values
      ('${U.painter}', 'painter@example.test'), ('${U.sender}', 'sender@example.test'),
      ('${U.viewer}', 'viewer@example.test'), ('${U.painterB}', 'painter.b@example.test'),
      ('${U.outsider}', 'outsider@example.test'), ('${U.admin}', 'admin@example.test'),
      ('${U.newbie}', 'newbie@example.test'), ('${U.newbie2}', 'newbie2@example.test');
    insert into public.app_admins (user_id) values ('${U.admin}');
    insert into public.studios (id, name) values ('${S.A}', '${NAMES.studioA}'), ('${S.B}', '${NAMES.studioB}');
    insert into public.studio_members (studio_id, user_id, role, can_send, can_view, can_comment, can_generate) values
      ('${S.A}', '${U.painter}', 'painter', true, true, true, true),
      ('${S.A}', '${U.sender}', 'family', true, false, false, false),
      ('${S.A}', '${U.viewer}', 'family', false, true, true, false),
      ('${S.B}', '${U.painterB}', 'painter', true, true, true, true);
    insert into public.profiles (user_id, display_name) values
      ('${U.painter}', '${NAMES.painter}'), ('${U.sender}', '${NAMES.son}'),
      ('${U.viewer}', '${NAMES.daughter}'), ('${U.painterB}', '${NAMES.otherPainter}');
    insert into public.invites (studio_id, token_hash, role, can_send) values
      ('${S.A}', public.token_hash('token-a-seed'), 'family', true),
      ('${S.B}', public.token_hash('token-b-seed'), 'family', true);
  `);
}
