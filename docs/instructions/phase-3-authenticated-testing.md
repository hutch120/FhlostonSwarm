# Phase 3 — Authenticated Testing (Admin & Standard User)

> Parent checklist: [tasks.md](tasks.md) · Methodology reference: [README.md](README.md)

## Objective

Repeat testing across every provisioned access tier to evaluate how well the application enforces its own privilege boundaries, and to find vulnerabilities only reachable once logged in.

## Credentials

See [tasks.md](tasks.md) for the current list of logins. **Do not copy credentials into new files, scripts, commit messages, or reports** — reference them from the existing credentials table only, and use environment variables/secrets storage if a script needs to consume them. Rotate/delete all test credentials at engagement close.

## Application Structure (from initial intel)

- **Admin login:** the account with the most privilege. Record the areas, navigation and functions it reaches, and which of them are meant for administrators only.
- **Standard logins** (one or more, provisioned for horizontal escalation testing): record what a normal user sees and which administrative areas are hidden from them. An explicit "access denied" screen is a positive access-control signal worth re-confirming at the API level, not just in the UI.
- Where the application has AI-driven features, note which pages and endpoints take user input for a model, so [Phase 4](./phase-4-ai-llm-security-testing.md) can use them. This phase focuses on access control and session mechanics.

## Scope & Guardrails

- Test one account/tier at a time; do not mix sessions between tiers in the same browser profile/tool session (avoid cross-contamination of results)
- Stay within each account's intended scope unless deliberately testing for privilege escalation (that's Phase 5, but boundary-testing discoveries here should still be recorded)
- Do not lock out accounts by repeated bad logins beyond what's needed to confirm lockout behavior once
- Save all downloaded/captured evidence (screenshots, request/response captures, exported data) under the run's evidence folder in the `phase-3-authenticated-testing/` subfolder, with a per-account subfolder inside it (e.g. `phase-3-authenticated-testing/admin-user/`, `phase-3-authenticated-testing/standard-user/`, `phase-3-authenticated-testing/standard-user-2/`) — see the evidence conventions in the [README](README.md#8-evidence) for the folder structure and naming conventions

## Checklist

- [ ] Test as Admin User
- [ ] Test as Standard User
- [ ] Test as Standard User (2nd account — the second Standard login)

---

## Instructions for AI Agent

For each account, save all evidence (screenshots, request/response captures, exported pages/data) to the `phase-3-authenticated-testing/<account>/` subfolder under the run's evidence folder as you go:

1. Log in and enumerate the full navigable surface (menus, pages, API calls made by the SPA/app) available to that role
2. Record what data/functions are visible vs. hidden compared to the account's expected role (Admin vs. Standard User); for the Standard User accounts, additionally record each account's own objects so Phase 5 has a baseline for horizontal IDOR testing (object IDs belonging to one account vs. the other)
3. Check for authorization enforcement at the API/request level, not just UI hiding — e.g., as a Standard User, directly call the administrative endpoints observed only under the Admin account and confirm the backend also rejects them, not just the UI; save the raw request/response captures
4. Test session management: cookie/token flags (`HttpOnly`, `Secure`, `SameSite`), session timeout behavior, logout invalidation, concurrent session handling
5. Test authentication mechanics: password reset flow, account lockout after repeated failures (only trigger once per account to confirm behavior, then stop), MFA presence/absence (note: Google OAuth sign-in is present in the UI but was observed disabled in this staging environment during initial intel — confirm current state)
6. Enumerate and record every distinct object type and endpoint reachable by each account — this inventory feeds directly into [Phase 4](./phase-4-ai-llm-security-testing.md) and [Phase 5](./phase-5-business-logic-privilege-escalation.md)
7. Produce a per-account summary of accessible features/data and any suspicious authorization gaps

**Output for this phase:** all captured evidence saved under the `phase-3-authenticated-testing/` subfolder in the run's evidence folder (one subfolder per account), a `reasoning.md` per account subfolder capturing why each check was performed and how the observed behavior was interpreted against that account's expected role (see the evidence conventions in the [README](README.md#8-evidence)), plus one findings/notes block per account referencing the saved evidence, and a consolidated diff-style comparison across accounts (this feeds directly into Phase 4 and Phase 5).

## Instructions for Human Tester

- Manually validate any AI-reported authorization gaps by reproducing them interactively (confirm they're not false positives caused by session/cookie mix-ups)
- Exercise judgment-heavy checks: does displayed data make business sense for this role? Is there anything sensitive shown that a Standard User shouldn't see, even if not an outright access-control bug?
- Confirm password reset / account lockout / MFA behavior matches what the client expects contractually
- Note that the second Standard User account (the second Standard login) is now provisioned specifically to enable horizontal privilege-escalation testing in Phase 5 — confirm both accounts' object IDs/assignments were recorded distinctly during enumeration
- Track evidence (screenshots, request/response captures) per account for use in the Phase 6 report — confirm the AI has saved these under the `phase-3-authenticated-testing/` subfolder in the run's evidence folder rather than only describing them
- Sign off on Phase 3 completion in [tasks.md](tasks.md) before moving to Phase 4
