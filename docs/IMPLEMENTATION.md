# Swarm — Implementation Plan

How we build the product described in [PLAN.md](./PLAN.md), in small phases that can each be **verified before the next begins**. Phase numbers here are the delivery order; the milestone ids from [PLAN.md §15](./PLAN.md#15-milestones) are shown for cross-reference.

## How to use this document

- Each phase has: **Goal**, **Depends on**, **Tasks**, **Verification** (concrete checks, commands or tests), **Exit criteria** and, where useful, **Not in this phase**.
- A phase is *done* only when every exit criterion is demonstrably true. Record the evidence (command output, test run, screenshot) in the PR/commit that closes the phase.
- Tick the tracker below as phases complete.
- Phases are ordered by dependency; where two can run in parallel it says so.

### Progress tracker

| # | Phase | Plan ref | Status |
|---|-------|----------|--------|
| 0 | Repo foundations | — | ✅ |
| 1 | Infrastructure foundation (DNS, hosting, data bucket, SES) | M0 | ☐ |
| 2 | UI shell on a simulated feed | M1 | ☐ *(built and verified 2026-11-08; awaiting your visual sign-off)* |
| 3 | Auth (email OTP, sessions, staff role) | M2 | ☐ *(built, deployed and verified 2026-11-08; awaiting one real-mailbox sign-in, see Phase 3 Notes)* |
| 4 | Intake, entitlements & data deletion | M3 | ☐ |
| 5 | Walking skeleton: one agent end to end | M4 | ☐ |
| 6 | Lite swarm (explorer, teaser report, free-tier controls) | M5a | ☐ |
| 7 | Full swarm (discovery, all agents, verifier, full report) | M5b | ☐ |
| 8 | Steering | M6 | ☐ |
| 9 | Staff dashboard & cost analysis | M7 | ☐ |
| 10 | Hardening & private beta | M8 | ☐ |
| 11 | Payments | M9 | ☐ |
| 12 | Scheduled runs | M10 | ☐ |

### Cross-cutting rules (apply to every phase)

- **AWS:** account `885922397779`, region `ap-southeast-2`, CLI profile `swarm` only. Before any AWS work run `aws sts get-caller-identity --profile swarm` (expect Account `885922397779`); if expired run `swarm login`. Never use other profiles. Anything outside the account/region needs explicit approval — see the CloudFront certificate note in Phase 1. Everything (domain, DNS, certificates, CloudFront, SES, ECR, Bedrock) is in this one account with no cross-account access; the `au.` Bedrock profiles span `ap-southeast-2`/`ap-southeast-4` inside the same account (see [PLAN.md §14](./PLAN.md#14-security-privacy--operations)).
- **Single environment:** one AWS account, treated as production. There are no `dev`/`prod` stages and no stage prefixes in resource names. If a dev/stage system is ever needed it will be a **separate AWS account**, never mixed into this one. Automated and integration tests use a dedicated `_test/` key prefix in the data bucket (expired by lifecycle rule and cleaned up after each run) and never touch real user data.
- **Test data and resources are always clearly identifiable** (for manual review and cleanup, since there is only one account):
  - **S3 keys:** all automated test data lives under `_test/<runId>/…`, where `runId` is `YYYYMMDD-HHmmss-<rand>`.
  - **Records:** any test record that has to exist outside that prefix (e.g. a manual E2E on the deployed site) carries `"test": true` plus `"testRunId"` in its JSON, so it can be found and removed.
  - **Identities:** unit/integration tests use synthetic emails/hashes with an injected fake mailer (no SES). Manual/deployed E2E uses dedicated test mailboxes we control (one on the staff domain, one non-staff) with a `swarm-test-` local-part (e.g. `swarm-test-e2e@…`) — not plus-tags, because email normalisation strips them. Records and claim markers created for these identities carry `"test": true` so cleanup can remove them (keeping the mailboxes reusable). Test targets, runs, and Stripe objects use a `swarm-test-` name prefix and Stripe metadata `test=true`; Stripe test-mode keys are used for all of it.
  - **AWS resources:** any resource created only for testing is named `swarm-test-*` and tagged `swarm:test=true` (plus `swarm:test-run=<runId>`); it is deleted when the test finishes. Permanent infra is tagged `swarm:test=false` or left untagged for this purpose, never `swarm-test-*`.
  - **Cleanup:** tests clean up after themselves; `swarm test-cleanup` (added in Phase 1 with the other ops helpers) lists, and with `--delete` removes, anything matching the above (`_test/` prefix, `test: true` records, `swarm-test-*` resources, `swarm:test=true` tags) and never touches anything else. Test data must never be mixed into real customer records without these markers.
- **Shared-environment drills:** because tests run in the live account, anything global (lowering caps, kill-switch, alarm tests, load/abuse drills) is done briefly, before external users exist or in an announced window, with the original config restored and verified afterwards. Caps and counters exercised by tests use test-prefixed state, so real users are never blocked by a test.
- **Code layout:** `src/web`, `src/api`, `src/agents`, `src/infra`, `src/shared`, `src/synthetic-target` as npm workspaces (see [PLAN.md §3](./PLAN.md#3-repository-layout)). `utils/` + `swarm.ts` stay the ops CLI.
- **Quality gates on every change:** `npm run typecheck` passes (root, covers all workspaces) and `npm test` passes. These are introduced in Phase 0 and may only get stricter.
- **Zero idle cost:** nothing introduced may violate the rules in [PLAN.md §14 "Idle cost"](./PLAN.md#idle-cost-at-rest) (no NAT, interface endpoints, provisioned capacity, always-on compute). Each infra phase re-checks this.
- **Config, not code:** tier limits, prices, model ids and caps live in config files validated by zod, never hard-coded.
- **No secrets in git.** Test credentials in fixtures are for the synthetic target only, and are named/marked as test data per the rule above.

### External lead-time items (start immediately, in parallel)

These have waiting time, so kick them off before the phases that need them:

| Item | Needed by | Action | Verification |
|------|-----------|--------|--------------|
| ✅ Bedrock account verification (done 2026-11-03; `converse` on Haiku 4.5 returned text) | Phase 5/6 | Wait (<2 h typical) or contact `aws-verification@amazon.com` if it persists | `aws bedrock-runtime converse --model-id au.anthropic.claude-haiku-4-5-20251001-v1:0 … --profile swarm` returns text, not `AccessDeniedException` |
| SES production access | Phase 3 (real users) | Request after the SES identity exists (Phase 1) | `aws sesv2 get-account --profile swarm` shows `ProductionAccessEnabled: true` *(requested 2026-11-08; status `PENDING`, then **`DENIED`** by 2026-11-08 evening, see Phase 3 Notes)* |
| ✅ Domain + DNS check for `fhlostonswarm.com` (done 2026-11-08: `ACTIVE`, auto-renew on, name servers match the Route 53 zone) | Phase 1 start | Re-verify before the edge stack deploys | `aws route53domains get-domain-detail --domain-name fhlostonswarm.com --region us-east-1 --profile swarm` succeeds; `nslookup -type=NS fhlostonswarm.com` returns the hosted zone's 4 name servers |
| ToS + privacy text | Phase 4 | Draft the intake acknowledgement, deletion, retained-hash and anonymised-cost wording | Text reviewed by you, stored in `src/web/content/` |

---

## Phase 0 — Repo foundations

**Goal:** a workspace layout, tooling and quality gates that every later phase builds on.

**Depends on:** nothing.

**Tasks**
1. ✅ Convert the root `package.json` to npm workspaces (`src/web`, `src/api`, `src/agents`, `src/infra`, `src/shared`, `src/synthetic-target`), each with its own `package.json` and `tsconfig.json` extending a shared base (keep the root `tsconfig.json` `include` covering `src/**/*.ts` so `npm run typecheck` still works).
2. ✅ Add test runner (Vitest), linting (ESLint + typescript-eslint) and formatting (Prettier) with `npm test`, `npm run lint`, `npm run format:check` scripts.
3. ✅ Add `src/shared` skeleton with zod and a first schema + test (placeholder `Result`/ids), proving cross-workspace imports.
4. ✅ Add an `.editorconfig`, update `.gitignore` (`cdk.out`, `dist`, `.env*`, `coverage`).
5. ✅ Update [README.md](../README.md) with the dev workflow (install, typecheck, test, lint) and link to PLAN.md/IMPLEMENTATION.md.

**Verification**
- ✅ `npm install` succeeds from a clean clone (delete `node_modules`, reinstall). *(Verified 2026-11-04: deleted `node_modules` and `package-lock.json`, reinstalled; all six `@swarm/*` workspaces link, `npm ls @swarm/shared` shows it deduped into each.)*
- ✅ `npm run typecheck`, `npm test`, `npm run lint` all exit 0. *(Verified 2026-11-04: also `npm run format:check`; `npm test` = 2 files / 4 tests passing.)*
- ✅ A deliberate type error in `src/shared` makes `npm run typecheck` fail from the root (then revert). *(Verified 2026-11-04: `export const bad: number = 'x'` → `TS2322`, exit 2; reverted, exit 0.)*
- ✅ `swarm --help` still works (the CLI is not broken). *(Verified 2026-11-04 via `node bin\swarm.js --help` and `tsx swarm.ts --help`.)*

**Exit criteria:** ✅ all four checks above pass; ✅ workspaces resolve each other (`@swarm/shared` imported from `src/api` in a test: `src/api/src/index.test.ts`).

**Notes (done 2026-11-04)**
- Layout: each workspace is `src/<name>/{package.json,tsconfig.json,src/index.ts}`; packages are named `@swarm/<name>`. `@swarm/shared` exports its TypeScript source directly (`exports` → `./src/index.ts`), so no build step is needed for cross-workspace imports under Vitest/`tsc`; revisit when `src/api`/`src/agents` are bundled (esbuild/CDK bundling resolves the same way).
- Shared TS settings live in `tsconfig.base.json`; the root `tsconfig.json` extends it and includes `swarm.ts`, `utils/`, `src/**/*.ts` and `vitest.config.ts`, so one `npm run typecheck` covers everything. Per-workspace `tsconfig.json` files exist for later tooling (Vite, CDK) but the root run is the gate.
- Tests: root `vitest.config.ts` runs `src/**/*.test.ts` and `utils/**/*.test.ts` (`npm test`, `npm run test:watch`). Use `.js` extensions in relative imports (NodeNext).
- Lint/format: flat `eslint.config.js` (typescript-eslint recommended + `eslint-config-prettier`); Prettier uses `printWidth: 100` and `endOfLine: auto` (git converts to CRLF on Windows). `PLAN.md`, `IMPLEMENTATION.md`, `instructions/` and `.github/` are in `.prettierignore` so prose docs aren't churned; `swarm.ts`/`utils/login.ts` were reformatted once.
- `zod` is a dependency of `@swarm/shared` only (not the root). Placeholder `Result`/`ok`/`err` and `run_`/`usr_` id schemas are throwaway scaffolding to be replaced by the real contracts in later phases.
- `web`, `agents`, `infra` and `synthetic-target` contain `export {};` placeholders; Vite/React, CDK and the agent runtime arrive in their own phases.
- npm warns that `esbuild`'s postinstall isn't covered by `allowScripts`; harmless so far (`npm install-scripts approve esbuild` if it ever becomes an error).

---

## Phase 1 — Infrastructure foundation (M0)

**Goal:** an empty-but-real deployed shell: the domain resolves over HTTPS to a placeholder page, the data bucket exists, SES can send from `fhlostonswarm.com`, and idle cost is known.

**Depends on:** Phase 0.

**Tasks**
1. ✅ CDK app in `src/infra` (single environment, no stage context); bootstrap the account/region (`cdk bootstrap` for `ap-southeast-2` using the `swarm` profile). *(Done 2026-11-08: app in `src/infra/src`, config in `src/infra/config/swarm.json` (zod-validated); `CDKToolkit` was already `CREATE_COMPLETE` v32 from the prerequisite setup, so no re-bootstrap was needed.)*
2. ✅ **Data stack:** S3 bucket `swarm-data-885922397779` (account ID suffix only for global name uniqueness) — SSE-S3, block public access, versioning **off**, TLS-only policy, lifecycle rules to abort incomplete multipart uploads and expire the `_test/` prefix, `removalPolicy: RETAIN`. *(Deployed 2026-11-08: `SwarmData`.)*
3. ✅ **DNS stack:** look up the existing Route 53 hosted zone for `fhlostonswarm.com` (`HostedZone.fromLookup`; it already exists in the swarm account, so don't create or delegate one). All other stacks add their records to it. It also holds the Google Workspace records (apex MX, SPF TXT, `google-site-verification` TXT, `google._domainkey` DKIM TXT), with the verification/DKIM values taken from CDK config once Workspace is set up on `fhlostonswarm.com`. *(Deployed 2026-11-08: `SwarmDns` looks up zone `Z07856792QBFWJ8CRVSA5` and asserts the ID. The Workspace records already exist by hand, so CDK management is an opt-in `googleWorkspace` config block, `null` for now; see Notes.)*
4. ✅ **Edge stack** *(done 2026-11-08: `SwarmEdge` deployed first on the default domain, then with the custom domain once the certificate was issued.)*: private S3 bucket for the SPA + CloudFront (OAC), custom domain (apex `fhlostonswarm.com` A/AAAA alias records in the hosted zone), HTTP→HTTPS, security headers policy (HSTS, CSP, etc.), placeholder `index.html`.
   - ⚠️ CloudFront certificates must live in **`us-east-1`**. That is outside the default region, so **get explicit approval before creating the ACM certificate (and bootstrapping `us-east-1`)**. Everything else stays in `ap-southeast-2`.
   - An org SCP denies CloudFormation/SSM in `us-east-1`, so CDK cannot bootstrap or deploy there. ACM `RequestCertificate` **is** allowed (verified). Create the certificate with `aws acm request-certificate --domain-name fhlostonswarm.com --validation-method DNS --profile swarm --region us-east-1`, add the validation CNAMEs to the Route 53 zone, and pass the issued ARN to the edge stack (deployed in `ap-southeast-2`; CloudFront is global) as config.
5. **SES stack:** domain identity `fhlostonswarm.com` with Easy DKIM and custom MAIL FROM (`bounce.fhlostonswarm.com`), a DMARC TXT record (`p=none` initially), configuration set with bounce/complaint SNS destinations; DKIM/MAIL FROM/DMARC records created in the hosted zone. *(Deployed 2026-11-08: `SwarmSes`.)*
6. ✅ **Ops:** log retention (30 days) on every log group; AWS Budgets alert (US$10/month idle); `cdk-nag` (or equivalent) in synth; `swarm` CLI gets `deploy` helpers if useful (e.g. `swarm deploy`) that enforce the profile/account check, plus `swarm test-cleanup` (see the test-data rule above). *(Done 2026-11-08: `SwarmOps` budget `swarm-monthly-idle` US$10 with 80% actual / 100% forecast email alerts; every log group is 30 days and a unit test enforces it; cdk-nag `AwsSolutionsChecks` runs on every synth; `swarm deploy|diff|synth|test-cleanup` added.)*
7. ✅ Request **SES production access** once the identity verifies. No manual DNS steps are needed (the domain and zone are both in the swarm account). *(Requested 2026-11-08 via `aws sesv2 put-account-details`; `Details.ReviewDetails.Status` = `PENDING`, `ProductionAccessEnabled` still `false` until AWS approves.)*

**Verification**
- ✅ `npx cdk synth` produces no cdk-nag errors; `npx cdk diff` shows only intended resources. *(Verified 2026-11-08: `swarm synth` → "Successfully synthesized", no errors; `swarm diff` listed only the planned resources per stack. Also covered by `src/infra/src/app.test.ts`.)*
- ✅ `npx cdk deploy` succeeds with the `swarm` profile. *(Verified 2026-11-08: `swarm deploy --require-approval never` deployed all 5 stacks, exit 0, 515 s.)*
- ✅ `nslookup -type=NS fhlostonswarm.com` returns the Route 53 hosted zone's name servers. *(Verified 2026-11-08: the 4 `awsdns` servers returned match `aws route53 get-hosted-zone` delegation set.)*
- ✅ `curl -sI https://fhlostonswarm.com` returns `200` with HSTS and CSP headers and a valid certificate. *(Verified 2026-11-08 after the certificate was issued and `SwarmEdge` redeployed: `HTTP/1.1 200 OK`, `Strict-Transport-Security: max-age=63072000; includeSubDomains`, the CSP, `X-Frame-Options: DENY`, `X-Content-Type-Options: nosniff`, `Referrer-Policy`, `Permissions-Policy`; curl accepted the certificate without `-k`; `http://` returns `301`; the body is the placeholder; AAAA records resolve to CloudFront.)*
- ✅ `aws ses get-identity-verification-attributes`/`aws sesv2 get-email-identity` shows the domain `VERIFIED`, DKIM `SUCCESS`, MAIL FROM `SUCCESS`. *(Verified 2026-11-08: `VerifiedForSendingStatus: true`, DKIM `SUCCESS`, MAIL FROM `SUCCESS` for `bounce.fhlostonswarm.com`, config set `swarm-default`.)*
- ✅ Send a test email from `login@fhlostonswarm.com` to a verified address (SES sandbox is fine) and confirm DKIM/SPF/DMARC pass in the received headers. *(Verified manually by the owner 2026-11-10 on a real sign-in code email ("Your Swarm sign-in code"): SPF PASS, DKIM PASS with domain fhlostonswarm.com, DMARC PASS.)*
- ✅ `aws s3api put-object` without TLS or `--acl public-read` is denied; bucket public access block is on. *(Verified 2026-11-08: plain-HTTP put → `AccessDenied … explicit deny in a resource-based policy`; `--acl public-read` → `AccessControlListNotSupported`; all four public-access-block flags `true`; SSE `AES256`; versioning never enabled; lifecycle rules `abort-incomplete-multipart` (1 day) and `_test/` expiry (1 day); a normal TLS put worked.)*
- ✅ **Idle-cost check:** `aws resourcegroupstaggingapi` / Cost Explorer after a day shows no NAT gateway, interface endpoints, KMS CMKs, Secrets Manager secrets or provisioned capacity; estimated idle cost ≈ US$1–5/month. *(Point-in-time audit done 2026-11-08: 0 NAT gateways, 0 VPC endpoints, 0 customer-managed KMS keys, 0 secrets, 0 DynamoDB tables, 0 ECS clusters; only log group has 30-day retention. The "after a day" Cost Explorer check done 2026-11-10: Nov 1–10 total US$17.60, all of it the one-off domain registration (US$16.00 Amazon Registrar + US$1.60 tax, 2026-11-07); every running service (Lambda, S3, CloudFront, API Gateway, SES, Route 53, CloudWatch, KMS, Secrets Manager, Bedrock) rounds to US$0.00.)*
- ✅ *(Extra)* `swarm test-cleanup` works. *(Verified 2026-11-08: dry run listed a control object under `_test/`; `--delete` removed it; re-run reported nothing to clean up.)*

**Exit criteria:** ✅ domain serves the placeholder over HTTPS; ✅ SES identity verified with DKIM passing; ✅ data bucket exists with the required settings; ☐ idle-cost audit is clean *(point-in-time clean; the after-a-day check is pending, so the phase is not ticked yet)*; ✅ SES production access requested.

**Notes (2026-11-08)**
- **Outstanding to close the phase:**
  1. Re-check idle cost after a day (Cost Explorer / tagging API) and then tick the phase.
  2. Send a test mail from `login@fhlostonswarm.com` to a real mailbox and check the DKIM/SPF/DMARC headers (the SES mailbox-simulator send was accepted, but headers can't be read from it).
  3. Confirm SES production access once AWS approves (`aws sesv2 get-account --profile swarm`). *(Update: the request was denied; see Phase 3 Notes.)*
- **CloudFront certificate:** requested 2026-11-08 in `us-east-1` (approved by the account owner): `arn:aws:acm:us-east-1:885922397779:certificate/74522cad-8ad3-4b2d-a2c3-dd9b67f218d1`, DNS validated through a CNAME `_2685cd7e54a5807f7e0d471d23da1148.fhlostonswarm.com` added to the zone by CLI (not CDK; keep it, ACM needs it for auto-renewal), status `ISSUED` after about 1 minute. The ARN is in `cloudfrontCertificateArn`; the temporary `AwsSolutions-CFR4` acknowledgement is gone and the apex A/AAAA aliases and TLS 1.2 policy are deployed.
- **Stacks** (all `ap-southeast-2`, account `885922397779`): `SwarmData`, `SwarmDns`, `SwarmEdge`, `SwarmSes`, `SwarmOps`. Tags `swarm:test=false` and `swarm:project=fhloston-swarm` are applied app-wide.
- **Resources:** data bucket `swarm-data-885922397779`; CloudFront distribution `d24tcj0iqbcf6a.cloudfront.net` (comment "Fhloston Swarm SPA"); SES identity `fhlostonswarm.com`, configuration set `swarm-default`, SNS topic `swarm-ses-feedback` (bounce, complaint, reject; Phase 3 adds the suppression-writing Lambda subscriber); budget `swarm-monthly-idle`.
- **Config, not code:** `src/infra/config/swarm.json` holds the account, region, domain, zone ID (asserted against the lookup), certificate ARN, alert email (`support@fhlostonswarm.com`, assumed to exist as the Workspace group; check that the first budget alert would reach it), budget amount, DMARC policy and the optional Google Workspace block. `cdk.context.json` caches the zone lookup and is committed.
- **Deviations:**
  - Google Workspace records are not created by CDK. They already exist by hand and a CloudFormation create would fail, so the `googleWorkspace` block (MX, apex SPF + verification TXT, DKIM TXT) is opt-in. To adopt it, delete the manual records first. The live SPF already includes `amazonses.com` (see PREREQUISITES.md).
  - Added a CAA record at the apex limiting issuance to Amazon. It keeps `SwarmDns` non-empty (CloudFormation rejects empty templates) and hardens the domain; widen it if another CA is ever needed.
  - SES production access was requested with the plain `support@` contact; the site URL in the request is not live yet.
- **cdk-nag v3** (`Validations.of(...).acknowledge`) needs every finding acknowledged individually. Acknowledgements are in the stacks with reasons: S3 access logs, no WAF/geo/CloudFront logging, SNS not KMS-encrypted (CMKs bill 24/7), and the CDK BucketDeployment handler's IAM/runtime.
- **Placeholder site:** `src/infra/assets/placeholder/` is deployed with `BucketDeployment` (a CDK-managed Lambda, zero idle cost) and invalidates CloudFront. Phase 2 should point the deployment source at the built `src/web` output. The CSP (`default-src 'none'; script-src 'self'; style-src 'self'…`) is strict, so Phase 2/3 must add the API/realtime origins to `connect-src` in `edge-stack.ts`.
- **CLI:** `swarm deploy|diff|synth [cdk args]` run the local `aws-cdk` with `--profile swarm` after an account check (`--all` is added unless stacks are named). `swarm test-cleanup [--delete]` finds `_test/` objects, JSON records with `"test": true` (reads small `.json` objects only to check the marker, prints no contents), `swarm-test-*` buckets and stacks, and lists other `swarm:test=true` resources for manual removal.
- **Gotchas:** the default `*.cloudfront.net` certificate ignores `minimumProtocolVersion` (hence the conditional setting). The SPA bucket uses `DESTROY` (no auto-delete Lambda), so empty it before deleting the stack. `aws-cdk-lib`, `cdk-nag`, `aws-cdk` and `tsx` live in `src/infra`'s `package.json`.

---

## Phase 2 — UI shell on a simulated feed (M1)

**Goal:** the product's look-and-feel and the live swarm view working against a **replayed** event stream, using the same schema the real backend will emit. Can run **in parallel with Phase 1**.

**Depends on:** Phase 0.

**Tasks**
1. ✅ `src/shared`: define and export the **event contract** — `RunEvent` (`dispatch | start | finish | verify | agent-done | complete | steer | gap`, `seq`, `ts`, `runId`, `agent`, payload), `Finding`, `AgentSpec`, `AreaSpec`, run `Summary`, tier config schema. Zod schemas + inferred types. *(Done 2026-11-08: `src/shared/src/events.ts` (contract) and `src/shared/src/tiers.ts` (public scope) and `src/shared/src/limits.ts` (server-only caps), configured in `src/shared/config/tiers.json` and `limits.json`.)*
2. ✅ Port the simulation's roster (5 areas, 12 agents, steps/outcomes) from the marketing site's behaviour into `src/shared/fixtures` as data; write a **reducer** `applyEvent(state, event)` (pure) that produces the UI state (agent status, area progress, findings, log, counters). *(Done 2026-11-08: roster in `fixtures/roster.ts`, the scripted 123-event run in `fixtures/script.ts`, reducer in `reducer.ts`. The marketing bundle itself wasn't available, so the roster and script are built from the plan's description; see Notes.)*
3. ✅ `src/web` (Vite + React + TS): routing, theme file (Swarm placeholder identity: dark, neon accents, glow), layout, API client stubs, TanStack Query + store. *(Done 2026-11-08: React 19, React Router 8, TanStack Query, Zustand; `theme.ts` is the single source for colours; `api/client.ts` is a stub `ApiClient` backed by `api/mock.ts`.)*
4. ✅ **Live swarm view:** canvas visualisation (agents swarming a target core, pulses on probes, colour per area), side panels (areas, findings with severity + verified badge, event log, checks counter, coverage meter), agent detail drawer with a (disabled) steering box, `prefers-reduced-motion` / low-power mode. *(Done 2026-11-08: Canvas 2D in `src/web/src/swarm/`, panels in `src/web/src/panels/`, motion modes Full / Low power / Reduced.)*
5. ✅ **Replay player:** a dev/demo mode that feeds the scripted event list through the same reducer with play/pause/speed; also usable as the public demo later. *(Done 2026-11-08: `/demo` (and any `/runs/:id`) with play, pause, restart, skip to end, 1x–16x speed and a scrubber; `?speed=N` and `?autoplay=0` URL options.)*
6. ✅ Static screens with mock data: Login, Dashboard, Intake form (4 login slots with descriptions, URL fields, tier info, staging-credentials notice, acknowledgement), Report viewer placeholder, Account/Delete, Schedules (disabled), Staff (gated placeholder). *(Done 2026-11-08.)*

**Verification**
- ✅ Unit tests for the reducer: replaying the full scripted event list yields the expected final state (counts, findings sorted by severity, `complete` set); out-of-order/duplicate `seq` events are ignored idempotently. *(Verified 2026-11-08: `src/shared/src/reducer.test.ts` (13 tests): 41 checks, 11 findings sorted worst first, 7 verified, 3 gaps, all agents done, `complete` summary equals the live summary; duplicates, older seq and other-run events leave the state untouched.)*
- ✅ Schema tests: every fixture event validates against the zod schema; invalid events are rejected. *(Verified 2026-11-08: `src/shared/src/events.test.ts`: all 123 fixture events parse; 12 malformed-event cases, bad findings/summaries and invalid tier configs are rejected.)*
- ✅ Component tests for key panels (Vitest + Testing Library). *(Verified 2026-11-08: `src/web/src/panels/panels.test.tsx`, `app.test.tsx`, plus player, layout and intake tests; `npm test` = 11 files / 111 tests passing.)*
- ✅ Playwright smoke test: start `npm run dev -w src/web`, open the replay, assert agents appear, findings accumulate, and the final "report assembled" state is reached. *(Verified 2026-11-08: `npm run test:e2e -w src/web`, 11 tests passing in about 8 s: 12 agents and 5 areas appear, findings grow from 1 to 11, banner "Report assembled", 41 checks, all agents done, no console errors; also covers the drawer, restart, reduced motion, the report link and each static screen.)*
- ✅ Manual visual review at desktop and mobile widths. *(Screenshots at 1440×900 and 390×844 reviewed by me: layout holds, panels stack on mobile. Owner review 2026-11-10: good for now; polish to be iterated later.)*
- ✅ Lighthouse accessibility score ≥ 90. *(Verified 2026-11-08 against the production build: 100 on `/demo` (idle and mid-run), `/dashboard`, `/new`, `/login`, report, `/account`, `/schedules`, `/staff`. The first run scored 97/98 (list semantics on the event log, heading order on the intake form); both fixed.)*
- ✅ Reduced-motion mode verified. *(Verified 2026-11-08: with the OS preference set (Playwright `reducedMotion: "reduce"`) the canvas reports `data-motion="reduced"`, draws one still frame per state change with no animation loop, and the CSS disables animations/transitions.)*
- ✅ `npm run build -w src/web` succeeds; bundle size noted. *(Verified 2026-11-08: `index.html` 0.6 kB, CSS 12.3 kB (3.4 kB gzip), JS 452 kB (139 kB gzip), no source maps.)*
- ✅ *(Extra)* The built site loads under the edge stack's CSP. *(Verified 2026-11-08: served `dist` with the exact `CONTENT_SECURITY_POLICY` from `edge-stack.ts`; the replay, canvas and styles ran with no console errors or CSP violations.)*

**Exit criteria:** ✅ replay runs end to end in the browser with no backend; ✅ all tests green (`npm run typecheck`, `npm test`, `npm run lint`, `npm run test:e2e -w src/web`); ☐ you have reviewed and accepted (or noted changes to) the visual direction *(pending your review, so the phase is not ticked yet)*.

**Not in this phase:** real auth, API calls, or AWS resources.

**Notes (2026-11-08)**
- **To close the phase:** run `npm run dev -w src/web` (or open `/demo`), review the look at desktop and mobile widths, and accept it or note changes. Everything else is done.
- **Run it:** `npm run dev -w src/web` serves on <http://localhost:5173> (`/demo` is the replay; `/dashboard`, `/new`, `/login`, `/account`, `/schedules`, `/staff` and `/runs/run_demo0001/report` are the mock screens). `npm run build -w src/web` writes `src/web/dist`. `npm run test:e2e -w src/web` runs Playwright (it starts the dev server itself; one-off `npx playwright install chromium`).
- **Event contract** (`src/shared/src/events.ts`): `RunEvent` is a zod discriminated union on `type`. `agent` is an open lowercase id so Phase 5+ can add `explorer`/`verifier` without a contract change; `complete` has `agent: null`, `steer` and `gap` may be agent-less. `finish` carries the outcome (`clear | info | finding | gap`), a `requests` count and, for findings, the whole `Finding`. It deliberately carries **no dollar cost**: the customer stream never exposes spend (see the revenue notes below), so the per-step cost telemetry for staff must travel on a separate channel added in Phase 5/9. A `finish` with outcome `gap` marks the step; the separate `gap` event records the scope limitation for the report. `verify` is raised by the agent that did the cross-check. Findings start `unverified` and become `open` when verified. `Summary.findings.bySeverity` must list every severity.
- **Reducer** (`reducer.ts`): `applyEvent` ignores any event at or below `lastSeq` and any event for another run. That is idempotent for replays and reconnects, but a late out-of-order event is dropped, so the real transport (Phase 5) must deliver an ordered stream (reload from S3, then resume). Gap steps count as steps done but not as completed checks. Findings stay sorted (severity, then id). State is created with `createRunState({ runId, tier, areas, agents })`; `summarise(state)` is what the backend's `complete` summary must equal, and `selectAreas(state)` gives per-area progress.
- **Fixtures:** `AGENTS`/`AREAS` (5 areas, 12 agents as in PLAN §1), `replayEvents` (123 events, 55 s, 41 checks, 974 requests, 11 findings: 1 critical, 2 high, 4 medium, 3 low, 1 info; 7 verified), demo target `portal.swarm-demo.test`, run id `run_demo0001`. The findings are made up for a made-up target. The marketing bundle wasn't available to me, so the roster/steps/outcomes follow the description in PLAN §1, not a literal port; adjust `fixtures/roster.ts` and `fixtures/script.ts` if you want it closer to the original.
- **Tier config (split public vs server-only):** `src/shared/config/tiers.json` (validated by `tiersConfigSchema`, exported from `@swarm/shared`) holds only what a customer may see: name, description, paid, logins, wall-clock minutes, teaser count, steering, areas. The cost controls from PLAN §11 (model id, page/step/request/token/spend caps, request rate, concurrency) are in `src/shared/config/limits.json`, validated by `tierLimitsSchema` and exported only from `@swarm/shared/server` (`tierLimits`, `limitsFor`), so they never reach the browser bundle. Model ids are the initial ones from PLAN §7. Prices stay TBD and are not in either file.
- **Revenue rework (2026-11-08, from [revenue.md](./revenue.md) section 2):** customers no longer see spend or caps anywhere. The "Spend budget" and "Request budget" meters are replaced by a **Coverage** meter (`selectCoverage`: mean agent progress, 0 to 100%); `Summary` gained `coverage` and lost `spendUsd`; the dashboard's Cost column became Coverage; the report header shows coverage instead of cost; the intake tier cards no longer quote a request or spend cap; the replay fixtures carry no dollar figures. `src/shared/src/limits.test.ts` is the contract test: no cost-like key (`spend`, `usd`, `cost`, `token`, `model`, `budget`...) may appear on any replay event, the summary, the run state or the public tier config, and nothing limit-related may be exported from the package root. Verified on the production build: `spendCapUsd`, `spendUsd`, `tokenCap`, `modelId` and model names do not appear in the JS bundle. Still to do in later phases: a staff-only cost channel and `cost.json` (Phase 5/9), and the "coverage limit reached for this tier" wording when a cap stops a run (Phase 6/7).
- **Web structure:** `src/web/src/{api,state,replay,swarm,panels,pages,components}`. One Zustand run store (`state/run.ts`) is the only thing the feed writes to (`apply(event)`); the replay is a `ReplayPlayer` (virtual clock, driven by `tick(dtMs)`, so tests are deterministic) behind `useReplay`. When the real event stream arrives it should call the same `apply`; the UI does not change. The canvas reads the store directly (not via React state) so the animation loop never re-renders React.
- **Motion:** default follows `prefers-reduced-motion`; a selector offers Full motion, Low power (15 fps, no glow, only major effects) and Reduced motion (a still frame, redrawn only when state changes). Every canvas fact is also available as text in the panels, and agents are selectable from buttons, so the canvas is not the only way in.
- **Mock/stub behaviour:** sign-in accepts any 6-digit code (staff = an `@fhlostonswarm.com` email, the real rule being server-side in Phase 3); intake validates (URL, one complete login on Lite, acknowledgement) and then opens the demo replay; nothing is sent, stored or persisted (credentials never leave the form). Lite uses one login (default `user1`, switchable); the other slots show "Available in Full". The Dashboard rows, credits and the report page are fixed sample data derived from the replay. Steering is present but disabled.
- **CSP and hosting (for Phase 3):** the site works under the strict edge CSP unchanged (no inline scripts or styles, system fonts, no external origins; React `style` props and CSS variables go through the CSSOM, which `style-src 'self'` allows). The Phase 1 placeholder is still what is deployed at <https://fhlostonswarm.com>: I did not repoint `BucketDeployment` at `src/web/dist`, since this phase has no AWS changes and the visual direction isn't accepted yet. To publish it, point the source in `edge-stack.ts` at the built `src/web/dist` (build first), and add the API/realtime origins to `connect-src` when those exist.
- **Tooling changes:** root `vitest.config.ts` now has two projects (`node` for `*.test.ts` outside `src/web`, and `web` under jsdom with a setup file that stubs the canvas); `tsconfig.base.json` gained the DOM libs and `jsx: react-jsx`, and root `tsconfig.json` includes `src/**/*.tsx`, so `npm run typecheck` still covers everything; ESLint adds browser globals and `eslint-plugin-react-hooks` for `src/web`; `.gitignore`/`.prettierignore` cover Playwright output. `docs/prompts.md` still fails `npm run format:check`; that predates this phase and was left alone.
- **Gotchas:** `@testing-library/user-event` must be imported as `{ userEvent }` under NodeNext. `react-router` v8 exports the DOM components from `react-router` itself. jsdom has no canvas, so component tests see a canvas with no context (the component then does nothing); drawing is covered by the layout/hit-test unit tests and the Playwright run. Bundle is 452 kB because zod, React Router and TanStack Query are all in the one chunk; split by route later if it matters.

---

## Phase 3 — Auth (M2)

**Goal:** a user can sign in with an emailed code; sessions work; staff role is derived; the free-claim primitive is proven atomic.

**Depends on:** Phase 1 (bucket, SES, hosting) and Phase 2 (login screen).

**Tasks**
1. ✅ `src/api` (Hono on Lambda behind API Gateway HTTP API, routed under `/api/*` on the CloudFront distribution): health endpoint, error/logging middleware, zod request validation. *(Done 2026-11-08: `createApp` in `src/api/src/app.ts`; Lambda entry `lambda.ts`; stack `SwarmApi` (HTTP API `swarm-api`, throttled, access logs); CloudFront routes `/api/*` to it uncached. Live: `https://fhlostonswarm.com/api/health` → `{"status":"ok"}`.)*
2. ✅ **S3 storage layer** (`src/api/storage`): typed get/put/list/delete with `If-None-Match`/`If-Match` conditional writes and retry-on-412 helpers; key builders for the layout in [PLAN.md §5](./PLAN.md#where-data-lives-s3-only-decided). *(Done 2026-11-08: `storage/store.ts` (S3 + `PrefixedStore`), `memory.ts` (same semantics, for tests/dev), `json.ts` (`getJson`, `createJson`, `updateJson` CAS loop with retry), `keys.ts`.)*
3. ✅ Email normalisation + `emailHash` (HMAC with a pepper in an SSM SecureString), disposable-domain blocklist. *(Done 2026-11-08: `identity.ts`; pepper `/swarm/auth/pepper`, created by the new `swarm init-secrets`; blocklist in `src/api/config/auth.json`.)*
4. ✅ **OTP:** `POST /api/auth/request` (uniform response, per-email/IP counters, SES send), `POST /api/auth/verify` (hashed code, 10 min expiry, 5 attempts, single use). Magic link variant. *(Done 2026-11-08: `otp.ts`, `ratelimit.ts`, `mailer.ts`; the mail carries the code and a link to `/auth/verify?token=…`, which the SPA confirms with a click.)*
5. ✅ **Sessions:** `jose` JWT in `HttpOnly; Secure; SameSite=Lax` cookie, rotating revocable refresh tokens in S3, logout (server-side revoke), CSRF protection on mutating routes, API Gateway throttling, optional Turnstile. *(Done 2026-11-08: `sessions.ts`; Turnstile is implemented server-side (`turnstile.ts`) but off (`turnstileSecretParameter: null`); the web widget is not wired.)*
6. ✅ `role: staff` when the verified email domain is exactly `fhlostonswarm.com` (and the local-part is not a reserved shared/role address); `requireStaff` middleware. *(Done 2026-11-08: `deriveRole`; `/api/staff/*` re-checks the server-side session on every call.)*
7. ✅ Free-claim primitive: `claims/free/{emailHash}.json` created with `If-None-Match: *`. *(Done 2026-11-08: `claimFreeReport` in `users.ts`; nothing calls it yet, Phase 4 does. `/api/me` reports `freeLiteReports` from the marker.)*
8. ✅ Wire the real Login screen and session handling in `src/web`; account page shows "1 free lite report". *(Done 2026-11-08: real login (code or magic link), session bootstrap from the cookies, protected routes, sign out, account page, staff page confirmed by the server; deployed with `swarm deploy`.)*

**Verification**
- ✅ Unit tests: normalisation (plus-tags, Gmail dots, case), hashing determinism, OTP expiry, attempt limits, single use, JWT validation/expiry. *(Verified 2026-11-08: `identity.test.ts`, `otp.test.ts`, `sessions.test.ts`, `app.test.ts`, `users.test.ts`, `feedback.test.ts`, `storage.test.ts`; `npm test` = 20 files / 235 tests passing, 6 integration tests skipped by default.)*
- ✅ Integration tests against S3 (`_test/` prefix): 50 concurrent `claim` calls → exactly one succeeds; concurrent OTP verify attempts never exceed the attempt limit; refresh-token rotation invalidates the old token. *(Verified 2026-11-08: `npm run test:integration` against `swarm-data-885922397779`, 6 tests passing in 4.2 s: 50 concurrent claims → 1 `claimed` + 49 `already-claimed`; 12 concurrent wrong codes → at most 5 attempts counted; 8 concurrent correct codes → 1 wins; rotation kills the old token; full sign-in/logout flow. `_test/` left empty.)*
- ✅ Manual end-to-end on the deployed site: request a code, receive the email, sign in, reload (session persists), sign out (cookie cleared **and** refresh token revoked — replaying it fails). *(Everything but "receive the email" done 2026-11-08 on <https://fhlostonswarm.com> with a `swarm-test-` identity: a real browser (Playwright) signed in through the login screen, the session survived a reload, sign out cleared the cookies and replaying the old refresh token and access cookie both returned 401. Evidence: 25/25 API checks and 15/15 browser checks. The code was recovered from the stored challenge because there was no readable mailbox and SES is in the sandbox. Real delivery then confirmed manually by the owner on 2026-11-10: login works end to end.)*
- ✅ Negative tests: unknown email gets an identical response/timing envelope; wrong code ×5 locks; expired code rejected; `@gmail.com` account cannot reach `/api/staff/*` (403); a `fhlostonswarm.com` personal mailbox can; `support@fhlostonswarm.com` (shared address) cannot. *(Verified 2026-11-08 on the deployed site: sent and disposable-blocked requests return the same status and body, 844/871/862 ms (padded to 800 ms minimum); 5 wrong codes → 401 ×5 then the right code → 401; code with `expiresAt` moved into the past → 401; gmail → 403; `swarm-test-…@fhlostonswarm.com` → 200; `support@` signs in as `customer` and gets 403. Also covered by unit tests.)*
- ✅ Security checks: cookie flags verified in browser dev tools; CSRF test without token fails; headers (CSP/HSTS) present on API responses. *(Verified 2026-11-08: Playwright `context.cookies()` shows `__Host-swarm_at` HttpOnly/Secure/SameSite=Lax/Path=/ and `__Secure-swarm_rt` HttpOnly/Secure/SameSite=Strict/Path=/api/auth, and `document.cookie` is empty; logout without the token or from another Origin → 403 and the session survives; `curl -i https://fhlostonswarm.com/api/health` shows HSTS, CSP, `X-Content-Type-Options`, `X-Frame-Options`, `Cache-Control: no-store`.)*
- ✅ SES: bounce/complaint simulator addresses (`bounce@simulator.amazonses.com`) produce a `suppression/{emailHash}.json` entry. *(Verified 2026-11-08: a request for `bounce@simulator.amazonses.com` created `suppression/<hash>.json` = `{"reason":"bounce",…,"test":true}` within 5 s via SES → SNS → feedback Lambda. Nonexistent `@fhlostonswarm.com` test mailboxes also bounced and were suppressed, which shows real SES delivery attempts. Complaints are covered by a unit test only.)*
- ✅ *(Extra)* Playwright e2e against the local API: `npm run test:e2e -w src/web` = 18 tests passing (sign in by code and by link, reload, sign out, wrong code, staff vs customer, support@, CSRF, protected routes, plus the Phase 2 replay tests).
- ✅ *(Extra)* `npm run typecheck`, `npm run lint` clean; `swarm synth` passes cdk-nag; `swarm deploy` succeeded for all 6 stacks.

**Exit criteria:** ✅ all tests pass; ☐ manual E2E recorded *(all but real email delivery, see above, so the phase is not ticked)*; ✅ SES production access granted **or** sandbox limited to verified testers, noted *(sandbox, see Notes: AWS has **denied** the production request)*.

**Not in this phase:** intake, runs, entitlements beyond the claim primitive, account deletion.

**Notes (2026-11-08)**
- **To close the phase:** (1) sign in once at <https://fhlostonswarm.com/login> with your own `@fhlostonswarm.com` mailbox (not `support@`) and check the mail arrives, the code works and `/staff` opens; (2) sort out SES production access (below).
- **SES production access was DENIED** (`aws sesv2 get-account`: `ProductionAccessEnabled: false`, `Details.ReviewDetails.Status: DENIED`; Phase 1 recorded it as `PENDING`). In the sandbox, mail only reaches verified identities. The domain identity is verified, so any `@fhlostonswarm.com` address works, but **no external customer can receive a code yet**, and the API logs `mail_failed` (`MessageRejected`) for them while still answering `{ok:true}`. A reply draft is in [ses-production-access-reply.md](./ses-production-access-reply.md). Phase 4+ can proceed with staff mailboxes, but a real private beta needs this resolved.
- **Resources:** stack `SwarmApi` (`ap-southeast-2`): HTTP API `swarm-api` (`https://24xb1tgwc3.execute-api.ap-southeast-2.amazonaws.com`, reached only via CloudFront in practice; stage `$default`, 20 req/s, burst 40), Lambdas `ApiFunction` and `FeedbackFunction` (Node 24, arm64, 512 MB, 15 s, esbuild ESM bundles ≈ 0.5 MB, 30-day log groups, plus a 30-day access-log group), SNS subscription from `swarm-ses-feedback` to `FeedbackFunction`. SSM SecureStrings `/swarm/auth/pepper` and `/swarm/auth/jwt-key` (AWS-managed key). `SwarmEdge` gained a CloudFront Function `SpaRouting`, an `/api/*` behaviour and an origin-request policy. The data bucket gained 1-day (`auth/otp/`) and 2-day (`auth/ratelimit/`) expiry rules. Everything is request-priced; the infra test still forbids NAT, VPC, KMS CMKs, Secrets Manager, DynamoDB and WAF.
- **Deviation: SPA fallback.** The edge stack's distribution-wide 403/404 → `/index.html` error pages would have turned API 403/404 responses into the SPA, so they were replaced by a CloudFront Function that rewrites extensionless paths to `/index.html`. Unknown `/api/*` paths now return a real JSON 404 (verified live). The BucketDeployment construct id is still `Placeholder` (renaming it would delete and recreate the deployment); it now publishes `src/web/dist` when it exists, and `swarm synth|diff|deploy` build the web app first.
- **Gotcha (found only on the deployed site):** CloudFront does not forward unlisted headers, so `X-CSRF-Token` was stripped and every logout got `bad_csrf`, while local tests passed. The origin-request policy now allow-lists `Origin`, `CloudFront-Viewer-Address` and `X-CSRF-Token`. Any new custom request header the API needs must be added there (`edge-stack.ts`), and `infra/app.test.ts` asserts the list.
- **Sessions:** the access JWT (15 min) is only a pointer to the server-side session: every request loads `users/{emailHash}/sessions/{id}.json`, so logout and reuse detection take effect immediately and the role comes from the record, not the token (re-derived from the email on each refresh). Refresh tokens (30 days) rotate on use; presenting an already-rotated token revokes the session. `GET /api/auth/session` renews an expired access cookie from the refresh cookie. Cookie names: `__Host-swarm_at` (Path `/`) and `__Secure-swarm_rt` (Path `/api/auth`, SameSite=Strict). Lifetimes are in `src/api/config/auth.json` (the plan said ~12 h access; 15 min plus a refresh is stricter).
- **CSRF** has two layers: every mutating call must carry the site's `Origin` and `Content-Type: application/json`, and authenticated mutations also need `X-CSRF-Token` (HMAC of the session id, returned by `/auth/verify`, `/auth/refresh` and `/auth/session`, held in memory by the SPA). Magic links land on a page that signs in on a click, so mail scanners cannot burn the link.
- **Uniformity and limits:** `/auth/request` returns `{ok:true}` for sent, disposable-blocked, suppressed and per-email-limited addresses, padded to `minRequestMs` (800 ms); only the per-IP limit (20/hour) and malformed input differ (429/400). Verify is limited to 60/hour/IP. The client IP comes from `CloudFront-Viewer-Address`; because the execute-api URL is also reachable directly, a caller could spoof it and dodge the per-IP counter (per-email limits and API Gateway throttling still apply). Closing that (an origin secret header or a custom API domain) belongs in Phase 10.
- **Test data:** records for `swarm-test-*` mailboxes and the SES simulator carry `"test": true` (profile, session, OTP challenge, suppression, and the claim marker when the caller passes the marker), so `swarm test-cleanup` found and removed all 34 test records after the manual run; rate-limit counters aren't marked (expire in 2 days, I deleted them by hand). The bucket was empty afterwards. The manual scripts are not in the repo.
- **Other behaviours:** a rate-limit key too contended to update fails closed. A suppressed address (bounce/complaint) silently gets no mail. Disposable-domain list is a short starter list in config. The `+tag`/Gmail-dot collapsing affects the hash only; mail goes to the address as typed. `src/api/src/dev.ts` is a local API (in-memory, collected mailbox, relaxed limits) used by Playwright; never deployed.
- **Needed later:** Phase 4 should call `claimFreeReport(store, emailHash, now, testMarker)` and add run/entitlement routes under the same `requireAuth`/`requireCsrf` middleware pattern; the pepper is a root secret (see PREREQUISITES section 6a: back it up). Phase 9 can reuse `/api/staff/*` and `requireStaff`. The `users/{hash}/` prefix already holds `profile.json` and `sessions/`, so account deletion is one prefix delete.

---

## Phase 4 — Intake, entitlements & data deletion (M3)

**Goal:** a signed-in user can create a run request (not executed yet) with all inputs stored correctly, and can delete runs/account completely.

**Depends on:** Phase 3.

**Tasks**
1. `POST /api/runs` validates and stores `input.json` (app URL, optional marketing URL, 4 login slots + descriptions, scope notes, tier, ToS acknowledgement with timestamp/IP) and `summary.json` (`status: queued`), checking entitlement (free Lite claim, 1 per email) and the **free-target claim** (`claims/free-target/{domainHash}.json`, 30-day cool-off). Hostname parsing (registrable domain), blocklist for forbidden targets (private IPs, metadata, our own domains).
2. Entitlements ledger (`users/{emailHash}/entitlements.json`, compare-and-swap).
3. Tier config loader (zod-validated `tiers.json` scope plus server-only `limits.json` via `@swarm/shared/server`, with the initial Lite/Full values from [PLAN.md §11](./PLAN.md#11-entitlements-lite-tier--payments)); Lite only accepts one login.
4. `GET /api/runs`, `GET /api/runs/:id`, `DELETE /api/runs/:id`, `DELETE /api/account` (fresh-OTP re-confirmation; cancels in-flight runs once they exist; prefix delete under `users/{emailHash}/`; keeps hash-only claim marker + anonymised cost records).
5. Real Intake and Dashboard screens, ToS/privacy text (from the lead-time item), staging-credentials notice, delete confirmations.

**Verification**
- Unit tests: input validation (bad URLs, SSRF-ish hosts, >1 login on Lite, missing acknowledgement), tier config validation (invalid config fails to load).
- Integration tests (`_test/` prefix in S3): a second Lite run for the same email → rejected; a different email for the same target domain within 30 days → rejected; after the cool-off date is simulated → accepted.
- Deletion tests: create a user with several runs → `DELETE /api/account` leaves **no** objects under `users/{emailHash}/` and `auth/otp/{emailHash}.json`, but `claims/free/{emailHash}.json` remains and contains no email; re-registering the same email cannot claim another free run.
- Deleting a single run removes only that run's prefix; another user's data is untouched (cross-tenant test: user B requesting user A's run id gets 404).
- Playwright E2E: sign in → fill the intake → submit → see the run `queued` on the dashboard → delete it → gone.

**Exit criteria:** all tests green; deletion behaviour demonstrated by object listings; ToS/privacy text shown and acknowledged in the flow.

---

## Phase 5 — Walking skeleton: one agent end to end (M4)

**Goal:** the thinnest complete vertical slice — queued run → orchestrator → one containerised agent behind the scope proxy → live events in the real UI → minimal report → metered cost — plus the synthetic target we test against.

**Depends on:** Phases 1–4. Bedrock is **not** required here (the first agent is deterministic: headers/TLS/CORS checks).

**Tasks**
1. `src/synthetic-target`: a small deliberately-vulnerable web app (login page, 2–3 roles, a few known issues: missing headers, permissive CORS, verbose errors, exposed `/.git` stub, IDOR endpoint). Runs locally and as an **on-demand** Fargate task (named `swarm-test-synthetic-target`, tagged `swarm:test=true`, stopped after each use); includes known-good expected findings (`expected.json`).
2. **Event pipeline:** agent → `POST /api/internal/events` (IAM-signed) → S3 event chunks + `summary.json` update + AppSync Events publish. UI switches from replay to the live channel with S3 catch-up on reconnect (`seq` idempotency).
3. **Agent runtime** (`src/agents`): container image, task entrypoint, typed tool interface, event emitter, budget enforcement (steps/time/requests), `gap` on budget exhaustion. First agent: `headers-agent` (TLS, security headers, CORS) — no LLM.
4. **Scope proxy sidecar:** allow-list from `input.json`, blocks private/link-local/metadata/ECS-metadata addresses and non-GET (when `readOnly`), per-run rate limit, request log to evidence.
5. **Orchestration:** Step Functions state machine (create → run agent task (Fargate, public subnet, no inbound, task role scoped to the run prefix) → assemble minimal HTML report → notify via SES), `POST /api/runs/:id/start`, Stop endpoint, timeouts, the **reaper** Lambda (EventBridge schedule).
6. **Metering:** `cost.json` (task seconds × size; Bedrock fields present but empty), `admin/run-index` anonymised record, `pricing.json` skeleton.
7. Report assembler v0: `findings.json` → simple HTML.

**Verification**
- Unit tests for the proxy (table-driven: allowed host ✔, other host ✘, `169.254.169.254` ✘, `169.254.170.2` ✘, RFC1918 ✘, redirect to out-of-scope host ✘, POST when read-only ✘).
- Contract test: events emitted by the agent validate against the shared schema.
- Integration on the deployed stack: start the synthetic target on demand, submit a run against it, and confirm via the real UI that agents animate live, findings appear, the run completes, and `report.html` is downloadable via an authenticated presigned URL. Findings match `expected.json` for the checks the agent covers.
- Failure drills: stop a run mid-flight (tasks terminated, partial report); kill the agent task (state machine marks `failed`, no orphan tasks); simulate a stuck task (reaper stops it after max runtime).
- Cost: `cost.json` is written; ECS shows no running tasks after the run; the **idle-cost audit** from Phase 1 is repeated — still clean (no NAT, endpoints, etc.).
- Security: agent task role cannot read another run's prefix (attempt via `aws s3 cp` with the task role in a test).

**Exit criteria:** a full run completes against the synthetic target using only the deployed infra; failure drills pass; nothing left running afterwards.

---

## Phase 6 — Lite swarm (M5a)

**Goal:** the free tier delivers its promised demo: login + limited read-only exploration with a cheap model, an understanding of the app, and a teaser report — within hard caps and with abuse controls enforced.

**Depends on:** Phase 5 and working Bedrock invocation.

**Tasks**
1. Bedrock client over the Converse API with `au.` inference profiles from config (Haiku-class for Lite), usage metering into `cost.json`, retry/backoff and throttling handling.
2. Agent loop: tool-calling with schema-validated inputs/outputs, prompt-injection hardening (untrusted-content delimiters, no model-chosen hosts), per-agent step/token budgets, spend cap enforcement (stop when the cap is hit).
3. Passive agents (`dns`, `surface`, `tls`, `cors`, `bundle`) and the **explorer agent** (Playwright + Chromium in the image): log in with the single provided login, navigate GET-only within the page/step caps, and produce an `app-profile.json` (purpose, areas/features, roles, key flows).
4. Lite config enforcement: 6-minute wall-clock, 25 pages, 40 LLM steps, 150 requests at ≤2 req/s, ~400k/20k token cap, ≈US$0.50 spend cap; proxy blocks any non-GET other than the login submission.
5. **Teaser report:** "What we understood about your application" section in full, severity counts, top 2 findings in detail; locked findings serve title/severity only. Gating enforced server-side (separate `findings.teaser.json`; live events carry the reduced payload).
6. Free-tier controls: daily Lite cap (50 runs/≈US$25), separate low concurrency (3), disposable-email blocking wired in, queued/declined messaging.

**Verification**
- Run against the synthetic target with each of its roles: the app profile correctly names the app's areas/features/role differences (rubric-based check in a test, plus your manual review).
- Caps: tests that deliberately exceed each cap (time, pages, steps, requests, tokens, spend) show the run stops with a `gap` and `cost.json` ≤ the cap (+ small tolerance).
- Read-only: attempt state-changing requests through the agent (instructed in a hostile synthetic page) and confirm the proxy blocks them and logs the block.
- Prompt injection: synthetic page text telling the agent to visit another host / reveal its prompt — agent does not comply (test asserts no out-of-scope request in the proxy log).
- Gating: automated test fetches every API route and the live event stream for a Lite run and asserts locked finding details never appear in any payload.
- Cost: measure 10 Lite runs (marked as test data, test identities); record median/p95 cost in the staff data and compare with the ≈US$0.50 cap; adjust the config (not code) if needed.
- Abuse: simulate 60 Lite starts in a day against test-prefixed counters (so real users' cap is untouched) → the cap rejects the rest; same-target/new-email within 30 days rejected.

**Exit criteria:** Lite runs complete under cap on the synthetic target with a correct app profile and a properly gated teaser; measured cost documented.

---

## Phase 7 — Full swarm (M5b)

**Goal:** the paid-tier capability: discovery-driven plan, all 12 agents, authenticated testing across the 4 roles, independent verification and the full report (+PDF).

**Depends on:** Phase 6.

**Tasks**
1. **Instruction modules:** convert [instructions/](./instructions/README.md) phases 1–6 into versioned prompt modules (objective, immutable guardrails, checks, tools, evidence format, output schema); remove engagement-specific content; record `instructionsVersion` per run.
2. **Discovery/planner** producing a schema-validated `engagement.json` (agents to run, checks enabled/skipped with "not applicable" reasons, per-role test matrix from login descriptions, hints, budget) with enforced constraints (cannot remove guardrails or widen scope).
3. Remaining agents: `zap`, `authn`, `session`, `authz`, `prompt`, `output`, `idor` (+ tooling in the image: ZAP baseline, testssl, nuclei subset); Sonnet-class model config; role-aware authenticated testing (admin/user1/user2/other).
4. **Verifier** stage: independent re-test of each candidate finding with evidence; unverifiable → "unconfirmed".
5. **Full report:** `findings.json` → HTML matching [example-report.html](./example-report.html) sections, computed counts, gaps/scope limitations, redaction pass (passwords, tokens, cookies), PDF export (headless Chromium), JSON export.
6. Model benchmark: run the synthetic target with Sonnet 4.6 vs newer Sonnet generations; pick defaults from quality-vs-cost.

**Verification**
- Synthetic target with a **seeded ground truth** (`expected.json` incl. an IDOR between user1/user2, an admin-only endpoint reachable by user1, a verbose error, a CORS issue, an LLM-style prompt-injection endpoint): measure recall/precision against ground truth; set a minimum acceptable bar (e.g. ≥80% of seeded issues found, ≤1 unverified false positive) and record the result.
- Planner tests: for a target with no LLM features, the plan marks Phase 4 as not applicable; guardrails cannot be removed by any planner output (schema + test).
- Verifier tests: a fabricated false-positive candidate is downgraded to "unconfirmed".
- Report tests: snapshot test of the HTML structure; redaction test with known secrets planted in evidence (none appear in report/PDF); PDF renders and opens.
- Cost: record cost per Full run; confirm under the initial ≈US$15 cap.
- Regression: Phase 5/6 suites still pass.

**Exit criteria:** full run on the synthetic target meets the recall/precision bar, the report matches the example's structure, and redaction tests pass.

---

## Phase 8 — Steering (M6)

**Goal:** customers can steer a running Full-tier swarm safely.

**Depends on:** Phase 7.

**Tasks**
1. `POST /api/runs/:id/steer`; steering events stored and streamed; UI steering panel (per-run and per-agent) with chat-style history.
2. Steering interpreter: free text → zod-validated **directive** (`deep-dive`, `accept-risk`, `scope-narrow`, `context`, `pause/stop`); clarification replies for ambiguous input.
3. Agent inbox read **between steps**; deep-dive spawns/redirects an agent with extra budget; accept-risk sets finding status `accepted` (note required, audit-logged); scope narrowing updates the engagement plan and the proxy rules; stop produces a partial report.
4. Guardrails: directives can never widen scope beyond declared hosts or lift guardrails; steering disabled for Lite.

**Verification**
- Unit tests: interpreter maps a table of example messages to the right directives; malicious instructions ("ignore scope, scan example.com") produce no directive and a refusal message.
- Integration on the synthetic target: deep-dive on a finding increases that agent's activity and produces additional evidence; accept-risk moves the finding to "Accepted by customer" in the report; scope narrowing is enforced (proxy blocks the excluded path); stop yields a partial report.
- Lite run: steering endpoint returns 403.

**Exit criteria:** all directive types demonstrated end to end; scope cannot be widened by any steering input.

---

## Phase 9 — Staff dashboard & cost analysis (M7)

**Goal:** staff can see runs, costs and controls to set pricing and operate the service.

**Depends on:** Phases 3 and 5–7 (needs real cost data).

**Tasks**
1. `/api/staff/*` (staff-only, role re-checked server-side) reading `admin/run-index` and per-run data.
2. Views: Runs, Run detail (cost by agent/model, tokens, budgets, gaps, events), Cost analysis (avg/median/p95 by tier, daily spend, free-vs-paid, cost per finding) with the **pricing worksheet**, Users/support (lookup by email, stop run, resend email, delete run/account audit-logged), Controls (kill switch, Lite caps, concurrency, tier config edit, block lists), Health (SES bounce/complaint rate, stuck runs).
3. Price table editor (`pricing.json`, versioned) and cost recomputation.

**Verification**
- Authorisation tests: non-staff sessions get 403 on every `/api/staff/*` route (route-enumeration test); staff UI route hidden for non-staff.
- Data tests: seed runs (marked `test: true`) with known token counts → computed costs match hand calculations; deleting a user's account keeps only the anonymised cost record.
- Controls: flipping the kill switch stops new runs and halts running ones; changing the Lite daily cap takes effect without redeploy; edits are audit-logged.
- Manual review of the pricing worksheet against the cost data collected in Phases 6–7.

**Exit criteria:** staff dashboard accurate against known data; controls verified effective; price table ready for pricing decisions.

---

## Phase 10 — Hardening & private beta (M8)

**Goal:** safe enough to invite external testers.

**Depends on:** Phases 1–9.

**Tasks**
1. **Self-scan:** run Swarm (Full) against the deployed Swarm itself; fix findings.
2. Security review of IAM (least privilege per Lambda/task), S3 bucket policy, cookie/CSRF/headers, rate limits; dependency audit (`npm audit`); CloudTrail management events on.
3. Abuse drills: 100 temp-email signups, repeated target scans, oversized inputs, hostile target pages (prompt injection, redirects, huge responses, slow-loris) against the agents.
4. Operational: alarms (SES bounce/complaint, stuck runs, long Fargate tasks, spend), AWS Budgets, runbook (kill switch, deleting a user, restoring from a failed deploy), final deploy of the full stack.
5. Decide whether to enable target verification ([PLAN.md §6](./PLAN.md#6-scope-enforcement--abuse-prevention) item 7) and whether to add WAF, based on beta signals.
6. Invite 3–5 friendly testers; collect feedback and real Lite/Full cost data.

**Verification**
- Self-scan report reviewed; all High/Critical findings fixed and re-tested.
- Abuse drills: Lite daily cap, per-email/domain claims, throttling and the proxy hold (no cost overrun beyond configured caps; no out-of-scope requests).
- Production smoke test script (test identity; login, Lite run on the synthetic target, delete account, then `swarm test-cleanup` shows nothing left) passes.
- **Idle-cost audit after 7 days of no runs:** Cost Explorer daily cost ≈ the US$1–5/month estimate; no unexpected line items.
- Alarm tests: each alarm triggered once deliberately and received.

**Exit criteria:** self-scan clean of High/Critical, drills pass, idle cost confirmed, runbook written, first external testers onboarded.

---

## Phase 11 — Payments (M9)

**Goal:** customers can buy Full reports.

**Depends on:** Phase 10 and real cost data (Phase 9).

**Tasks**
1. Set prices from measured cost × margin (decide with the pricing worksheet).
2. Stripe Checkout (one-off per Full report) with AU GST via Stripe Tax; webhook Lambda (signature-verified, idempotent) → credit in `entitlements.json`; success/cancel pages; invoice portal link.
3. Entitlement consumption on run start; Lite "upgrade to Full" flow that unlocks the locked findings of an existing Lite run **or** starts a Full run (decide; default: starts a Full run).
4. Refund/failed-run policy (auto-credit if a run fails for platform reasons).
5. Stripe keys in SSM SecureString (standard tier); test and live modes separated by key name (e.g. `/swarm/stripe/test/*` vs `/swarm/stripe/live/*`).

**Verification**
- Stripe test mode end to end: pay with test card → webhook → credit → run starts → credit consumed; replayed webhook doesn't double-credit; failed payment grants nothing; refund path works.
- Webhook signature tests (invalid signature rejected).
- GST/invoice correctness checked on a test invoice.
- Failed platform run auto-credits exactly once.

**Exit criteria:** test-mode purchase → Full run works end to end; live-mode checklist reviewed before enabling.

---

## Phase 12 — Scheduled runs (M10)

**Goal:** paid recurring scans with change-only notifications.

**Depends on:** Phase 11.

**Tasks**
1. Schedule model on the target (`cron`, `notifyOn`, channels); EventBridge Scheduler → state machine with `trigger: scheduled`; credentials reuse and manage/remove UI.
2. Finding fingerprints and the diff engine (new/fixed/regressed/accepted).
3. SES notifications for **new, non-accepted** findings; webhook/Slack optional.
4. Metered billing per scheduled run; enable the disabled "Schedules" tab.

**Verification**
- Diff engine unit tests with fabricated run pairs (new, fixed, regressed, accepted, unchanged).
- Scheduled run on the synthetic target fires on time (short cron in test mode), produces a report, and notifies **only** when a finding is new; no email when nothing changed.
- Billing: each scheduled run consumes/charges exactly once; paused/cancelled schedules stop running.
- Idle cost: schedules add no always-on resources (only EventBridge Scheduler entries).

**Exit criteria:** a week of scheduled runs behaves correctly; billing verified in Stripe test mode.

---

## Appendix A — Verification toolbox

| Purpose | Tool/command |
|---------|--------------|
| Type check / unit tests / lint | `npm run typecheck`, `npm test`, `npm run lint` |
| Infra diff / synth | `npx cdk diff`, `npx cdk synth` (with `AWS_PROFILE=swarm`) |
| Confirm AWS identity | `aws sts get-caller-identity --profile swarm` |
| DNS | `nslookup -type=NS fhlostonswarm.com`, `curl -sI https://fhlostonswarm.com` |
| Bedrock access | `aws bedrock list-inference-profiles --region ap-southeast-2 --profile swarm`; a `converse` smoke call |
| S3 contents | `aws s3 ls s3://swarm-data-885922397779/ --recursive --profile swarm` |
| Running tasks (should be none when idle) | `aws ecs list-tasks --cluster swarm --profile swarm` |
| Idle cost | Cost Explorer (daily, group by service) via console or `aws ce get-cost-and-usage --profile swarm` |
| UI end-to-end | Playwright (`npm run e2e`) |
| Find / remove leftover test data | `swarm test-cleanup` (list), `swarm test-cleanup --delete` |

## Appendix B — Definition of done (per phase)

1. Every task implemented; no TODOs left that block the exit criteria.
2. All verification items executed with recorded evidence.
3. `npm run typecheck`, `npm test`, `npm run lint` green; previous phases' tests still green.
4. Infra changes deployed, `cdk diff` clean afterwards; idle-cost rules re-checked for any new infra phase.
5. [PLAN.md](./PLAN.md) updated if a decision changed; the tracker above ticked.
6. `swarm test-cleanup` (list mode) shows no leftover test data or `swarm-test-*` resources from the phase.
