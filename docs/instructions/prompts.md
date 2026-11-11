# AI Agent Prompts

Copy/paste starting prompts for driving an engagement with an AI agent by hand. Automated scans do not need them: the platform builds each agent's prompt from the versioned instruction modules (`src/agents/src/instructions/modules.ts`). Name the engagement folder you are working in and the phase number, and check [tasks.md](tasks.md) for the shape of the checklist.

## Starting a phase

```
Let's do Phase 1 for this engagement.
```

```
Let's do Phase 2 for this engagement.
```

```
Let's do Phase 3 for this engagement.
```

```
Let's do Phase 4 for this engagement (AI/LLM security testing — prompt injection, jailbreaks, scoring manipulation).
```

```
Let's do Phase 5 for this engagement.
```

```
Let's do Phase 6 for this engagement and draft the report.
```

## Resuming / status

```
Where did we leave off? Review the checklist and the evidence folder, then summarize progress and suggest the next step.
```

```
Summarize the findings captured so far in the evidence folder and flag anything that looks like a confirmed vulnerability.
```

## Retest / follow-up assessment

```
Start a new assessment pass to retest prior findings. Set up the folder structure and re-run Phase 1 and Phase 2 against the current target.
```

## Human sign-off review

```
List everything from Phase 4 and Phase 5 that's flagged for human tester sign-off but not yet resolved.
```
