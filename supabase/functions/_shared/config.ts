// Limits shared by the Edge Functions. Paid providers (Claude, Higgsfield) are
// added in later phases, each with its own quota (ART-PLAN §5–6).

export const LIMITS = {
  maxRequestBytes: 12 * 1024 * 1024,  // whole JSON body (used by image endpoints later)
};

/** [max calls, window seconds] per IP / per token for public endpoints. */
export const RATE: Record<string, [number, number]> = {
  inviteIp: [15, 900],
  inviteToken: [6, 900],
};
