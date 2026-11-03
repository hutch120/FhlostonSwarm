# Phase 3 — Authenticated Testing (Admin & Standard User)

> Parent checklist: [tasks.md](tasks.md) · Methodology reference: [README.md](README.md)

## Objective

Repeat testing across every provisioned access tier to evaluate how well the application enforces its own privilege boundaries, and to find vulnerabilities only reachable once logged in.

## Credentials

See [tasks.md](tasks.md) for the current list of logins. **Do not copy credentials into new files, scripts, commit messages, or reports** — reference them from the existing credentials table only, and use environment variables/secrets storage if a script needs to consume them. Rotate/delete all test credentials at engagement close.

## Application Structure (from initial intel)

- **Admin User** (`developer@polynize.io`): lands in the **Studio** area, scoped to workspace `PWC-ADVISORY-US`. Has a "Change studio section" switcher exposing **Projects**, **Work models**, **Templates**, and **Inputs**. Owns at least one project ("Test Developer Project 001") with 1 work model, 1 user, and 1 Play.
- **Standard User** (`learner@polynize.io`, plus a second Standard User `learner2@polynize.io` provisioned for horizontal escalation testing): lands in a **"Your results"** dashboard (capability categories: Communication, Creative, Collaboration, Emotional, Analytic, Functional) and has no visible access to Projects/Work models/Templates/Inputs — attempting to reach `#/studio` as this user returned an explicit "Access denied… Contact your administrator" screen during initial intel, which is a positive access-control signal worth re-confirming (and worth probing for an API-level bypass, not just the UI message).
- Users complete AI-driven roleplay/assessment exercises called **"Plays"** (routed as `#/battle/<id>` and `#/battle/<id>/result/<id>`), where a response is scored against an AI-generated benchmark (e.g. an observed result was titled "Evaluating a Benchmark Response"). This AI surface is tested in depth in [Phase 4](./phase-4-ai-llm-security-testing.md) — this phase should focus on access control/session mechanics, and simply note which Play/result endpoints exist for Phase 4 to use.

## Scope & Guardrails

- Test one account/tier at a time; do not mix sessions between tiers in the same browser profile/tool session (avoid cross-contamination of results)
- Stay within each account's intended scope unless deliberately testing for privilege escalation (that's Phase 5, but boundary-testing discoveries here should still be recorded)
- Do not lock out accounts by repeated bad logins beyond what's needed to confirm lockout behavior once
- Save all downloaded/captured evidence (screenshots, request/response captures, exported data) under [../2026/assessment1/evidence/](../2026/assessment1/evidence/) in the `phase-3-authenticated-testing/` subfolder, with a per-account subfolder inside it (e.g. `phase-3-authenticated-testing/admin-user/`, `phase-3-authenticated-testing/standard-user/`, `phase-3-authenticated-testing/standard-user-2/`) — see [../2026/assessment1/evidence/README.md](../2026/assessment1/evidence/README.md) for the folder structure and naming conventions

## Checklist

- [ ] Test as Admin User
- [ ] Test as Standard User
- [ ] Test as Standard User (2nd account — `learner2@polynize.io`)

---

## Instructions for AI Agent

For each account, save all evidence (screenshots, request/response captures, exported pages/data) to the `phase-3-authenticated-testing/<account>/` subfolder under [../2026/assessment1/evidence/](../2026/assessment1/evidence/) as you go:

1. Log in and enumerate the full navigable surface (menus, pages, API calls made by the SPA/app) available to that role
2. Record what data/functions are visible vs. hidden compared to the account's expected role (Admin vs. Standard User); for the two Standard User accounts, additionally record each account's own project/Play assignments so Phase 5 has a baseline for horizontal IDOR testing (object IDs belonging to one account vs. the other)
3. Check for authorization enforcement at the API/request level, not just UI hiding — e.g., as the Standard User, directly call the Studio/Projects/Work models/Templates/Inputs API endpoints observed only under the Admin account and confirm the backend also rejects them, not just the UI; save the raw request/response captures
4. Test session management: cookie/token flags (`HttpOnly`, `Secure`, `SameSite`), session timeout behavior, logout invalidation, concurrent session handling
5. Test authentication mechanics: password reset flow, account lockout after repeated failures (only trigger once per account to confirm behavior, then stop), MFA presence/absence (note: Google OAuth sign-in is present in the UI but was observed disabled in this staging environment during initial intel — confirm current state)
6. Enumerate and record every distinct Play/Battle/result endpoint, project, work model, template, and input reachable by each account — this inventory feeds directly into [Phase 4](./phase-4-ai-llm-security-testing.md) and [Phase 5](./phase-5-business-logic-privilege-escalation.md)
7. Produce a per-account summary of accessible features/data and any suspicious authorization gaps

**Output for this phase:** all captured evidence saved under the `phase-3-authenticated-testing/` subfolder in [../2026/assessment1/evidence/](../2026/assessment1/evidence/) (one subfolder per account), a `reasoning.md` per account subfolder capturing why each check was performed and how the observed behavior was interpreted against that account's expected role (see [evidence/README.md](../2026/assessment1/evidence/README.md#capturing-ai-reasoning)), plus one findings/notes block per account referencing the saved evidence, and a consolidated diff-style comparison across accounts (this feeds directly into Phase 4 and Phase 5).

## Instructions for Human Tester

- Manually validate any AI-reported authorization gaps by reproducing them interactively (confirm they're not false positives caused by session/cookie mix-ups)
- Exercise judgment-heavy checks: does displayed data make business sense for this role? Is there anything sensitive shown that a Standard User shouldn't see, even if not an outright access-control bug?
- Confirm password reset / account lockout / MFA behavior matches what the client expects contractually
- Note that the second Standard User account (`learner2@polynize.io`) is now provisioned specifically to enable horizontal privilege-escalation testing in Phase 5 — confirm both accounts' object IDs/assignments were recorded distinctly during enumeration
- Track evidence (screenshots, request/response captures) per account for use in the Phase 6 report — confirm the AI has saved these under the `phase-3-authenticated-testing/` subfolder in [../2026/assessment1/evidence/](../2026/assessment1/evidence/) rather than only describing them
- Sign off on Phase 3 completion in [tasks.md](tasks.md) before moving to Phase 4
