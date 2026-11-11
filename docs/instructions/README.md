# Blackbox Website Penetration Test — Engagement Outline

High-level outline for blackbox penetration tests performed by **Fhloston Advisory** against customer websites. This document describes the standard methodology, scope considerations, and the tiered login access levels used during authenticated testing phases.

> This is the general methodology reference. It holds no engagement-specific content: a run supplies its own target, logins and plan, and [tasks.md](tasks.md) shows the checklist that is generated for each run. The phases are also the versioned prompt modules the platform builds its agents' prompts from (`src/agents/src/instructions/modules.ts`, recorded as `instructionsVersion` on every run). Each phase below has a corresponding detailed instructions file: [phase-1-reconnaissance.md](phase-1-reconnaissance.md), [phase-2-vulnerability-assessment.md](phase-2-vulnerability-assessment.md), [phase-3-authenticated-testing.md](phase-3-authenticated-testing.md), [phase-4-ai-llm-security-testing.md](phase-4-ai-llm-security-testing.md), [phase-5-business-logic-privilege-escalation.md](phase-5-business-logic-privilege-escalation.md), [phase-6-reporting.md](phase-6-reporting.md). For ready-to-use AI agent prompts, see [prompts.md](prompts.md).

## 1. Engagement Overview

- **Test type:** Blackbox (and greybox for authenticated phases)
- **Target:** Customer-owned website(s) / web application(s)
- **Goal:** Identify security vulnerabilities, misconfigurations, and business logic flaws from the perspective of an external attacker and of authenticated users at varying privilege levels
- **Deliverable:** Findings report with risk ratings, evidence, and remediation guidance

## 2. Rules of Engagement

- Written authorization obtained prior to testing (signed scope/permission-to-test document)
- Defined testing window and target IP/domain scope
- Emergency contact and stop-testing procedure agreed upon
- No destructive testing (e.g., DoS) unless explicitly in scope

## 3. Testing Phases

### Phase 1 — Reconnaissance (Unauthenticated)
- Passive OSINT (WHOIS, DNS, certificate transparency, public code/document leaks)
- Active recon (subdomain enumeration, port/service scanning, technology fingerprinting)
- Content discovery (directory/file brute forcing, robots.txt, sitemap review)

### Phase 2 — Unauthenticated Vulnerability Assessment
- Automated scanning (web app scanners, TLS/SSL configuration checks)
- Manual review of publicly accessible pages and forms
- Common vulnerability checks: injection points, exposed admin panels, default credentials, security headers, exposed error messages/stack traces

### Phase 3 — Authenticated Testing (Tiered Access)
Testing repeated across each provided access level to evaluate privilege boundaries and access control enforcement (see [Section 4](#4-login-access-levels)).

### Phase 4 — AI / LLM Security Testing
For applications that make material use of generative AI/LLMs (chatbots, AI agents, AI-generated or AI-scored content, RAG pipelines, etc.):
- Prompt injection (direct — via user-supplied chat/input fields — and indirect — via documents/data the model ingests)
- System prompt, persona, and configuration extraction
- Jailbreak / safety-guardrail bypass
- Insecure output handling (unsanitized AI output rendered as HTML/executed, used in downstream queries, etc.)
- Excessive agency (AI persona/agent taking actions or calling tools beyond its intended scope)
- Training/grounding data and cross-tenant leakage via model responses
- Automated-scoring/business-logic manipulation where an LLM judges or grades user input

### Phase 5 — Business Logic & Privilege Escalation
- Horizontal privilege escalation (accessing another user's data at the same tier)
- Vertical privilege escalation (lower tier attempting to reach higher-tier functionality)
- Workflow abuse (e.g., price manipulation, step-skipping, race conditions)

### Phase 6 — Reporting
- Executive summary (business risk, non-technical)
- Technical findings with CVSS/risk rating, evidence (screenshots/requests), and reproduction steps
- Remediation recommendations, prioritized by risk
- Optional retest of fixed findings

## 4. Login Access Levels

Testing is performed iteratively using accounts provisioned at each of the following tiers, where applicable to the target application:

| Level | Description | Typical Focus Areas |
|-------|-------------|----------------------|
| **No Access (Blackbox/Anonymous)** | No credentials provided; simulates an external, unauthenticated attacker | Public attack surface, exposed endpoints, information disclosure |
| **Read-Only** | View-only account with no ability to create/modify/delete data | Data exposure, IDOR, access to records outside intended scope, hidden functionality via UI manipulation |
| **Standard User** | Typical end-user account with normal create/edit permissions on own data | Input validation, session management, CSRF, horizontal privilege escalation |
| **Elevated/Power User** | User with additional permissions beyond standard (e.g., team lead, manager) | Vertical privilege escalation from Standard, feature-level access control gaps |
| **Admin** | Full administrative access to the application | Privilege boundary validation, admin-only function exposure to lower tiers, configuration/security controls management |

> Note: Not all applications have every tier. Access levels provided by the client are mapped to the closest tier above and tested accordingly.

## 5. Common Vulnerability Categories Assessed

- Injection (SQL, NoSQL, command, LDAP)
- Broken authentication & session management
- Broken access control (IDOR, missing function-level access control)
- Security misconfiguration
- Cross-site scripting (XSS) & CSRF
- Sensitive data exposure / insecure transport
- Server-side request forgery (SSRF)
- File upload & path traversal
- API-specific issues (rate limiting, mass assignment, excessive data exposure)
- Business logic flaws
- AI/LLM-specific issues (OWASP Top 10 for LLM Applications), where the target makes material use of generative AI: prompt injection (direct/indirect), insecure output handling, training/grounding data poisoning or leakage, model denial of service, sensitive information disclosure via model responses, insecure plugin/tool design, excessive agency, overreliance on unvalidated AI output, and model/prompt theft

## 6. Client Responsibilities

- Provide scope confirmation and written authorization
- Provision test accounts for each required access level
- Provide staging/test environment credentials if production testing is not permitted
- Designate a technical point of contact for the duration of testing

## 7. Report Turnaround

- Draft report delivered within an agreed number of business days after testing concludes
- Findings review call offered to walk through results with the client
- Retest window available upon remediation

## 8. Evidence

- Evidence is kept per run, in the run's private evidence folder, with a subfolder per phase and, in phase 3, per account.
- Keep short excerpts of what was observed (a header line, a path, a masked secret), never a full secret. Describe a session identifier by its length and character set, never by its value.
- For every check, record why it was run and how the result was read, including why something was *not* flagged as a finding. The customer-facing report is a redacted view of the evidence: passwords, tokens, cookies and personal addresses are scrubbed from it.
