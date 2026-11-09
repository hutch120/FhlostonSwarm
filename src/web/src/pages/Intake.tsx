import {
  FREQUENCIES,
  FREQUENCY_LABELS,
  NOTIFY_ON_LABELS,
  TIERS,
  isRecurring,
  notifyOnSchema,
  frequencySchema,
  tierAreas,
  tiers,
  type TierConfig,
} from "@swarm/shared";
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { api } from "../api/client.js";
import { useSession } from "../state/session.js";
import {
  LOGIN_SLOTS,
  emptyIntake,
  validateIntake,
  type IntakeErrors,
  type IntakeValues,
  type LoginSlotId,
  type LoginValues,
} from "../intake.js";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

function TierCard({
  tier,
  selected,
  onSelect,
}: {
  tier: TierConfig;
  selected: boolean;
  onSelect: () => void;
}) {
  const inputId = `tier-${tier.id}`;
  const descId = `tier-${tier.id}-desc`;
  // The whole card is clickable; the radio and its label stay the keyboard and screen-reader path.
  return (
    <div className="tier" data-selected={selected} onClick={onSelect}>
      <h3 className="tier-title">
        <input
          id={inputId}
          type="radio"
          name="tier"
          value={tier.id}
          checked={selected}
          onChange={onSelect}
          aria-describedby={descId}
        />
        <label htmlFor={inputId}>{tier.name}</label>
        <span className="depth" aria-hidden="true">
          {TIERS.map((t) => (
            <i key={t.id} data-on={t.depth <= tier.depth} />
          ))}
        </span>
        <span className="sr-only">
          Depth {tier.depth} of {TIERS.length}
        </span>
      </h3>
      <div id={descId}>
        <p className="muted">{tier.description}</p>
        <ul className="small">
          <li>
            {plural(tier.agents.length, "agent")} across {plural(tierAreas(tier.id).length, "area")}
          </li>
          <li>
            {tier.logins === 0 ? "No logins needed" : `Up to ${plural(tier.logins, "login")}`}, up
            to {tier.wallClockMinutes} minutes
          </li>
          <li>{tier.steering ? "Steer the agents while they work" : "Watch only (no steering)"}</li>
        </ul>
      </div>
    </div>
  );
}

function FieldError({ id, message }: { id: string; message?: string }) {
  return message ? (
    <p id={id} className="error" role="alert">
      {message}
    </p>
  ) : null;
}

