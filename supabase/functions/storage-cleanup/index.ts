// Edge Function "storage-cleanup" — thin wrapper; the logic lives in _shared/handlers/cleanup.ts
import { createDeps } from "../_shared/supabaseDeps.ts";
import { createCleanupHandler } from "../_shared/handlers/cleanup.ts";

Deno.serve(createCleanupHandler(createDeps()));
