/** Key builders for the S3 layout in PLAN.md section 5. Hashes are hex HMACs, never raw emails. */
export const keys = {
  userPrefix: (emailHash: string) => `users/${emailHash}/`,
  profile: (emailHash: string) => `users/${emailHash}/profile.json`,
  sessionsPrefix: (emailHash: string) => `users/${emailHash}/sessions/`,
  session: (emailHash: string, sessionId: string) =>
    `users/${emailHash}/sessions/${sessionId}.json`,
  runsPrefix: (emailHash: string) => `users/${emailHash}/runs/`,
  runPrefix: (emailHash: string, runId: string) => `users/${emailHash}/runs/${runId}/`,
  runSummary: (emailHash: string, runId: string) => `users/${emailHash}/runs/${runId}/summary.json`,
  runInput: (emailHash: string, runId: string) => `users/${emailHash}/runs/${runId}/input.json`,
  /** Marks that a run's credit was spent (or waived for staff). */
  runCredit: (emailHash: string, runId: string) => `users/${emailHash}/runs/${runId}/credit.json`,
  /** Created when the customer (or staff) stops a run, so the finaliser reports `stopped`. */
  runStop: (emailHash: string, runId: string) => `users/${emailHash}/runs/${runId}/stop.json`,
  runEventsPrefix: (emailHash: string, runId: string) => `users/${emailHash}/runs/${runId}/events/`,
  /** Events `first`..`last` (inclusive); the zero-padded names sort in seq order. */
  runEventChunk: (emailHash: string, runId: string, first: number, last: number) =>
    `users/${emailHash}/runs/${runId}/events/${String(first).padStart(9, "0")}-${String(last).padStart(9, "0")}.json`,
  /** The sequencer: last seq, recent batch ids and the folded run state. */
  runEventState: (emailHash: string, runId: string) =>
    `users/${emailHash}/runs/${runId}/events/_state.json`,
  runEvidence: (emailHash: string, runId: string, name: string) =>
    `users/${emailHash}/runs/${runId}/evidence/${name}.json`,
  runReportHtml: (emailHash: string, runId: string) =>
    `users/${emailHash}/runs/${runId}/report/report.html`,
  runReportData: (emailHash: string, runId: string) =>
    `users/${emailHash}/runs/${runId}/report/findings.json`,
  /** Estimated cost of the run; staff only. */
  runCost: (emailHash: string, runId: string) => `users/${emailHash}/runs/${runId}/cost.json`,
  entitlements: (emailHash: string) => `users/${emailHash}/entitlements.json`,
  targetsPrefix: (emailHash: string) => `users/${emailHash}/targets/`,
  target: (emailHash: string, targetId: string) => `users/${emailHash}/targets/${targetId}.json`,
  scansPrefix: (emailHash: string) => `users/${emailHash}/scans/`,
  scan: (emailHash: string, scanId: string) => `users/${emailHash}/scans/${scanId}.json`,
  otp: (emailHash: string) => `auth/otp/${emailHash}.json`,
  notifyConfirm: (tokenHash: string) => `auth/notify-confirm/${tokenHash}.json`,
  rateLimit: (scope: string, window: string) => `auth/ratelimit/${scope}/${window}.json`,
  /** Every counter scoped to one mailbox (`email-<hash>-...`), for account deletion. */
  emailRateLimits: (emailHash: string) => `auth/ratelimit/email-${emailHash}-`,
  suppression: (emailHash: string) => `suppression/${emailHash}.json`,
  /** Staff actions on accounts (credit grants), kept after the account is deleted. */
  audit: (at: Date, id: string) =>
    `admin/audit/${at.getUTCFullYear()}/${String(at.getUTCMonth() + 1).padStart(2, "0")}/${String(at.getUTCDate()).padStart(2, "0")}/${id}.json`,
  /** Anonymised per-run summary and cost for the staff dashboard; survives deletion. */
  runIndex: (at: Date, runId: string) =>
    `admin/run-index/${at.getUTCFullYear()}/${String(at.getUTCMonth() + 1).padStart(2, "0")}/${String(at.getUTCDate()).padStart(2, "0")}/${runId}.json`,
} as const;
