# Pen Test Engagement

## Target

- **URL:** https://app.stg.pwc.polynize.io/
- **Application:** Polynize — an AI-driven workforce capability platform. Admins build "Projects" containing "Work models" (AI scenario/persona configuration), "Templates", and "Inputs"; standard users complete AI-driven roleplay "Plays"/"Scenarios" ("Battles") where their responses are scored against an AI-generated benchmark. This heavy use of LLMs for persona roleplay and automated scoring makes prompt injection and other AI-specific abuse a primary focus of this engagement (see [phase-4-ai-llm-security-testing.md](phase-4-ai-llm-security-testing.md)).
- **Workspace in scope:** `PWC-ADVISORY-US` (the workspace/tenant the provided accounts belong to) — do not pivot into other workspaces/tenants if observed.
- **Scope confirmed:** `*.stg.pwc.polynize.io` (any subdomain, including the `content.stg.pwc.polynize.io` asset host observed during initial intel) is in scope.

## Provided Credentials

> Sensitive — handle per engagement data-handling policy; delete/rotate after test completion.

### Web Application Logins

Password for all users: `polynize1234!`

| Role | Scope | Username |
|------|-------|----------|
| Admin User | Workspace admin — full access to Projects/Work models/Templates/Inputs within `PWC-ADVISORY-US` | developer@polynize.io |
| Standard User | Learner/participant — scenario ("Play") completion and own results only | learner@polynize.io |
| Standard User (2nd) | Learner/participant — scenario ("Play") completion and own results only; used for horizontal privilege-escalation testing (Phase 5) | learner2@polynize.io |

> Two Standard User accounts (`learner@polynize.io` and `learner2@polynize.io`) are now provisioned, enabling horizontal privilege-escalation testing between same-tier accounts in Phase 5. Only one Admin User account is provisioned.

## Evidence Storage

All downloaded/captured files (raw tool output, website files such as HTML/CSS/JS, scan reports, screenshots, HAR files, etc.) must be saved under [../2026/assessment1/evidence/](../2026/assessment1/evidence/), organized in a per-phase subfolder, for further manual review. Do not let downloaded or generated files only exist transiently in tool output — save a copy before summarizing. See [../2026/assessment1/evidence/README.md](../2026/assessment1/evidence/README.md) for the full folder structure and naming conventions. The final report deliverable goes under [../2026/assessment1/report/](../2026/assessment1/report/).

## Tasks

### Phase 1 — Reconnaissance (Unauthenticated)
> Detailed instructions: [phase-1-reconnaissance.md](phase-1-reconnaissance.md)
- [ ] Passive OSINT (WHOIS, DNS, certificate transparency)
- [ ] Active recon: subdomain enumeration, port/service scanning, technology fingerprinting
- [ ] Content discovery: directory/file brute forcing, robots.txt, sitemap review

### Phase 2 — Unauthenticated Vulnerability Assessment
> Detailed instructions: [phase-2-vulnerability-assessment.md](phase-2-vulnerability-assessment.md)
- [ ] Automated web app scan
- [ ] TLS/SSL configuration check
- [ ] Manual review of publicly accessible pages/forms
- [ ] Check for default credentials, exposed admin panels, security headers, verbose error messages

### Phase 3 — Authenticated Testing (Admin & Standard User)
> Detailed instructions: [phase-3-authenticated-testing.md](phase-3-authenticated-testing.md)
- [ ] Test as Admin User
- [ ] Test as Standard User
- [ ] Test as Standard User (2nd account)

### Phase 4 — AI / LLM Security Testing
> Detailed instructions: [phase-4-ai-llm-security-testing.md](phase-4-ai-llm-security-testing.md)
- [ ] Direct prompt injection against scenario/"Play" AI personas
- [ ] Indirect prompt injection via admin-controlled Inputs/Templates/Work models content
- [ ] System prompt / persona / grading-rubric extraction
- [ ] Jailbreak / safety-guardrail bypass of the roleplay AI
- [ ] AI benchmark-scoring manipulation ("Evaluating a Benchmark Response" and similar scored Plays)
- [ ] Insecure output handling (unsanitized AI output rendered in the UI, e.g. stored XSS via AI responses)
- [ ] Excessive agency / tool-use abuse by the AI persona
- [ ] Cross-tenant data/system-prompt leakage between workspaces

### Phase 5 — Business Logic & Privilege Escalation
> Detailed instructions: [phase-5-business-logic-privilege-escalation.md](phase-5-business-logic-privilege-escalation.md)
- [ ] Horizontal privilege escalation between same-tier accounts (`learner@polynize.io` vs `learner2@polynize.io`)
- [ ] Vertical privilege escalation: Standard User → Admin User
- [ ] Workflow abuse checks (step-skipping, race conditions, etc.) across Projects/Work models/Plays

### Phase 6 — Reporting
> Detailed instructions: [phase-6-reporting.md](phase-6-reporting.md)
- [ ] Draft executive summary
- [ ] Compile technical findings with risk ratings and evidence
- [ ] Remediation recommendations
- [ ] Deliver draft report to client
- [ ] Offer findings review call
- [ ] Schedule retest window (if required)