export function Intake() {
  const { email } = useSession();
  const [values, setValues] = useState<IntakeValues>(() => emptyIntake(email ?? ""));
  const [errors, setErrors] = useState<IntakeErrors>({});
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const tier = tiers[values.tier];
  const recurring = isRecurring(values.frequency);

  const setField = <K extends keyof IntakeValues>(key: K, value: IntakeValues[K]) =>
    setValues((v) => ({ ...v, [key]: value }));
  const setLogin = (slot: LoginSlotId, patch: Partial<LoginValues>) =>
    setValues((v) => ({ ...v, logins: { ...v.logins, [slot]: { ...v.logins[slot], ...patch } } }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const found = validateIntake(values);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    const { runId } = await api.submitIntake(values);
    navigate(`/runs/${runId}`);
  };

  const errorCount = Object.keys(errors).length;
  const fieldProps = (name: string) => ({
    "aria-invalid": errors[name] ? true : undefined,
    "aria-describedby": errors[name] ? `${name}-error` : undefined,
  });

  return (
    <>
      <div className="page-head">
        <h1>New assessment</h1>
      </div>
      <p className="notice" role="note">
        Preview: nothing is sent or stored. Submitting opens the demo replay.
      </p>

      <form onSubmit={submit} noValidate className="stack">
        <fieldset className="card">
          <legend>Target</legend>
          <div className="field">
            <label htmlFor="appUrl">Application URL (required)</label>
            <input
              id="appUrl"
              type="url"
              inputMode="url"
              placeholder="https://staging.example.com"
              value={values.appUrl}
              onChange={(e) => setField("appUrl", e.target.value)}
              {...fieldProps("appUrl")}
            />
            <FieldError id="appUrl-error" message={errors["appUrl"]} />
            <p className="hint">
              The hostnames of these URLs become the only scope the swarm can reach.
            </p>
          </div>
          <div className="field">
            <label htmlFor="marketingUrl">Marketing or landing page URL (optional)</label>
            <input
              id="marketingUrl"
              type="url"
              inputMode="url"
              placeholder="https://www.example.com"
              value={values.marketingUrl}
              onChange={(e) => setField("marketingUrl", e.target.value)}
              {...fieldProps("marketingUrl")}
            />
            <FieldError id="marketingUrl-error" message={errors["marketingUrl"]} />
          </div>
        </fieldset>

        <fieldset className="card">
          <legend>Scan depth</legend>
          <p className="muted">
            Each depth is a group of agents, from a quick passive check to a full assault on the
            application. Deeper scans cost more, so pick a light one for frequent runs and a deep
            one for the occasional full report.
          </p>
          <div className="tiers" role="radiogroup" aria-label="Scan depth">
            {TIERS.map((t) => (
              <TierCard
                key={t.id}
                tier={t}
                selected={values.tier === t.id}
                onSelect={() => setField("tier", t.id)}
              />
            ))}
          </div>
          <p className="hint">
            Every scan uses one paid credit of its depth. Pricing arrives soon.
          </p>
        </fieldset>

        <fieldset className="card">
          <legend>Schedule</legend>
          <div className="field">
            <label htmlFor="frequency">How often?</label>
            <select
              id="frequency"
              value={values.frequency}
              onChange={(e) => setField("frequency", frequencySchema.parse(e.target.value))}
            >
              {FREQUENCIES.map((f) => (
                <option key={f} value={f}>
                  {FREQUENCY_LABELS[f]}
                </option>
              ))}
            </select>
            <p className="hint">
              {recurring
                ? `Runs now, then repeats ${FREQUENCY_LABELS[values.frequency].toLowerCase()} at the same time. Each run uses one ${tier.name} credit. Pause or stop it any time on the Scans page.`
                : "Runs once, now. The scan is saved, so you can run it again later without setting it up again."}
            </p>
          </div>
        </fieldset>

        <fieldset className="card">
          <legend>Notifications</legend>
          <div className="field">
            <label htmlFor="notifyEmail">Email the report notice to</label>
            <input
              id="notifyEmail"
              type="email"
              autoComplete="off"
              placeholder="security@example.com"
              value={values.notifyEmail}
              onChange={(e) => setField("notifyEmail", e.target.value)}
              {...fieldProps("notifyEmail")}
            />
            <FieldError id="notifyEmail-error" message={errors["notifyEmail"]} />
            <p className="hint">
              Defaults to your account email. Any other address must confirm a link we send before
              it receives anything. Each scan has its own address.
            </p>
          </div>
          <div className="field">
            <label htmlFor="notifyOn">Notify me</label>
            <select
              id="notifyOn"
              value={values.notifyOn}
              onChange={(e) => setField("notifyOn", notifyOnSchema.parse(e.target.value))}
            >
              {notifyOnSchema.options.map((n) => (
                <option key={n} value={n}>
                  {NOTIFY_ON_LABELS[n]}
                </option>
              ))}
            </select>
          </div>
        </fieldset>

        <fieldset className="card">
          <legend>Test logins</legend>
          <p className="notice" role="note">
            Use <strong>staging</strong> credentials, never production. Give the swarm accounts you
            would be comfortable seeing probed, and rotate the passwords afterwards.
          </p>
          {tier.logins === 0 ? (
            <p className="muted" data-testid="no-logins">
              {tier.name} runs unauthenticated checks only, so no logins are needed. Choose a deeper
              scan to test as a signed-in user.
            </p>
          ) : (
            <p className="muted" data-testid="login-limit">
              {tier.name} uses up to {plural(tier.logins, "login")}. Fill in the ones you want to
              use.
            </p>
          )}
          <FieldError id="logins-error" message={errors["logins"]} />
          <div className="logins" hidden={tier.logins === 0}>
            {LOGIN_SLOTS.map((slot) => {
              const prefix = `login.${slot.id}`;
              const login = values.logins[slot.id];
              return (
                <fieldset key={slot.id} className="login">
                  <legend>{slot.label}</legend>
                  <p className="hint">{slot.hint}</p>
                  <fieldset className="login-fields">
                    <legend className="sr-only">{slot.label} credentials</legend>
                    <div className="field">
                      <label htmlFor={`${slot.id}-username`}>Username</label>
                      <input
                        id={`${slot.id}-username`}
                        autoComplete="off"
                        value={login.username}
                        onChange={(e) => setLogin(slot.id, { username: e.target.value })}
                        {...fieldProps(`${prefix}.username`)}
                      />
                      <FieldError
                        id={`${prefix}.username-error`}
                        message={errors[`${prefix}.username`]}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor={`${slot.id}-password`}>Password</label>
                      <input
                        id={`${slot.id}-password`}
                        type="password"
                        autoComplete="new-password"
                        value={login.password}
                        onChange={(e) => setLogin(slot.id, { password: e.target.value })}
                        {...fieldProps(`${prefix}.password`)}
                      />
                      <FieldError
                        id={`${prefix}.password-error`}
                        message={errors[`${prefix}.password`]}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor={`${slot.id}-description`}>What can this account do?</label>
                      <textarea
                        id={`${slot.id}-description`}
                        rows={2}
                        placeholder="e.g. Standard customer: can view and edit their own orders"
                        value={login.description}
                        onChange={(e) => setLogin(slot.id, { description: e.target.value })}
                        {...fieldProps(`${prefix}.description`)}
                      />
                      <FieldError
                        id={`${prefix}.description-error`}
                        message={errors[`${prefix}.description`]}
                      />
                    </div>
                    <div className="field">
                      <label htmlFor={`${slot.id}-notes`}>Notes (optional)</label>
                      <input
                        id={`${slot.id}-notes`}
                        placeholder="MFA, login URL, quirks"
                        value={login.notes}
                        onChange={(e) => setLogin(slot.id, { notes: e.target.value })}
                      />
                    </div>
                  </fieldset>
                </fieldset>
              );
            })}
          </div>
        </fieldset>

        <fieldset className="card">
          <legend>Scope notes (optional)</legend>
          <div className="field">
            <label htmlFor="scopeNotes">Anything the swarm should avoid or know?</label>
            <textarea
              id="scopeNotes"
              rows={3}
              placeholder="e.g. Don't touch /billing. Order 1001 is safe to edit."
              value={values.scopeNotes}
              onChange={(e) => setField("scopeNotes", e.target.value)}
            />
          </div>
        </fieldset>

        <fieldset className="card">
          <legend>Authorisation</legend>
          <label className="check">
            <input
              type="checkbox"
              checked={values.acknowledged}
              onChange={(e) => setField("acknowledged", e.target.checked)}
              {...fieldProps("acknowledged")}
            />
            I am authorised to test these systems, and I understand the swarm will send real
            requests to them.
          </label>
          <FieldError id="acknowledged-error" message={errors["acknowledged"]} />
          <p className="hint">
            We record this confirmation with a timestamp. See the{" "}
            <Link to="/account">account page</Link> for how to delete your data.
          </p>
        </fieldset>

        <div className="actions-row">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {recurring ? "Save and start scan" : "Start scan"}
          </button>
          {errorCount > 0 && (
            <p className="error" role="alert">
              Please fix the {errorCount} highlighted problem{errorCount === 1 ? "" : "s"}.
            </p>
          )}
        </div>
      </form>
    </>
  );
}
