# FhlostonSwarm

Cutting-edge LLM analysis, pointed at your application

## CLI

Requires Node 24+ and [AWS CLI v2](https://aws.amazon.com/cli/).

```
npm install
npm link        # one-time: puts `swarm` on your PATH
swarm login
```

`swarm login` configures an AWS CLI profile named `swarm` (account `885922397779`, region `ap-southeast-2`), signs in through the browser with your AWS console credentials (`aws login`, no IAM Identity Center needed), and verifies the identity. Use `--remote` on a machine without a browser. Afterwards use `--profile swarm` or `AWS_PROFILE=swarm`.

If the account later uses IAM Identity Center, run `swarm login --sso --start-url https://d-xxxxxxxxxx.awsapps.com/start` (start URL and role are saved to the profile; or set `SWARM_SSO_START_URL` / `SWARM_SSO_ROLE`).

## Development

See [PLAN.md](./docs/PLAN.md) for the product design, [IMPLEMENTATION.md](./docs/IMPLEMENTATION.md) for the phased build plan, and [PREREQUISITES.md](./docs/PREREQUISITES.md) for the manual account/domain/email setup (rebuild and disaster recovery). All of these live in [docs/](./docs).

The repo is an npm workspaces monorepo: `src/{web,api,agents,infra,shared,synthetic-target}` are the application (packages `@swarm/*`); `swarm.ts` + `utils/` are the ops CLI.

```
npm install           # installs all workspaces
npm run typecheck     # tsc --noEmit over the CLI and every workspace
npm test              # Vitest: node tests plus the web app's component tests (jsdom)
npm run lint          # ESLint + typescript-eslint
npm run format:check  # Prettier check (npm run format to fix)
```

## Web app

`src/web` is the Vite + React + TypeScript SPA. Sign-in, sessions, the account page, intake, saved targets and scans, credits, runs (start, live view, stop, report) and data deletion use the real API (`src/api`). A real run's page follows its event stream: S3 catch-up, then the AppSync Events live channel, with polling as the fallback; `/demo` still replays a simulated run. The event contract, reducer, roster, report data and tier limits live in `src/shared`; the terms of use and privacy notice shown in the intake flow are in `src/web/content/legal.ts`.

```
npm run dev -w src/api         # local API on :8787 (in-memory data, mail collected, no AWS)
npm run dev -w src/web         # http://localhost:5173 (proxies /api to :8787); /demo is the live swarm replay
npm run build -w src/web       # production build into src/web/dist
npm run preview -w src/web     # serve the build on http://localhost:4173
npx playwright install chromium   # one-off, for the end-to-end tests
npm run test:e2e -w src/web    # Playwright (starts the dev server and the local API)
```

The replay accepts `?speed=<n>` (e.g. `/demo?speed=8`) and `?autoplay=0`. Colours and the look live in `src/web/src/theme.ts`; the customer-facing scan depths (Scout, Sweep, Probe, Siege: each a group of agents) live in `src/shared/config/tiers.json` and the server-only cost limits in `src/shared/config/limits.json`. Every run, one-off or scheduled, uses a paid credit of its depth. Saved scans (target, depth, schedule, notification email) are in `src/shared/src/scans.ts`; the **Scans** screen lets you run one again, edit it or delete it without reconfiguring.

To sign in locally, run both servers, enter any address on `/login`, then read the code from the local mailbox: `http://localhost:8787/__dev/mail?to=<address>`. The dev server also exposes `/__dev/deletion-code?to=`, `/__dev/confirmation?to=`, `POST /__dev/grant` (`{ to, tier, count }`, adds credits) and `POST /__dev/seed-target` (`{ to }`, saves a target pointing at the synthetic target the dev server starts on :8090) so every flow can be driven locally. A started run executes the real agent behind the real scope proxy inside the dev server (no AWS): the explorer drives a local Chromium (Playwright's, from the same install the e2e tests use) with a scripted stand-in for the model (`createOfflineLlm`), so no Bedrock call is made. These exist only in the local dev server, never deployed.

## API

`src/api` is a Hono app (`createApp`) that runs on Lambda behind an API Gateway HTTP API, served at `/api/*` on the same CloudFront distribution as the site (so cookies are first-party). It covers:

- Auth: `GET /api/health`, `POST /api/auth/request|verify|refresh|logout`, `GET /api/auth/session`, `GET /api/me` (account, role, credits per scan depth, and whether the account is unmetered staff).
- Staff (`/api/staff/*`, only for sessions the server derives as staff, re-checked on every call; a customer gets 403, nobody 401): `GET whoami`; `GET runs` (closed runs from the anonymised index plus runs still going; filter by dates, depth, trigger, who paid, status, test data), `GET|DELETE runs/:id`, `POST runs/:id/stop|resend-email`; `GET costs` (average, median and 95th percentile per depth, spend by day, who paid, cost components, annualised cadence, cost per finding; `?pricing=<version>` costs every run again under a saved price table) and `POST costs/preview` (the same under an unsaved table); `GET|POST pricing` (versioned price tables); `GET accounts?email=` (credits, saved scans, runs), `POST accounts/:hash/credits` (a `comp` credit with a reason), `PATCH accounts/:hash/scans/:scanId/status` (pause), `DELETE accounts/:hash`; `GET|PUT controls`, `POST controls/kill-switch`, `GET audit`; `GET health`; `GET learning`, `POST learning/pointer|entry`. Every change is audit-logged under `admin/audit/`. The staff screens (`/staff`: Runs, Cost analysis with the pricing worksheet and price-table editor, Users and support, Controls, Health) are a separate JavaScript chunk, fetched only after the server has confirmed the role.
- Targets and scans (all need a session and the CSRF token): `GET|POST /api/targets`, `PUT|DELETE /api/targets/:id` (delete also removes the scans on it), `GET|POST /api/scans`, `GET|PUT|DELETE /api/scans/:id`, `PATCH /api/scans/:id/status`, `POST /api/scans/:id/notify/resend`. A saved password is never returned; an update keeps it unless a new one is sent.
- Runs: `POST /api/scans/:id/run` (spends one credit of the scan's depth, snapshots the target and scan into `runs/{runId}/input.json`, writes a `queued` `summary.json`; 402 `no_credit` otherwise), `GET /api/runs`, `GET|DELETE /api/runs/:id` (deleting a running run stops it first), `POST /api/runs/:id/start` (starts the execution; the run stays `queued`, with a "waiting for a free slot" `reason`, until its depth's concurrency pool has room) and `POST /api/runs/:id/stop` (a run still waiting is cancelled and its credit returned), `GET /api/runs/:id/events?after=<seq>` (S3 catch-up), `POST /api/runs/:id/stream-token` (short-lived token for the live channel), `GET /api/runs/:id/report` and `GET /api/runs/:id/report/link?format=html|pdf|json` (a 5-minute presigned download of `report.html`, `report.pdf` or `findings.json`; the PDF is rendered by a task after the run closes, so it is "not ready" for a minute or so).
- Agent tasks: `/api/internal/*` (`GET input`, `POST events|evidence`) is IAM-signed by the task role and also needs the per-run token; it is not reachable from a browser session. Evidence names: `proxy-log`, `proxy-stats`, `app-profile`, `usage`, `explorer-log`.
- Notification addresses: `POST /api/notify/confirm` (public, single-use link token). An address other than the account email gets no mail until confirmed.
- Account deletion: `POST /api/account/delete-code` emails a fresh code, then `DELETE /api/account` with `{ code }` removes everything under `users/{emailHash}/`.

- **Data** is S3 only (`swarm-data-885922397779`), using conditional writes (`If-None-Match`/`If-Match`) in `src/api/src/storage`. Layout and keys follow [PLAN.md section 5](./docs/PLAN.md#where-data-lives-s3-only-decided).
- **Credits**: `users/{emailHash}/entitlements.json` is a compare-and-swap ledger (granted per source, consumed per depth and per source: complimentary credits are used first, and a run records which kind paid for it, for the staff cost view). Grant `comp` credits with `swarm grant-credit <email> <scout|sweep|probe|siege> [count] --reason "<why>"` or from the staff dashboard (Users and support); each grant is audit-logged under `admin/audit/` (account hash, never the email). Staff accounts can start runs without a credit.
- **Staff controls** (`admin/settings/controls.json`, edited in the dashboard, read at the moment they apply, so no deploy): the kill switch (no run can start, and every running or waiting run is stopped; a run that had not started gets its credit back), runs at once per depth, the depth caps (pages, model calls, checks, requests, tokens, model spend) that the next run's task is given, the daily spend alarm (`admin/spend/<day>.json`; when the day's estimated cost passes it, a `spend_alarm` log line and a mail to the support address, once a day), scheduled-scan limits per account (most active repeating scans, shortest time between runs; checked when a scan is saved or resumed), and block lists of target hosts and email domains. Their defaults are `src/api/config/controls.json` and `src/shared/config/limits.json`. The price table is versioned under `admin/pricing/` (the shipped `pricing.json` applies until staff save one); a run keeps the prices it was costed with, and the anonymised run index keeps what each run used (`usage`) so the staff cost view can cost every run again under another version.
- **Auth tuning** (OTP lifetime, attempt limit, test-passcode lifetimes, rate limits, session lifetimes, staff domain, reserved addresses, disposable-domain list) is in `src/api/config/auth.json`. **Intake tuning** (per-account target and scan limits, notification-link lifetime and limits, and the blocked-host lists for private addresses, internal names, our own domains (staff may scan these) and public-sector suffixes) is in `src/api/config/intake.json`.
- **Secrets**: the identity pepper and JWT key are SSM SecureStrings (`/swarm/auth/pepper`, `/swarm/auth/jwt-key`), never in git. Create them once with `swarm init-secrets` (it never overwrites; replacing the pepper would orphan every stored identity).
- **Integration tests** against the real bucket (only under `_test/<runId>/`, removed afterwards): `npm run test:integration` (uses the `swarm` profile; `npm test` skips them).
- **Test passcode**: a signed-in user can generate a reusable sign-in code on the Account page (valid for an hour, day, week or month; one per account, stored hashed at `users/{emailHash}/test-passcode.json`). Enter it in the sign-in code box instead of the emailed code, so testers need no mailbox.
- **Test identities**: any address whose local part starts with `swarm-test-` (and the SES simulator) gets `"test": true` on every record it creates, so `swarm test-cleanup` finds it.
- SES is still in the sandbox, so mail (sign-in codes, deletion codes, notification confirmation links) reaches only verified addresses until production access is granted.

## Infrastructure

The AWS infrastructure is a single-environment CDK app in `src/infra` (stacks `SwarmData`, `SwarmDns`, `SwarmEdge`, `SwarmSes`, `SwarmApi`, `SwarmRuns`, `SwarmOps`), configured by `src/infra/config/swarm.json`. A run is a Step Functions execution (`swarm-run`) that first takes a slot in its depth's concurrency pool (waiting, queued, while the pool is full), then starts one Fargate task (1 vCPU, 2 GB: the agent with Chromium, plus a scope-proxy sidecar, image from `src/agents`) in a public-subnet-only network; nothing runs between scans (no NAT, endpoints or services). The agent task role may call the internal API and invoke the Bedrock models named in `limits.json` (`au.` inference profiles), nothing else. Scout and Sweep use the cheap model through the Converse API: the **explorer** (a model-driven browser, run as the `surface` crawl and the `authn` sign-in step) reads only what the browser shows, picks among link ids and paths of the target (never a host), and writes `app-profile.json` for the report; the other agents (`dns`, `surface`, `bundle`, `tls`, `zap`, `cors`, `authn`) are deterministic checks. **Probe and Siege** (Sonnet class) add a Phase 0 plan and the role-aware agents. After discovery (the explorer signs in with every supplied login, each from a signed-out browser, and maps each role's pages by code) the **planner** writes a schema-validated `engagement.json` (agents to run, checks skipped as "not applicable" with the reason, the role test matrix and hints) from the rules in `src/agents/src/planner.ts`, optionally refined by one model call; whatever it proposes is clamped by code, so no output can drop a guardrail, widen the scope or add an agent the depth does not include. Then `session` (identifier strength, renewal at sign-in, sign-out), `authz` (access matrix, vertical escalation, administrative exposure, method tampering), `prompt` and `output` (AI features reachable by a read-only query: injection, system-prompt disclosure, unescaped output, excessive agency) and, at Siege, `idor` (one user reading another's objects) run as that role, GET-only. The **verifier** then re-tests every finding on its own (a replay of the observation, or the whole check in a fresh context) and marks what does not reproduce _unconfirmed_. The prompts come from versioned modules (`src/agents/src/instructions/modules.ts`, the phases of `docs/instructions`), recorded as `instructionsVersion` on every run. The report (`src/shared/src/report.ts`, rendered by `src/api/src/report-html.ts`) has the sections of `docs/example-report.html` plus the scope limitations, goes through a redaction pass (passwords, tokens, cookies, personal addresses), and is delivered as HTML, JSON and a PDF that a `RenderPdf` step of the state machine renders with headless Chromium after the run closes (same image, entrypoint `pdf.mjs`; best effort). Caps (pages, model calls, tokens, spend, requests, time) come from `limits.json` and are enforced by the runtime. Run-infrastructure knobs (task size, reaper interval, pool polling and queue timeout, model retries) are in `src/shared/config/runtime.json`, and the staff-only price table in `src/shared/config/pricing.json`. **The learning loop** (PLAN §9): the instruction modules are only a baseline. A dynamic layer of knowledge items and dynamic agents (declarative specs built only from read-only primitives: a safe request with a response matcher, a header assertion, a search of the scripts the pages load) lives in the data bucket under `learning/` (immutable `versions/<n>.json`, a `current.json` pointer that is also the kill switch, `stats.json` counters, `log/`, a `lock.json`; test accounts use `learning/test/`). A run is pinned to the active version when its task asks for its input and records it as `dynamicVersion`; the planner reads the items that apply, Probe and Siege run the agents that apply (candidates only observe, in shadow; Scout and Sweep run none) and the report lists what was used with its source and date. After the PDF, a `Learn` step (Lambda, 150 s limit, no schedule) has the most capable invokable Claude model (`learnerModelId` in `src/shared/config/learning.json`, with a fallback) review the closed run through a generic digest (never a host, path, login or customer wording), the layer and the allow-listed sources (OWASP, CISA KEV), then `applyLearning` clamps whatever it proposes: any proposal containing text of the run is refused, severities are capped, caps and the lowest-score replacement rule hold, new entries start as candidates and are promoted only after `shadowRuns` clean runs and a passing synthetic-target regression (`swarm learning gate`). Its tokens and seconds are their own line in `cost.json`. All limits are in `learning.json`. To check the explorer against the real model and the synthetic target (a few cents): `SWARM_LIVE=1 AWS_PROFILE=swarm AWS_REGION=ap-southeast-2 npx vitest run --project node explorer.live`; to compare models on a Siege run (a few dollars): `SWARM_LIVE=1 SWARM_BENCH_MODELS=au.anthropic.claude-sonnet-4-6,au.anthropic.claude-sonnet-5 AWS_PROFILE=swarm AWS_REGION=ap-southeast-2 npx vitest run --project node benchmark.live`. Use the CLI wrappers, which check you are signed in to the swarm account and use the `swarm` profile:

```
swarm init-secrets           # one-off: create the auth pepper + JWT key in SSM
swarm synth                  # build the web app, synthesise + cdk-nag checks
swarm diff                   # show pending changes
swarm deploy                 # build the web app and agent images, deploy all stacks (e.g. --require-approval never; needs Docker running)
swarm test-cleanup           # list test data (_test/ objects, learning/test/, test:true records, swarm-test-* resources, running test tasks)
swarm test-cleanup --delete  # remove it
swarm synthetic-target start|stop|status   # the deliberately vulnerable test app, on demand as a Fargate task
swarm grant-credit <email> <depth> [count] --reason "<why>"   # comp credits for an account (audit-logged)
swarm learn --dry-run|--apply [--run <id>] [--force]   # propose changes to the dynamic layer from a closed run and/or the sources, and print the diff
swarm learning status|versions [--test]      # the active version, counts, gate, last passes, whether the learner model can be invoked
swarm learning rollback <n>|disable|enable [--test]   # pointer flip (versions are kept), and the kill switch; the staff dashboard (Controls) does the same for the live layer, and can pin or disable one entry
swarm learning gate --run <id>               # record the synthetic-target regression a candidate needs before promotion
```

`swarm synth|diff|deploy` build `src/web` first, so the edge stack publishes the real app (`src/web/dist`); without a build it falls back to the Phase 1 placeholder.

The CloudFront certificate lives in `us-east-1` and was requested by hand (an org SCP blocks CloudFormation there); its ARN is in the config. See Phase 1 in [IMPLEMENTATION.md](./docs/IMPLEMENTATION.md).
