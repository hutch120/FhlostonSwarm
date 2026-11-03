# Phase 5 — Business Logic & Privilege Escalation

> Parent checklist: [tasks.md](tasks.md) · Methodology reference: [README.md](README.md)

## Objective

Using the account/endpoint notes from [Phase 3](./phase-3-authenticated-testing.md) and the AI-surface notes from [Phase 4](./phase-4-ai-llm-security-testing.md), actively probe for horizontal/vertical privilege escalation and business-logic/workflow abuse across Projects, Work models, Templates, Inputs, and Plays. This is the highest-value, highest-judgment phase — treat AI output here as hypotheses to be validated, not confirmed findings.

## Scope & Guardrails

- Escalation attempts should target only the accounts provided for this engagement — do not attempt to enumerate/guess other real customers' data, workspaces, or accounts
- Two Standard User accounts (`learner@polynize.io`, `learner2@polynize.io`) and one Admin account (`developer@polynize.io`) are provisioned, enabling horizontal escalation testing between the two Standard User accounts; horizontal escalation between two Admin accounts remains untestable with only one Admin account provisioned — note this as a scope limitation rather than a "pass"
- Any action that would modify or delete another account's/project's data must be reversible or pre-approved by the human tester before execution
- Rate-limit any scripted IDOR/enumeration checks to avoid triggering lockouts, alerts, or degrading the shared staging environment
- Save all raw request/response evidence for escalation attempts under [../2026/assessment1/evidence/](../2026/assessment1/evidence/) in the `phase-5-business-logic-privilege-escalation/` subfolder — see [../2026/assessment1/evidence/README.md](../2026/assessment1/evidence/README.md) for the folder structure and naming conventions

## Checklist

- [ ] Horizontal privilege escalation between same-tier accounts (`learner@polynize.io` vs `learner2@polynize.io`)
- [ ] Vertical privilege escalation: Standard User → Admin User (Projects/Work models/Templates/Inputs access)
- [ ] IDOR checks on project/work-model/Play/result identifiers
- [ ] Workflow abuse checks (step-skipping, race conditions, etc.) across project creation, Play completion/scoring, and any invitation/provisioning flow

## Instructions for AI Agent

1. **Vertical escalation (Standard User → Admin User)**
   - Using the Standard User session, replay requests/endpoints for Projects, Work models, Templates, and Inputs that were only observed under the Admin account in Phase 3
   - Check for missing server-side role checks (e.g., an admin-only API accepting a Standard User session token)
   - Check for parameter/role tampering opportunities (e.g., a hidden form field, JWT claim, or request parameter indicating role that can be modified client-side) that could unlock Studio navigation for the Standard User
   - Confirm whether the "Access denied… Contact your administrator" screen observed for the Standard User (see Phase 3) is enforced server-side and not just a client-side route guard
2. **Horizontal escalation / IDOR (`learner@polynize.io` vs `learner2@polynize.io`)**
   - Using each account's own session, attempt to reference the other account's/project's object IDs/resource identifiers (project IDs, work model IDs, Play/battle IDs, result IDs) captured during Phase 3 enumeration — swap IDs in requests and observe whether access is granted or denied
   - Script this as a repeatable, parameterized check (record request template + expected vs actual authorization result) rather than one-off manual calls
   - Also test whether a Play/result ID can be incremented/guessed and accessed cross-account/cross-project without authorization (IDOR via predictable identifiers)
3. **Workflow abuse**
   - Identify multi-step processes (e.g., project creation, Work model/Template/Input authoring, Play assignment, invitations/provisioning, benchmark scoring) and test: skipping steps by calling later-step endpoints directly, replaying/reusing one-time tokens or invite links, and submitting concurrent/rapid duplicate requests to probe for race conditions
   - Keep all workflow-abuse tests non-destructive/reversible where possible; flag anything that risks leaving the system in a bad state for human review before running

**Output for this phase:** for every escalation attempt, save the raw request/response evidence to the `phase-5-business-logic-privilege-escalation/` subfolder in [../2026/assessment1/evidence/](../2026/assessment1/evidence/) and record: account used, target resource/action, expected authorization outcome, actual outcome, and a reference to the saved evidence. Keep a `reasoning.md` in that subfolder explaining the rationale behind each escalation hypothesis and why the outcome was judged a pass/fail (see [evidence/README.md](../2026/assessment1/evidence/README.md#capturing-ai-reasoning)) — this is essential given how judgment-heavy this phase is. Clearly separate "confirmed vulnerability" from "needs human validation."

## Instructions for Human Tester

- Review every AI-flagged escalation result manually — this phase carries the highest risk of false positives/negatives and the highest business impact if wrong
- Horizontal escalation between two Admin accounts remains untestable (only one Admin account provisioned) — ensure the report explicitly states this as a scope limitation rather than a "pass"
- Exercise business judgment on workflow-abuse findings (e.g., does a race condition actually produce a duplicate/corrupted Play result, or is it already serialized safely server-side?)
- Approve any AI-proposed test before it risks modifying/deleting cross-project or cross-account data
- Rank confirmed findings by severity/impact for the report
- Sign off on Phase 5 completion in [tasks.md](tasks.md) before moving to Phase 6
