// Limits shared by the Edge Functions. Paid providers (Claude, Higgsfield) are
// added in later phases, each with its own quota (ART-PLAN §5–6).

export const LIMITS = {
  maxRequestBytes: 12 * 1024 * 1024,  // whole JSON body (used by image endpoints later)
};

/** [max calls, window seconds] per IP / per token for public endpoints. */
export const RATE: Record<string, [number, number]> = {
  inviteIp: [15, 900],
  inviteToken: [6, 900],
  deleteUser: [60, 600],   // per signed-in user: plenty for tidying up, stops a runaway loop
};

/** How many waiting files one run of the cleanup takes (after a delete / on the schedule). */
export const CLEANUP = { afterDelete: 5, scheduled: 100 };
