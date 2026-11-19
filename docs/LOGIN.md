# Logging in to the customer's application

How the swarm signs in to the application under test. This is about **our agents logging in to the customer's site**, not about customers logging in to Swarm ([PLAN.md section 5](./PLAN.md#5-auth-email-otp-via-ses)).

**Scope: one login style.** A login is a **username plus a password or passcode**, typed into a sign-in form. We do not automate SSO, authenticator-app codes (TOTP), emailed or SMS codes, magic links, passkeys, CAPTCHA, or pre-supplied sessions. Where a customer's login needs one of those, they give us a test account that does not (section 3), or the scan records a `gap`.

## 1. How it works

- A login slot (`admin`, `user1`, `user2`, `other`) holds `username`, `password`, `description` and free-text `notes` ([src/shared/src/scans.ts](../src/shared/src/scans.ts), [PLAN.md section 4](./PLAN.md#4-web-app-vite)). The password field also takes a fixed **test passcode** for apps whose staging sign-in uses a code box.
- `PlaywrightDriver.signIn` ([src/agents/src/explorer/playwright.ts](../src/agents/src/explorer/playwright.ts)) clears a cookie banner, finds the sign-in form (one form with a password or one-time-code field, or a username-only first step followed by the password step), fills the username and secret, submits with the form's own button, and decides success from the page that follows. When it fails it says why with an `obstacle` (`no-form`, `sso`, `second-factor`, `captcha`, `refused`, `still-showing`).
- The customer-facing fix for each obstacle is one map, `loginHelp` ([src/shared/src/login-help.ts](../src/shared/src/login-help.ts)). The `authn` agent ([src/agents/src/agents/authn.ts](../src/agents/src/agents/authn.ts)) puts it in the report's gap text, and the intake form's "Which logins can Swarm use?" note shows the bypass entries from the same map.

No new login methods, no data-model change and no new intake fields. The work is making this one style more robust.

## 2. Credentials are test data, and the model can use them

- Customers are told on the form and in the terms to supply **dedicated staging/test accounts**, so we do not hide the credentials from the agents. The username, password and notes of each login are in the signed-in phase's prompt ([explorer.ts](../src/agents/src/explorer/explorer.ts)), as the credentials section says ([PLAN.md section 7](./PLAN.md#customer-test-credentials-keep-it-simple)): the model can type them into forms and use them in API calls.
- Hygiene stays basic: stored with the target (SSE-S3), never returned to the browser once saved (replace-only in the UI), removed with the target, run or account, and scrubbed from customer-facing reports and public log lines using the run's redaction list ([src/shared/src/redact.ts](../src/shared/src/redact.ts)).
- **Lockout safety:** at most 2 sign-in attempts per slot per run (`MAX_SIGN_IN_FAILURES` in [explorer.ts](../src/agents/src/explorer/explorer.ts)), and no retry after the application clearly refuses the login. A scan must not lock the customer's test account. The refusal message tells the customer to fix the login.

## 3. What the customer does for logins we do not support

The intake form's login help and the report's gap text say this, so the customer knows the fix:

| Their login uses | They do this on staging |
|------------------|-------------------------|
| SSO (Okta, Entra, Google…) | Give the test user a local username and password, or turn SSO off for the test environment |
| Authenticator-app, SMS, email or push MFA | Exempt the test user from MFA, or set a **fixed test passcode** and enter it as the password (this is the supported passcode case) |
| Emailed code or magic link | Set a fixed test passcode for the test user, or allow a username and password sign-in |
| Passkey or hardware key | Keep a username and password sign-in for the test user |
| CAPTCHA or bot protection on the login | Disable it for the test user or allow-list our requests (they carry the identifying `User-Agent` `Swarm/<version> (+https://fhlostonswarm.com/about)`) |
| Accounts need approval or admin creation | Create the accounts first; Swarm never registers users on the customer's site |

Never point any of these bypasses at production.

## 4. Implementation plan

**Goal:** the one supported login style works on more real sign-in forms, the model may use the supplied credentials, and every failure tells the customer which fix from section 3 applies.

**Depends on:** the explorer and agents from Phases 6 and 7 (no other phase).

**Where it lives today:** the model calls the `sign_in(login)` tool, which runs `PageDriver.signIn` in [playwright.ts](../src/agents/src/explorer/playwright.ts) (see section 1). Failures end up as `gap` text in [authn.ts](../src/agents/src/agents/authn.ts) and the explorer. The browser always goes through the scope proxy, and the driver allows only `loginSubmissions` sign-in POSTs.

**Tasks** (in order; each is shippable on its own)

1. ✅ **Credentials to the model, and a lower attempt cap.** *(Done 2026-11-15.)*
   - ✅ In [explorer.ts](../src/agents/src/explorer/explorer.ts), put each slot's username, password and `notes` in the signed-in phase prompt next to its description, and reword the `sign_in` tool description (it no longer says "you never see them").
   - ✅ Lower `MAX_SIGN_IN_FAILURES` to 2, and stop at once when the driver reports the application refused the login.
   - ✅ Replace the test `the password never reaches the model` in [limits.test.ts](../src/agents/src/limits.test.ts) with checks that the credentials are in the model's request but not in any emitted event, finding, log line or report (the run's redaction list in [runner.ts](../src/agents/src/runner.ts) and [redact.ts](../src/shared/src/redact.ts) already covers events and reports). Confirm the learning digest still rejects any proposal containing a credential ([digest.ts](../src/agents/src/learning/digest.ts)). *(The digest's forbidden set already holds every username and password and `learning.test.ts` still passes: "rejects every proposal that repeats the run".)*
2. ✅ **Name why a sign-in failed.** *(Done 2026-11-15.)*
   - ✅ Add an `obstacle` to `SignInResult` ([driver.ts](../src/agents/src/explorer/driver.ts)): `no-form` (no password or code field), `sso` (the page offers only "Continue with Google/Microsoft/Okta/SSO"), `second-factor` (after submitting, a code, authenticator or push prompt is showing), `captcha` (a reCAPTCHA, hCaptcha or Turnstile widget), `refused` (the application answered 4xx), `still-showing` (anything else). `PlaywrightDriver.signIn` sets it from the DOM it already reads.
   - ✅ Put the customer-facing fix for each obstacle, taken from the table in section 3, in one place in `src/shared` (a small `loginHelp` map). Gap text in `authn.ts` and the explorer, and the intake form note (task 5), both read it, so the wording cannot drift. The generic "supply a test account…" sentence is removed. *(`src/shared/src/login-help.ts`; the explorer's own gap text is the `authn` login step's, so only `authn.ts` and the intake form read it.)*
3. ✅ **Multi-step forms.** In `PlaywrightDriver.signIn`, when only a username field is visible, fill it, submit, wait for a password or code field (bounded wait), then continue as today; the two steps count as one attempt. Dismiss a cookie banner that covers the form by clicking a visible "Accept/Agree/OK" button, and prefer the form's own submit button over `Enter`. *(Done 2026-11-15.)*
4. ✅ **Model-guided fallback (only if tasks 2 and 3 leave real forms unsupported).** First try tasks 1 to 3 on real sign-in pages (below) and record which still fail; build this only for those. *(Not built, closed for now 2026-11-20: no real staging sign-in page has been tried, so no form is known to need it. Revisit if a real page fails.)*
   - Give `PageSnapshot` forms a stable `ref` per field and button, and add `fill(ref, value)` and `click(ref)` to `PageDriver`.
   - Expose them to the model as tools `fill_field` and `click_button`, only in the signed-in phase and only after `sign_in` reported `no-form` or `still-showing` on the sign-in page. A click on a submit control counts as a sign-in attempt against the cap, and the proxy's `loginSubmissions` limit still applies.
5. ✅ **Customer-facing text.** Add a short "supported logins" note under the test logins on the intake form, built from the same `loginHelp` map, with a link to the section 3 table; update the credentials paragraph in [PLAN.md section 7](./PLAN.md#customer-test-credentials-keep-it-simple) if it still describes the agents as not seeing passwords. *(Done 2026-11-15: a "Which logins can Swarm use?" disclosure on the intake form lists the SSO, second-factor and CAPTCHA fixes from `loginHelp`. No link to the section 3 table: the docs are not published, so the note carries the text itself. PLAN.md section 7 already said the agents read the credentials; it now also states the lockout cap.)*

**Verification**

- ✅ Driver tests in [playwright.test.ts](../src/agents/src/explorer/playwright.test.ts) with small in-test servers (the same style as the existing sign-in page there), one per case: single form, username-then-password, passcode box, cookie banner over the form, SSO-only page, code prompt after sign-in, CAPTCHA widget, refused credentials. Each asserts `ok` and the `obstacle`. *(Verified 2026-11-15: 10 tests, all passing in a real Chromium behind the real scope proxy: the cases above plus `still-showing` and `no-form` (a search box is not mistaken for a username step).)*
- ✅ Attempt cap: a refused login is tried once, then the model is told to carry on; a second failing login of another slot is still tried. *(Verified 2026-11-15: `limits.test.ts` "tries a refused login once…": two POSTs reach the target, one per slot. It found a bug, fixed: after a failed attempt the browser was left on the error page, so the next slot found no form; each attempt now starts from the sign-in page. And "stops retrying a sign-in that keeps failing": 2 attempts, not 3.)*
- ✅ `limits.test.ts`: the credentials reach the model, and none of them (nor a cookie value) appears in events, findings, the report or the logs. *(Verified 2026-11-15: the test reads the session cookies the browser held, and checks them and the password against the emitted events, the task result, the gaps, the proxy log and the console logs; the report is covered by the redaction list and `pipeline.test.ts`, and the live run's report held no password.)*
- ✅ Gap text: each obstacle produces its own fix sentence in the report's *Scope limitations / gaps*, and the generic sentence is gone. *(Verified 2026-11-15: `authn.test.ts` runs the `login` step once per obstacle and for a login that failed while another signed in; the live run with a wrong password showed the `refused` sentence in the report.)*
- ✅ Regression: the synthetic-target benchmark (`benchmark.live` in `src/agents`) and `pipeline.test.ts` still sign in as `admin`, `user1` and `user2` and find the same seeded issues. *(Verified 2026-11-15: `SWARM_LIVE=1 … vitest run --project node benchmark.live` 3 passed (113 s, real Bedrock); `explorer.live` 2 passed against the real Haiku; `deep.test.ts` (all three roles) and `pipeline.test.ts` pass in `npm test`.)*
- ✅ Checks for every change: `npm run typecheck`, `npm test`, `npm run lint`. *(Verified 2026-11-15: typecheck clean; lint clean; `npm test` 52 files passed, 3 skipped (live and integration), 758 tests passed.)*
- ✅ A live Probe or Siege run on the deployed stack against the synthetic target signs in, and a run against two real staging sign-in pages of different shapes (supplied by you) either signs in or reports the right gap. *(Closed for now 2026-11-20; the two real pages may be tried later. Half done 2026-11-15. On the deployed stack a Sweep against the on-demand synthetic target signed in as the administrator (12 findings, the 12 in `expected.json`, no password in the report), and a Sweep with a wrong password reported the `refused` gap and 11 findings. The two real staging pages are not done: none was supplied. Send two and I will run them and record any form that needs task 4.)*

**Exit criteria:** ✅ every obstacle in section 3 produces its own gap text; ✅ the supported shapes in the verification list sign in; ✅ the credentials are visible to the model and absent from everything the customer reads; ✅ typecheck, tests and lint are green.

**Notes (done 2026-11-15)**
- **Where it lives:** `src/shared/src/login-help.ts` (`SIGN_IN_OBSTACLES`, `loginHelp`, `LOGIN_BYPASS_NOTES`, exported from `@swarm/shared`); `playwright.ts` (`signIn`, `attemptSignIn`, the `INSPECT` page probe); `explorer.ts` (prompt, cap, reopening the sign-in page); `authn.ts` (gap text); `Intake.tsx` (the note). Tests: `playwright.test.ts`, `limits.test.ts`, `authn.test.ts`, one case in `src/web/src/app.test.tsx`.
- **Deviation: a refused login is now a failure even when the error page has no form.** Before, a sign-in that answered 401 with a JSON body counted as "Signed in" (no password field was left). The last submission's status now decides: 4xx or 5xx means `refused`.
- **Deviation: the proxy's sign-in allowance doubled.** A username step and a password step are two POSTs, and an attempt may be one of two, so a run allows 4 sign-in POSTs per login (`src/api/src/runs.ts`, was 2). Two attempts per login is still the cap, and nothing else may change state.
- **Second factor** is reported only when the field that was filled was a password and the page after it shows a code box with wording that asks for a code. A wrong passcode in a passcode-only form is `refused` or `still-showing`, not `second-factor`.
- **Username step** is tried only when the single text or email box looks like a login name (type `email`, or its name, id, placeholder or label says user, email, login, account, member, phone or identifier), so a search box is `no-form`.
- **A login that never signed in** now gets its own gap even when another login did (`authn` login step), so a customer with three logins learns which one failed and why. When a finding is raised in the same step, those gaps are not carried (the step result has no place for them).
- **Cookie banner:** only a visible button or link whose whole text is accept, agree, ok, got it or similar is clicked, before the form is filled.
- **Live run:** the deployed `SwarmRuns` stack was redeployed with the new agent image (`npm run swarm -- deploy -- --require-approval never`). The two live runs used `swarm-test-login@example.com` (2 comp credits, audit-logged) against `swarm synthetic-target start`; the target was stopped and `swarm test-cleanup --delete` removed the records. The session was minted with the real signing key by a throwaway script outside the repo, as in Phase 5.
- **For later phases:** `PageDriver.signIn` returns `obstacle` and `SignInRecord` carries it, so Phase 10's hardening review and any report wording can use it. Real-world forms that fail should be added as a driver test first, then handled here or by task 4.

**Not in this plan:** SSO, TOTP, emailed or SMS codes, magic links, passkeys, CAPTCHA solving, supplied sessions or tokens, a "check login" button, and any change to the login data model.

## 5. Decisions

- **One login style:** username plus password or passcode. Everything else is a customer-side change or a gap.
- **Credentials are given to the model**, stored like passwords (SSE-S3), staging accounts only.
- **Two sign-in attempts per slot per run**, and none after the application refuses the login, to protect the customer's test accounts.
- **Model-guided form driving is built only if** the scripted driver cannot handle forms we meet in practice.
