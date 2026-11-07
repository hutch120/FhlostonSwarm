# Fhloston Swarm – Copilot instructions

## AWS

- All AWS work in this repo targets the **swarm account**: account ID `885922397779`, region `ap-southeast-2`.
- Always use the AWS CLI profile `swarm` (e.g. `aws <command> --profile swarm`, or `AWS_PROFILE=swarm`). Never use the `default`, or any AWS profiles which belong to other accounts.
- Default the region to `ap-southeast-2` for CLI commands, SDK clients, and IaC.
- Before running AWS commands, confirm the account with `aws sts get-caller-identity --profile swarm` (expect Account `885922397779`). If credentials are missing or expired, run `swarm login` (it opens a browser for interactive sign-in; don't try to configure keys manually). If you can't complete the browser sign-in yourself, ask the user to run `swarm login` — they normally do this before starting a session.
- Don't create or modify resources outside this account/region without asking first.

## Project

- TypeScript CLI `swarm` (entry: `swarm.ts`, CLI helpers and commands in `utils/`; `src/` is reserved for the application itself). Run locally with `swarm <command>` (after `npm link`) or `npm run swarm -- <command>`.
- Type-check with `npm run typecheck`.
