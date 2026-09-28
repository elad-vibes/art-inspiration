// Everything a handler needs from the outside world. The real implementation
// lives in supabaseDeps.ts (Deno); tests pass fakes.

export interface Claims {
  sub: string;
  email?: string;
  aal?: string;   // 'aal1' | 'aal2'
  role?: string;  // 'authenticated'
}

export interface Deps {
  env: {
    allowedOrigins: string[];
    requireOrigin: boolean;
    appUrl: string;
    /** Secret the scheduler sends to storage-cleanup. Empty = that function is switched off. */
    cronSecret: string;
  };
  /** Verifies a user access token; null when invalid/expired. */
  verifyJwt(token: string): Promise<Claims | null>;
  /** Calls a Postgres function with the service role. Throws on error. */
  rpc<T = any>(fn: string, args: Record<string, unknown>): Promise<T>;
  /**
   * Calls a Postgres function AS THE CALLER, with their own token: auth.uid(), RLS and the
   * two-factor rule apply exactly as if the browser had called it. On a database error it
   * throws an Error with `.pgMessage` (our own `raise exception` text — never logged).
   */
  userRpc<T = any>(token: string, fn: string, args: Record<string, unknown>): Promise<T>;
  /** The private "images" bucket, with the service role. */
  storage: {
    /** Removes files. Throws when Storage fails. A file that is already gone is not an error. */
    remove(paths: string[]): Promise<void>;
  };
  admin: {
    createUser(email: string): Promise<"created" | "exists">;
  };
  /** Structured, payload-free logging. */
  log(event: string, fields?: Record<string, string | number | boolean | null>): void;
  now(): Date;
}
