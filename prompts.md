Implement Phase n of [IMPLEMENTATION.md](./IMPLEMENTATION.md).

Before starting:
- Read the phase's Goal, Depends on, Tasks, Verification, Exit criteria and "Not in this phase" in IMPLEMENTATION.md, plus the matching sections of [PLAN.md](./PLAN.md). Follow the "Cross-cutting rules" (AWS account/profile/region, single environment, test-data markers, zero idle cost, config not code, no secrets in git).
- Confirm every phase it depends on is ticked in the Progress tracker. If not, stop and tell me.
- Where a task needs explicit approval (e.g. anything outside `ap-southeast-2`), ask me before doing it.

Do the work:
- Complete all the phase's tasks in order, running the AWS CLI with `--profile swarm` only (check `aws sts get-caller-identity --profile swarm` first; `swarm login` if expired).
- Run every Verification step for real and capture the evidence (command output, test results). Don't tick a step you haven't actually run.
- `npm run typecheck`, `npm test` and `npm run lint` must pass before you finish.
- We're not in production yet, so don't worry about backward compatibility, and don't go fixing unrelated issues.

When done, update IMPLEMENTATION.md:
- Mark each completed task and verification step with ✅ and add a short result note with the date, in the same style as Phase 0. Leave anything not done or not verifiable unticked and say why.
- Tick the phase in the Progress tracker only if all exit criteria are met.
- Add a "Notes" section under the phase with decisions, deviations from the plan, gotchas, resource names/ARNs and anything a later phase needs to know.
- Update [README.md](./README.md) and any other docs directly affected.

Then commit with a message such as `Phase n: <short summary>` and push directly to `main`. Finish with a brief summary of what was done and anything outstanding.
