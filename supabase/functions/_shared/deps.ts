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
  };
  /** Verifies a user access token; null when invalid/expired. */
  verifyJwt(token: string): Promise<Claims | null>;
  /** Calls a Postgres function with the service role. Throws on error. */
  rpc<T = any>(fn: string, args: Record<string, unknown>): Promise<T>;
  admin: {
    createUser(email: string): Promise<"created" | "exists">;
  };
  /** Structured, payload-free logging. */
  log(event: string, fields?: Record<string, string | number | boolean | null>): void;
  now(): Date;
}
