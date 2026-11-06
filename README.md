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

See [PLAN.md](./PLAN.md) for the product design and [IMPLEMENTATION.md](./IMPLEMENTATION.md) for the phased build plan.

The repo is an npm workspaces monorepo: `src/{web,api,agents,infra,shared,synthetic-target}` are the application (packages `@swarm/*`); `swarm.ts` + `utils/` are the ops CLI.

```
npm install           # installs all workspaces
npm run typecheck     # tsc --noEmit over the CLI and every workspace
npm test              # Vitest (src/**/*.test.ts)
npm run lint          # ESLint + typescript-eslint
npm run format:check  # Prettier check (npm run format to fix)
```
