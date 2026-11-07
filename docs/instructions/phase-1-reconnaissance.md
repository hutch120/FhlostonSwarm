# Phase 1 — Reconnaissance (Unauthenticated)

> Parent checklist: [tasks.md](tasks.md) · Methodology reference: [README.md](README.md)

## Objective

Build a map of the target's public attack surface **without** authenticating or sending intrusive/exploitative payloads. Everything here should be safe to run against `app.stg.pwc.polynize.io` at any time during the agreed testing window.

## Scope & Guardrails

- Target: `https://app.stg.pwc.polynize.io` and any subdomain of `*.stg.pwc.polynize.io` (confirmed in scope by the client, including the `content.stg.pwc.polynize.io` asset host observed during initial intel) — plus any further subdomains/ASN ranges confirmed in-scope by the client
- No credential use in this phase — this is the anonymous/no-access perspective
- No destructive or high-volume scanning (respect rate limits; avoid DoS-like behavior)
- Stop and confirm with the human tester before pivoting to any newly discovered host/domain not explicitly in scope
- Save all downloaded/captured files (raw tool output, website files, screenshots, etc.) under [../2026/assessment1/evidence/](../2026/assessment1/evidence/) in the `phase-1-reconnaissance/` subfolder — see [../2026/assessment1/evidence/README.md](../2026/assessment1/evidence/README.md) for the folder structure and naming conventions

## Checklist

- [ ] Passive OSINT (WHOIS, DNS, certificate transparency)
- [ ] Active recon (subdomain enumeration, port/service scanning, technology fingerprinting)
- [ ] Content discovery (directory/file brute forcing, robots.txt, sitemap review)
- [ ] Static analysis of client-side HTML/JS for exposed endpoints, business logic, and hardcoded secrets
- [ ] Identify AI/LLM-related client-side surface (chat/scenario widgets, streaming/websocket endpoints, model or prompt references in JS) to hand off to [Phase 4](./phase-4-ai-llm-security-testing.md)

---

## Instructions for AI Agent

The AI can safely perform the following automatable, read-only/low-impact steps and should **save all raw tool output and downloaded files to the `phase-1-reconnaissance/` subfolder in [../2026/assessment1/evidence/](../2026/assessment1/evidence/)** (e.g. `phase-1-reconnaissance/whois/`, `phase-1-reconnaissance/dns/`, `phase-1-reconnaissance/subdomains/`, `phase-1-reconnaissance/nmap/`, `phase-1-reconnaissance/content-discovery/`, `phase-1-reconnaissance/client-side-review/`), plus record a short summary for each:

1. **Passive OSINT**
   - WHOIS lookup on the root domain (`polynize.io` and `app.stg.pwc.polynize.io` if registrable separately) — save raw output
   - DNS enumeration: A/AAAA/MX/TXT/NS/CNAME records — save raw output
   - Certificate transparency search (crt.sh or similar) to enumerate historical/related subdomains under `*.stg.pwc.polynize.io` (already confirmed in scope) and any other related hosts — save the raw result set
   - Search for public code leaks, exposed documents, or credentials referencing the domain (e.g., GitHub, paste sites) — passive search only, do not attempt to use anything found; save any relevant discovered documents/pages
2. **Active recon**
   - Subdomain enumeration (e.g., `subfinder`, `amass` passive mode, or crt.sh-derived list) — cross-check which subdomains resolve and are live; save the full list
   - Port/service scan of the confirmed live host(s) (e.g., `nmap -sV -Pn` against the staging host only, using a reasonable rate limit) — save the full scan output/report
   - Technology fingerprinting (e.g., `whatweb`, `wappalyzer` CLI, HTTP header inspection) to identify web server, framework, CDN/WAF presence, and any AI/LLM vendor infrastructure (e.g., API hosts for OpenAI/Azure OpenAI/Anthropic/etc. referenced by the frontend or in response headers) — save raw tool output
3. **Content discovery**
   - Fetch, save, and review `robots.txt` and `sitemap.xml` as files
   - Directory/file brute forcing with a standard wordlist (e.g., `ffuf`/`gobuster`) at a conservative thread count/rate against `app.stg.pwc.polynize.io` only — save the full results file
   - Download and save any interesting discovered paths/files (backup files, config files, admin/login paths, API docs, `.git`, `.env`, etc.) for manual follow-up — do not just note the path, retrieve and store the actual file/response where accessible
4. **Static client-side code review (informs Phase 2 and Phase 4)**
   - Download and save **all** served HTML/CSS/JS, including minified bundles, file structure, and exposed static assets as individual files in the evidence folder — this is the primary source material for manual review, not just a read-through
   - Search for: hardcoded API endpoint paths, authentication/authorization logic implemented client-side, `sessionStorage`/`localStorage` usage for tokens, captcha validation logic, role checks embedded in JS, and any AI/LLM-related client-side surface — e.g. references to the scenario/"Play"/"Battle" chat or benchmark-scoring endpoints, streaming (SSE/WebSocket) connections, model/provider names, or system-prompt fragments shipped to the client — flag these for deeper testing in [Phase 4](./phase-4-ai-llm-security-testing.md)

**Output for this phase:** all raw tool output and downloaded files saved under the `phase-1-reconnaissance/` subfolder in [../2026/assessment1/evidence/](../2026/assessment1/evidence/), a `reasoning.md` in that subfolder capturing why each test/tool was run and how results were interpreted (see [evidence/README.md](../2026/assessment1/evidence/README.md#capturing-ai-reasoning)), plus a recon summary (findings + references to the saved files) organized by sub-task, and a flagged list of items that need human judgment (e.g., anything resembling exposed secrets, unclear scope boundaries, or unexpected hosts).

## Instructions for Human Tester

- Confirm written authorization and testing window cover the dates/times recon will run
- Review the AI's discovered subdomains/hosts and confirm which are actually in-scope before any further testing proceeds against them — `*.stg.pwc.polynize.io` is confirmed in scope, so this is mainly about hosts falling outside that pattern
- Manually verify any high-signal findings flagged by the AI (e.g., possible exposed `.git`/`.env`, admin panels, unusual open ports)
- Sanity-check WAF/CDN presence — if a WAF is detected, note it so later phases account for potential blocking/rate-limiting
- Decide whether any newly discovered but out-of-scope assets should be reported to the client as informational-only findings
- Sign off on Phase 1 completion in [tasks.md](tasks.md) before moving to Phase 2
