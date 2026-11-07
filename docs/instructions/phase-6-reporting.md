# Phase 6 — Reporting

> Parent checklist: [tasks.md](tasks.md) · Methodology reference: [README.md](README.md)

## Objective

Consolidate findings from Phases 1–5 into a client-ready report, then manage delivery, review, and retest logistics.

## Scope & Guardrails

- The report and any drafts must **not** contain live credentials, tokens, or session cookies — reference "Admin User"/"Standard User" rather than raw usernames/passwords where possible, and redact anything sensitive from screenshots
- AI/LLM findings (Phase 4) may contain verbatim jailbreak output or extracted system prompts — redact or summarize anything genuinely sensitive/offensive rather than quoting it in full in the client-facing report; keep the unredacted evidence only in the evidence folder
- All client communication (delivery, scheduling calls, retest coordination) is human-only — the AI should draft content but not send/schedule anything on the client's behalf without explicit human action
- Draft materials should be saved under [../2026/assessment1/report/](../2026/assessment1/report/); source evidence for findings should already exist under [../2026/assessment1/evidence/](../2026/assessment1/evidence/) — reference it (including any redacted exports) rather than re-collecting it

## Checklist

- [ ] Draft executive summary
- [ ] Compile technical findings with risk ratings and evidence
- [ ] Remediation recommendations
- [ ] Deliver draft report to client
- [ ] Offer findings review call
- [ ] Schedule retest window (if required)

---

## Instructions for AI Agent

1. **Executive summary**
   - Draft a short, non-technical summary: overall risk posture, number of findings by severity, most critical business risks, and general recommendation themes — call out the AI/LLM-specific risk posture (Phase 4) as its own highlighted section given it's a defining characteristic of this application
2. **Technical findings compilation**
   - Pull together all findings recorded in Phases 1–5 into a single structured list, each with: title, affected component/endpoint, description, risk rating (e.g., CVSS or Critical/High/Medium/Low/Informational), evidence references (pointing to the saved files under [../2026/assessment1/evidence/](../2026/assessment1/evidence/)), and reproduction steps
   - For AI/LLM findings, map each to its OWASP Top 10 for LLM Applications category (e.g. LLM01 Prompt Injection, LLM06 Sensitive Information Disclosure) and note reproducibility, given LLM output is non-deterministic
   - Draw on each phase subfolder's `reasoning.md` (see [evidence/README.md](../2026/assessment1/evidence/README.md#capturing-ai-reasoning)) to write accurate reproduction steps and rationale, and to double-check that non-findings were correctly ruled out rather than just missed
   - De-duplicate overlapping findings across phases (e.g., a header issue found in both Phase 2 and Phase 3) and cross-reference instead of repeating
   - Redact/anonymize any credentials, tokens, or PII in evidence snippets before they go into the draft
   - Explicitly document any untested gaps (e.g., horizontal privilege escalation between two Admin accounts — only one Admin account is provisioned, see Phase 5) as scope limitations rather than omitting them silently
3. **Remediation recommendations**
   - For each finding, draft a concrete, actionable remediation recommendation, prioritized alongside its risk rating — for AI/LLM findings, recommendations typically include system-prompt hardening, output-encoding/sanitization before rendering AI content, server-side re-validation of AI-judged scores, and tenant isolation of model context/RAG data
4. **Draft assembly**
   - Produce the full draft report document (executive summary + findings + remediation) in [../2026/assessment1/report/](../2026/assessment1/report/), ready for human review before client delivery

**Output for this phase:** a complete draft report file saved under [../2026/assessment1/report/](../2026/assessment1/report/), plus a short list of any open questions/gaps the human should resolve before delivery (e.g., ambiguous risk ratings, findings needing more evidence, the untested Admin-vs-Admin horizontal-escalation gap).

## Instructions for Human Tester

- Review and sign off on the full draft report — verify risk ratings match business context and no sensitive data (credentials, real customer data, verbatim jailbreak output) leaked into the document
- For AI/LLM findings, confirm with the client whether AI-generated capability scores feed into real HR/business decisions before finalizing severity ratings
- Deliver the draft report to the client through the agreed channel
- Offer and, if accepted, conduct the findings review call with the client
- Coordinate and schedule the retest window once the client has remediated findings (if a retest is in scope)
- Ensure all test credentials are rotated or deleted per the engagement's data-handling policy after sign-off
- Mark Phase 6 and the overall engagement complete in [tasks.md](tasks.md)
