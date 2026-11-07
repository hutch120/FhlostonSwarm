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
npm test              # Vitest (src/**/*.test.ts)
npm run lint          # ESLint + typescript-eslint
npm run format:check  # Prettier check (npm run format to fix)
```

## Infrastructure

The AWS infrastructure is a single-environment CDK app in `src/infra` (stacks `SwarmData`, `SwarmDns`, `SwarmEdge`, `SwarmSes`, `SwarmOps`), configured by `src/infra/config/swarm.json`. Use the CLI wrappers, which check you are signed in to the swarm account and use the `swarm` profile:

```
swarm synth                  # synthesise + cdk-nag checks
swarm diff                   # show pending changes
swarm deploy                 # deploy all stacks (pass cdk options, e.g. --require-approval never)
swarm test-cleanup           # list test data (_test/ objects, test:true records, swarm-test-* resources)
swarm test-cleanup --delete  # remove it
```

The CloudFront certificate lives in `us-east-1` and was requested by hand (an org SCP blocks CloudFormation there); its ARN is in the config. See Phase 1 in [IMPLEMENTATION.md](./docs/IMPLEMENTATION.md).
