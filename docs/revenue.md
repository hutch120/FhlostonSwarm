# Revenue & pricing plan

Status: **draft for discussion**. Nothing here is implemented. Complements [PLAN.md section 11](./PLAN.md#11-scan-depths-tiers-entitlements--payments) (scan depths, entitlements, "pricing TBD") and [section 12](./PLAN.md#12-staff-support-dashboard--cost-tracking) (cost tracking). The product is four scan depths (Scout, Sweep, Probe, Siege) that can be bought as one-off reports or run on a schedule.

## 1. The problem

1. **Cost must stay private.** Customers must not be able to see (or infer) what a run costs us, or what our per-run spend cap is. If they can, they anchor on our cost ("you spent $3 of LLM, why is it $1,500?") and we invite a race to the bottom.
2. **Price on value, not on cost.** A hand-built assessment sells for about A$5K. The automated report is not worth $5K, but it is not worth `LLM cost × margin` either. We want a price that reflects the outcome the customer gets, without undercutting the market.
3. **Costs still have to be covered:** LLM usage (Bedrock), AWS (Fargate, egress, S3, etc.), Stripe fees, GST, support, and the time to build and maintain the system.

The two halves are separate jobs:

| Job                                             | Where it lives                           | Who sees it |
| ----------------------------------------------- | ---------------------------------------- | ----------- |
| **Cost control** (caps, budgets, kill switches) | Server-side, in dollars                  | Staff only  |
| **Pricing** (what the customer pays)            | Product packaging, in scope and outcomes | Customers   |

Cost is a **floor** that tells us the minimum viable price. It is never the price.

## 2. Stop exposing cost to customers

Audit of where cost data currently reaches a customer (the frontend is a demo, so these are expected, but they must go before a paid launch):

| Surface                                                                     | What leaks                                                                                                                               | Change                                                                                                                                                                    |
| --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Counters.tsx](../src/web/src/panels/Counters.tsx)                          | "Spend budget: $X of $Y" bar shows our spend and cap                                                                                     | Replace with a **Coverage / Depth** meter (percent only, no dollars)                                                                                                      |
| [Dashboard.tsx](../src/web/src/pages/Dashboard.tsx)                         | "Cost" column per run                                                                                                                    | Remove; show duration, checks, findings instead                                                                                                                           |
| [Report.tsx](../src/web/src/pages/Report.tsx)                               | Run summary line includes `formatUsd(spendUsd)`                                                                                          | Remove; show duration and coverage                                                                                                                                        |
| [events.ts](../src/shared/src/events.ts)                                    | `spendUsd` is on the event stream and `costFields` on every finished step, so it is visible in browser dev tools even if the UI hides it | Strip cost fields from customer-facing events; keep them on a separate staff/internal channel and in `cost.json`                                                          |
| [tiers.ts](../src/shared/src/tiers.ts) / `config/tiers.json`                | `spendCapUsd`, `tokenCap`, `llmStepCap`, `modelId` are in the shared package, so they ship in the browser bundle                         | Split into a **public tier descriptor** (name, depth, description, logins, agents, steering) and a **server-only limits** config; the web app imports only the public one |
| Mock/fixtures ([mock.ts](../src/web/src/api/mock.ts), `fixtures/script.ts`) | Realistic cost figures in demo data                                                                                                      | Remove or make obviously fictional                                                                                                                                        |
| Staff dashboard                                                             | Full cost detail (intended)                                                                                                              | Keep, but enforce `role: staff` server-side on every call (already planned)                                                                                               |

Rules going forward:

- **Customer API responses never contain dollar costs, token counts, model names or spend caps.** Add a contract test that fails if a customer-scoped payload or event schema includes any `spend*`, `*Usd`, `token*` or `modelId` field.
- When a cap is hit, say "coverage limit reached for this tier" and offer an upgrade or rescan, never "spend limit reached".
- Percent-only progress (`coverage: 0..1`) is fine. Percent of an unknown cap does not reveal the cap.
- The privacy notice can keep saying anonymised cost figures are retained for analysis (that is a data-retention statement, not a price disclosure).

### What the swarm meter shows instead

Customers still need to feel the swarm is working and be told when it is wrapping up. Replace the budget meter with measures that tell the value story:

- **Coverage:** areas and flows explored vs. planned (from the existing per-area progress).
- **Checks run** (already shown) and **requests sent**.
- **Roles tested:** logins exercised, which supports the access-control story.
- **Depth:** a derived, cost-independent score (for example checks completed ÷ checks planned for this scope).

## 3. Pricing principles

