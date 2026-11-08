/** Key builders for the S3 layout in PLAN.md section 5. Hashes are hex HMACs, never raw emails. */
export const keys = {
  userPrefix: (emailHash: string) => `users/${emailHash}/`,
  profile: (emailHash: string) => `users/${emailHash}/profile.json`,
  sessionsPrefix: (emailHash: string) => `users/${emailHash}/sessions/`,
  session: (emailHash: string, sessionId: string) =>
    `users/${emailHash}/sessions/${sessionId}.json`,
  runsPrefix: (emailHash: string) => `users/${emailHash}/runs/`,
  runPrefix: (emailHash: string, runId: string) => `users/${emailHash}/runs/${runId}/`,
  entitlements: (emailHash: string) => `users/${emailHash}/entitlements.json`,
  otp: (emailHash: string) => `auth/otp/${emailHash}.json`,
  rateLimit: (scope: string, window: string) => `auth/ratelimit/${scope}/${window}.json`,
  freeClaim: (emailHash: string) => `claims/free/${emailHash}.json`,
  freeTargetClaim: (domainHash: string) => `claims/free-target/${domainHash}.json`,
  suppression: (emailHash: string) => `suppression/${emailHash}.json`,
} as const;
