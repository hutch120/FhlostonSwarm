import { tiers, type TierConfig } from "@swarm/shared";
import { useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router";
import { api } from "../api/client.js";
import {
  LOGIN_SLOTS,
  emptyIntake,
  validateIntake,
  type IntakeErrors,
  type IntakeValues,
  type LoginSlotId,
  type LoginValues,
} from "../intake.js";

function TierCard({
  tier,
  selected,
  disabled,
}: {
  tier: TierConfig;
  selected: boolean;
  disabled?: boolean;
}) {
  return (
    <div className="tier" data-selected={selected} data-disabled={disabled}>
      <h2 className="tier-title">
        {tier.name}{" "}
        <span className="badge">{tier.paid ? "Paid, coming soon" : "Free, 1 per account"}</span>
      </h2>
      <p className="muted">{tier.description}</p>
      <ul className="small">
        <li>
          {tier.logins} login{tier.logins === 1 ? "" : "s"}, up to {tier.wallClockMinutes} minutes
        </li>
        <li>
          {tier.areas.length} testing area{tier.areas.length === 1 ? "" : "s"}
        </li>
        <li>
          {tier.teaserFindings === null
            ? "Full report with every finding"
            : `Teaser report: top ${tier.teaserFindings} findings in detail`}
        </li>
        <li>{tier.steering ? "Steer the agents while they work" : "Watch only (no steering)"}</li>
      </ul>
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
  const [values, setValues] = useState<IntakeValues>(emptyIntake);
  const [errors, setErrors] = useState<IntakeErrors>({});
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

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
          <legend>Tier</legend>
          <div className="tiers">
            <TierCard tier={tiers.lite} selected />
            <TierCard tier={tiers.full} selected={false} disabled />
          </div>
        </fieldset>

        <fieldset className="card">
          <legend>Test logins</legend>
          <p className="notice" role="note">
            Use <strong>staging</strong> credentials, never production. Give the swarm accounts you
            would be comfortable seeing probed, and rotate the passwords afterwards.
          </p>
          <p className="muted">
            Lite uses {tiers.lite.logins} login. Choose which one to use; the others are available
            in Full.
          </p>
          <div className="logins">
            {LOGIN_SLOTS.map((slot) => {
              const locked = values.tier === "lite" && values.liteSlot !== slot.id;
              const prefix = `login.${slot.id}`;
              const login = values.logins[slot.id];
              return (
                <fieldset key={slot.id} className="login" data-locked={locked}>
                  <legend>{slot.label}</legend>
                  <p className="hint">{slot.hint}</p>
                  {values.tier === "lite" && (
                    <label className="radio">
                      <input
                        type="radio"
                        name="liteSlot"
                        checked={values.liteSlot === slot.id}
                        onChange={() => setField("liteSlot", slot.id)}
                      />
                      Use this login for the Lite run
                    </label>
                  )}
                  {locked && <p className="hint">Available in Full.</p>}
                  <fieldset className="login-fields" disabled={locked}>
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
            Start Lite assessment
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