1. **Value-based, fixed-price per scope.** Customers buy "an assessment of this application with N roles", not tokens or minutes. No usage-based pricing for the core product, so the LLM bill is our risk and our margin, not their line item.
2. **Anchor on the consultant, not on the scanner.** Three reference points:
   - Cheap DAST/scanner subscriptions: tens to low hundreds per month. This is a commodity race we avoid.
   - Hand-built pen test: about A$5K and up, with weeks of lead time.
   - Us: an evidence-backed, role-aware, application-specific report in about an hour, priced at a meaningful fraction of the consultant, not at scanner prices. Starting hypothesis is **A$1,000 to A$2,000 per assessment** (to be validated, see section 7).
3. **Sell the outcome and the evidence.** Verified findings with reproduction evidence, "what we understood about your application", role-based access findings, a prioritised remediation list, and an executive summary. That is what buyers pay for.
4. **Never discount ad hoc.** Every run is paid, so the cheapest depth (Scout) is the entry point. Discounts are structural (retest, annual commit, multi-app, prepaid schedules) and never ad hoc or public.
5. **Keep an honest positioning gap:** the report is not a certified pen test. Offer an optional human-reviewed upgrade (section 4) rather than discounting the premium away.

## 4. Product ladder (packaging ideas)

| Offer                                        | Buyer need                                             | Pricing basis                                                          | Notes                                                                                                                                                                                                                             |
| -------------------------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Scan depths (Scout, Sweep, Probe, Siege)** | A report at the depth I need, one-off or on a schedule | Fixed price **per run**, rising with depth (see below)                 | The core product. A depth is a group of agents, so the price is tied to scope (agents, logins, roles), never to tokens or minutes. The customer mixes depths, for example Scout daily, Sweep weekly, Siege monthly                |
| **Retest / verification**                    | Prove my fixes worked                                  | Fixed, well below the original depth                                   | We already know the app, so cost is low and perceived value is high. Re-running a saved scan is the mechanism                                                                                                                     |
| **Continuous monitoring**                    | Know when something regresses                          | Per scheduled run, or prepaid bundles of runs at a structural discount | Recurring revenue; any depth can repeat daily, weekly, monthly or yearly, and each scan has its own notification email; diff engine alerts on new findings only ([section 13](./PLAN.md#13-saved-scans-schedules--notifications)) |
| **Human-reviewed report**                    | Evidence for a client, auditor or board                | Siege + fixed review fee                                               | A consultant checks and signs off the automated output. Protects the premium and reaches the $5K segment                                                                                                                          |
| **Multi-app / agency pack**                  | Many apps, repeat use                                  | Volume bands, annual prepay                                            | Discount via commitment, not via lower list price                                                                                                                                                                                 |

**Starting price hypotheses per run (illustrative, to be validated; set from measured p95 cost in the staff pricing worksheet):**

| Depth     | Starting hypothesis (A$ per run) | Reasoning                                                                                                                  |
| --------- | -------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| **Scout** | tens                             | Cheapest depth, passive checks only. The one place we sit near scanner pricing, as the entry point and the monitoring hook |
| **Sweep** | low hundreds                     | Adds a login and a sign-in review; the weekly regression check                                                             |
| **Probe** | hundreds to the low thousands    | Authenticated, two roles, access control and LLM checks                                                                    |
| **Siege** | **A$1,000 to A$2,000**           | The full assessment, anchored on the consultant ([section 3](#3-pricing-principles))                                       |

Rules for the ladder: price must rise with depth and so must our cost (the contract test and config schema enforce rising spend caps); every price is checked against the **annual** cost of its likely cadence (a daily Scout is 365 runs a year, a weekly Sweep 52, a monthly Siege 12) so frequent cheap scans stay profitable; and a scheduled run that cannot be paid for is skipped, not run on credit.

Scope drivers for pricing (things the customer chooses and understands, not our costs): depth, number of roles/logins, application size band, whether AI/LLM features are in scope, retest included or not, how often the scan repeats.

## 5. Covering our costs (the floor)

Internal only. Price must clear this with a healthy margin.

**Variable cost per run** (from `cost.json`, [section 12](./PLAN.md#12-staff-support-dashboard--cost-tracking)):

- Bedrock tokens (dominant), Fargate compute, egress, S3/AppSync/SES/Step Functions.
- Stripe fees (percentage plus fixed fee per charge) and GST handling.
- Per-run cost, summed over the cadence the customer chose.

**Fixed and ongoing cost:**

- AWS idle baseline (Route 53, logs, etc.), domains, tooling.
- Build time (amortised) and maintenance/support time at an internal day rate.
- Security and compliance overhead (insurance, legal terms for authorised testing).

**Floor formula (to tune with real data):**

```
floor_price = (p95_run_cost × (1 + overrun_buffer) + payment_fees + support_allowance
               + comp_credit_share) / (1 − target_gross_margin)
```

- Use **p95** run cost, not average, so bad runs do not erase the margin.
- Initial target gross margin: **80% or more**. Software margins should be high; the spend caps in the tier limits (about US$1, 3, 8 and 15 from Scout to Siege) are runaway guards, not expected costs.
- **Break-even check:** `fixed_monthly_cost ÷ (price − variable_cost)` = paid runs per month needed to cover running costs. Separately estimate runs per month needed to repay build time.
- **Recurring cadence check:** for each depth, `annual_runs × p95_run_cost` at its likely cadence (365 daily, 52 weekly, 12 monthly, 1 yearly) must stay well under the revenue those runs bring in. Frequent cheap scans are where a low price and a high p95 hurt most.
- Worked example, with **illustrative placeholder numbers to be replaced with measured data**: if a Siege run costs about US$5 at p95 and the price is A$1,500, variable margin is over 99%, so the price is determined by value and market, and the cost floor is nowhere near binding. A daily Scout at US$0.30 p95 and A$30 a run still clears 98%, but the same scan at a careless A$1 a run would not cover support. The real constraints are support time and build time, which is why those belong in the floor calculation.

## 6. Protecting margin without showing the numbers

- **Scope contract instead of usage meter.** The customer picks scope (depth, roles, size band). Our caps are sized so a typical run for that scope sits comfortably under the cap; the cap is invisible to them.
- **Overruns are our cost.** If a run hits its cap, we deliver what was covered, mark gaps honestly ("not covered in this run"), and offer a top-up or rescan at a fixed price. We do not bill per token.
- **Large or unusual targets are quote-based** ("Contact us for an enterprise scope"), rather than auto-priced from cost.
- **Fair-use and terms** cover abuse of retests and rescans (for example a retest window of 30 days) and of schedules (a per-account limit on active recurring scans and a minimum spacing between runs of one target).
- **Credit-gated runs.** Every run needs a paid or staff-granted credit; throwaway accounts get nothing to spam. Staff-granted credits are audit-logged and visible on the staff dashboard.
- **Price table and tier limits are versioned** (already planned for cost); do the same for list prices so old customers keep what they bought.

## 7. Validating price (no guessing)

1. Run real assessments at each depth on the demo target and 3 to 5 friendly apps to measure `cost.json` (cost per run, p95), and record the annualised cost of each cadence.
2. Interview 5 to 10 prospective buyers (founders, heads of engineering, agencies): what do they pay now, what would they pay for this, what would make them buy at $5K instead, and which depth and cadence they would actually schedule.
3. Test two or three price points with a pre-checkout choice or quote, watching conversion and objections rather than asking hypotheticals.
4. Review after 20 paid runs: margin per depth, support time per run, how many customers schedule scans and at which depth and cadence.

## 8. Implementation work this implies

Items 1 to 3 were done in the Phase 2 UI shell (2026-11-08); see the "Revenue rework" note in [IMPLEMENTATION.md](./IMPLEMENTATION.md). Item 2 is partly done: the customer stream carries no cost; the staff-only cost channel comes with Phase 5/9.

1. Split tier config into public descriptor vs server-only limits; update `src/shared`, web imports and tests.
2. Strip `spendUsd`/cost fields from the customer event stream; add a staff-only cost channel; contract test for customer payloads.
3. Replace the budget meter with the Coverage/Depth meter; remove Cost column and report cost line; update mocks and tests.
4. Add a **price list** config (versioned, separate from cost price table) with a price per depth; wire to Stripe Checkout products.
5. Add the pricing worksheet to the staff dashboard: current p95 cost per depth, floor formula, margin at a chosen price, break-even runs, annualised cost per cadence.
6. Define the retest and monitoring entitlements and their data model (credits per depth, per scheduled run).

## 9. Open questions

- Currency and GST presentation: AUD-first, GST-inclusive display?
- Is a human-reviewed upgrade something we want to deliver ourselves, or partner for?
- Public price list vs. "from $X" vs. quote-only? Public per-depth prices invite comparison; "from" plus a depth selector may protect the anchor.
- Do prepaid bundles of scheduled runs (for example 30 Scouts) get a structural discount, and how long do credits last?
- Do we want a minimum commitment (annual) for monitoring from day one?
- Should a notification email address belong to the scan (as built) or also be a reusable account-level contact list?
- Liability and positioning wording: "assessment" vs. "penetration test".
