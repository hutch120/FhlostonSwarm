# Engagement Checklist (template)

This checklist is **generated for every run** from its engagement plan (`engagement.json`, see [PLAN.md section 8](../PLAN.md#8-dynamic-instructions--discovery-phase)); it is no longer edited by hand. It holds no target, no credentials and no paths: those come from the run. This file shows the shape of what is generated, so the phase files can refer to it.

## What the run supplies

- **Target:** the application URL and the declared hosts (the scope proxy refuses every other host).
- **Logins:** up to four, by slot (`admin`, `user1`, `user2`, `other`), each with the owner's description of the role. They are read from the run input; never copy them into files, commit messages or reports.
- **Plan:** which agents run, which checks are skipped as not applicable (with the reason), the role test matrix and target-specific hints.
- **Evidence:** kept in the run's private evidence folder; the customer's report is a redacted view of it.

## Tasks

### Phase 1 — Reconnaissance (Unauthenticated)
> Detailed instructions: [phase-1-reconnaissance.md](phase-1-reconnaissance.md)
- [ ] Passive OSINT (WHOIS, DNS, certificate transparency)
- [ ] Active recon: surface mapping, technology fingerprinting
- [ ] Content discovery: robots.txt, sitemap review, public JavaScript

### Phase 2 — Unauthenticated Vulnerability Assessment
> Detailed instructions: [phase-2-vulnerability-assessment.md](phase-2-vulnerability-assessment.md)
- [ ] TLS/SSL configuration check
- [ ] Security headers, cookies, exposed files and error pages
- [ ] Cross-origin (CORS) behaviour

### Phase 3 — Authenticated Testing (per supplied login)
> Detailed instructions: [phase-3-authenticated-testing.md](phase-3-authenticated-testing.md)
- [ ] Test each supplied login (one entry per role in the plan)
- [ ] Session identifier strength, renewal at sign-in and invalidation at sign-out
- [ ] Access matrix across roles, vertical escalation, administrative exposure

### Phase 4 — AI / LLM Security Testing (when the plan finds an AI feature)
> Detailed instructions: [phase-4-ai-llm-security-testing.md](phase-4-ai-llm-security-testing.md)
- [ ] Direct prompt injection
- [ ] System prompt disclosure
- [ ] Unsafe handling of model output, excessive agency, limits

### Phase 5 — Business Logic & Privilege Escalation
> Detailed instructions: [phase-5-business-logic-privilege-escalation.md](phase-5-business-logic-privilege-escalation.md)
- [ ] Horizontal access between same-tier logins (IDOR)
- [ ] Bulk export and download paths
- [ ] Workflow abuse (needs state-changing requests; reported as a scope limitation by an automated read-only scan)

### Phase 6 — Reporting
> Detailed instructions: [phase-6-reporting.md](phase-6-reporting.md)
- [ ] Executive summary, positive findings, scope and methodology
- [ ] Technical findings with evidence, reproduction steps and an independent re-test
- [ ] Recommended priorities
