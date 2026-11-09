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

`src/web` is the Vite + React + TypeScript SPA. Sign-in, sessions and the account page use the real API (`src/api`); the live swarm view still runs against a replayed, simulated event feed, and the dashboard rows, saved scans and intake are mock data until later phases. The event contract, reducer, roster and tier limits live in `src/shared`.

```
npm run dev -w src/api         # local API on :8787 (in-memory data, mail collected, no AWS)
npm run dev -w src/web         # http://localhost:5173 (proxies /api to :8787); /demo is the live swarm replay
npm run build -w src/web       # production build into src/web/dist
npm run preview -w src/web     # serve the build on http://localhost:4173
npx playwright install chromium   # one-off, for the end-to-end tests
npm run test:e2e -w src/web    # Playwright (starts the dev server and the local API)
```

The replay accepts `?speed=<n>` (e.g. `/demo?speed=8`) and `?autoplay=0`. Colours and the look live in `src/web/src/theme.ts`; the customer-facing scan depths (Scout, Sweep, Probe, Siege: each a group of agents) live in `src/shared/config/tiers.json` and the server-only cost limits in `src/shared/config/limits.json`. Every run, one-off or scheduled, uses a paid credit of its depth. Saved scans (target, depth, schedule, notification email) are in `src/shared/src/scans.ts`; the **Scans** screen lets you run one again without reconfiguring.

To sign in locally, run both servers, enter any address on `/login`, then read the code from the local mailbox: `http://localhost:8787/__dev/mail?to=<address>` (dev server only, never deployed).

## API

`src/api` is a Hono app (`createApp`) that runs on Lambda behind an API Gateway HTTP API, served at `/api/*` on the same CloudFront distribution as the site (so cookies are first-party). Phase 3 covers: `GET /api/health`, `POST /api/auth/request|verify|refresh|logout`, `GET /api/auth/session`, `GET /api/me` (account, role and credits per scan depth; all zero until the Phase 4 ledger) and `GET /api/staff/whoami`.

- **Data** is S3 only (`swarm-data-885922397779`), using conditional writes (`If-None-Match`/`If-Match`) in `src/api/src/storage`. Layout and keys follow [PLAN.md section 5](./docs/PLAN.md#where-data-lives-s3-only-decided).
- **Auth tuning** (OTP lifetime, attempt limit, rate limits, session lifetimes, staff domain, reserved addresses, disposable-domain list) is in `src/api/config/auth.json`.
- **Secrets**: the identity pepper and JWT key are SSM SecureStrings (`/swarm/auth/pepper`, `/swarm/auth/jwt-key`), never in git. Create them once with `swarm init-secrets` (it never overwrites; replacing the pepper would orphan every stored identity).
- **Integration tests** against the real bucket (only under `_test/<runId>/`, removed afterwards): `npm run test:integration` (uses the `swarm` profile; `npm test` skips them).
- **Test identities**: any address whose local part starts with `swarm-test-` (and the SES simulator) gets `"test": true` on every record it creates, so `swarm test-cleanup` finds it.
- SES is still in the sandbox, so sign-in mail reaches only verified addresses until production access is granted.

## Infrastructure

The AWS infrastructure is a single-environment CDK app in `src/infra` (stacks `SwarmData`, `SwarmDns`, `SwarmEdge`, `SwarmSes`, `SwarmApi`, `SwarmOps`), configured by `src/infra/config/swarm.json`. Use the CLI wrappers, which check you are signed in to the swarm account and use the `swarm` profile:

```
swarm init-secrets           # one-off: create the auth pepper + JWT key in SSM
swarm synth                  # build the web app, synthesise + cdk-nag checks
swarm diff                   # show pending changes
swarm deploy                 # build the web app and deploy all stacks (e.g. --require-approval never)
swarm test-cleanup           # list test data (_test/ objects, test:true records, swarm-test-* resources)
swarm test-cleanup --delete  # remove it
```

`swarm synth|diff|deploy` build `src/web` first, so the edge stack publishes the real app (`src/web/dist`); without a build it falls back to the Phase 1 placeholder.

The CloudFront certificate lives in `us-east-1` and was requested by hand (an org SCP blocks CloudFormation there); its ARN is in the config. See Phase 1 in [IMPLEMENTATION.md](./docs/IMPLEMENTATION.md).
