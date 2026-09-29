// Edge Function "delete-image" — thin wrapper; the logic lives in _shared/handlers/delete.ts
import { createDeps } from "../_shared/supabaseDeps.ts";
import { createDeleteHandler } from "../_shared/handlers/delete.ts";

Deno.serve(createDeleteHandler(createDeps()));
