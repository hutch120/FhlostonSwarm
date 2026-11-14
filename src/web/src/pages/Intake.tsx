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
  type TargetView,
  type TierConfig,
} from "@swarm/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState, type FormEvent } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api, fieldForError, messageFor } from "../api/client.js";
import { useSession } from "../state/session.js";
import {
  LOGIN_SLOTS,
  editLogin,
  emptyIntake,
  fitLogins,
  validateIntake,
  valuesFromScan,
  withTarget,
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

/** Loads what the form needs, then renders it: blank for a new scan, filled in to edit a saved one. */
export function Intake() {
  const { scanId } = useParams();
  const { email } = useSession();
  const targets = useQuery({ queryKey: ["targets"], queryFn: () => api.listTargets() });
  const scans = useQuery({
    queryKey: ["scans"],
    queryFn: () => api.listScans(),
    enabled: scanId !== undefined,
  });

  if (scanId === undefined) {
    return <IntakeForm initial={emptyIntake(email ?? "")} targets={targets.data ?? []} />;
  }
  if (scans.isError || targets.isError) return <p className="error">Could not load the scan.</p>;
  if (!scans.data || !targets.data) return <p className="muted">Loading…</p>;
  const scan = scans.data.find((s) => s.id === scanId);
  if (!scan) {
    return (
      <section className="card narrow">
        <h1>Scan not found</h1>
        <p>
          It may have been deleted. <Link to="/scans">Back to your scans</Link>
        </p>
      </section>
    );
  }
  return (
    <IntakeForm
      key={scanId}
      scanId={scanId}
      initial={valuesFromScan(
        scan,
        targets.data.find((t) => t.id === scan.targetId),
        email ?? "",
      )}
      targets={targets.data}
    />
  );
}

function IntakeForm({
  initial,
  targets,
  scanId,
}: {
  initial: IntakeValues;
  targets: TargetView[];
  /** Set when editing a saved scan: saving does not start a run. */
  scanId?: string;
}) {
  const [values, setValues] = useState<IntakeValues>(initial);
  const [errors, setErrors] = useState<IntakeErrors>({});
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const account = useQuery({ queryKey: ["account"], queryFn: () => api.getAccount() });
  const editing = scanId !== undefined;
  const tier = tiers[values.tier];
  const recurring = isRecurring(values.frequency);
  const target = targets.find((t) => t.id === values.targetId);
  const credits = account.data?.credits[values.tier];
  const unmetered = account.data?.unmetered === true;
  // With no credit for the chosen depth the scan can still be saved, and run once there is one.
  const canStart = !editing && (unmetered || (credits ?? 0) > 0);

  const setField = <K extends keyof IntakeValues>(key: K, value: IntakeValues[K]) =>
    setValues((v) => ({ ...v, [key]: value }));
  const setLogin = (slot: LoginSlotId, patch: Partial<LoginValues>) =>
    setValues((v) => editLogin(v, slot, patch));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitError(null);
    const found = validateIntake(values);
    setErrors(found);
    if (Object.keys(found).length > 0) return;
    setBusy(true);
    try {
      const saved = await api.saveScan(values, { ...(editing ? { scanId } : {}), start: canStart });
      await queryClient.invalidateQueries();
      navigate(saved.runId ? `/runs/${saved.runId}` : "/scans");
    } catch (err) {
      const field = fieldForError(err);
      const message = messageFor(err, "Could not save the scan. Try again.");
      if (field) setErrors({ [field]: message });
      else setSubmitError(message);
      setBusy(false);
    }
  };

  const errorCount = Object.keys(errors).length;
  const fieldProps = (name: string) => ({
    "aria-invalid": errors[name] ? true : undefined,
    "aria-describedby": errors[name] ? `${name}-error` : undefined,
  });

  return (
    <>
      <div className="page-head">
        <h1>{editing ? "Edit scan" : "New assessment"}</h1>
      </div>

      <form onSubmit={submit} noValidate className="stack">
        <fieldset className="card">
          <legend>Target</legend>
          {editing ? (
            <p className="notice" role="note" data-testid="shared-target-note">
              This scan uses a saved target. Changing the URLs or logins updates the target for{" "}
              {target && target.scans.length > 1
                ? `all ${target.scans.length} scans on it`
                : "this scan"}
              .
            </p>
          ) : (
            targets.length > 0 && (
              <div className="field">
                <label htmlFor="savedTarget">Use a saved target</label>
                <select
                  id="savedTarget"
                  value={values.targetId ?? ""}
                  onChange={(e) =>
                    setValues((v) =>
                      withTarget(v, targets.find((t) => t.id === e.target.value) ?? null),
                    )
                  }
                >
                  <option value="">New target</option>
                  {targets.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.hosts[0]}
                    </option>
                  ))}
                </select>
                <p className="hint">
                  A saved target brings its URLs and logins, so you do not enter them again.
                </p>
              </div>
            )
          )}
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
                onSelect={() => setValues((v) => fitLogins(v, t.id))}
              />
            ))}
          </div>
          {editing || credits === undefined ? null : unmetered ? (
            <p className="hint" data-testid="credit-note">
              As staff you can start runs without a credit.
            </p>
          ) : credits === 0 ? (
            <p className="notice" role="note" data-testid="no-credit">
              You have no {tier.name} credits, so this scan will be saved but not started. During
              the private beta credits are granted by our team: email{" "}
              <a href="mailto:support@fhlostonswarm.com">support@fhlostonswarm.com</a> and say which
              depth you need. Once you have one, run the scan from the Scans page.
            </p>
          ) : (
            <p className="hint" data-testid="credit-note">
              Starting this scan uses one {tier.name} credit (you have {credits}).
            </p>
          )}
        </fieldset>

        <fieldset className="card">
          <legend>Schedule</legend>
          <div className="field">
            <label htmlFor="scanName">Scan name (optional)</label>
            <input
              id="scanName"
              maxLength={80}
              placeholder="e.g. Weekly staging review"
              value={values.name}
              onChange={(e) => setField("name", e.target.value)}
              {...fieldProps("name")}
            />
            <FieldError id="name-error" message={errors["name"]} />
          </div>
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
              {tier.name} uses up to {plural(tier.logins, "login")}. Fill in the logins you have and
              tick the ones this scan signs in with. Saved passwords are never shown; leave one
              blank to keep it. If the application signs in with an emailed code, use your email as
              the username and a test passcode as the password.
            </p>
          )}
          <FieldError id="logins-error" message={errors["logins"]} />
          <div className="logins" hidden={tier.logins === 0}>
            {LOGIN_SLOTS.map((slot) => {
              const prefix = `login.${slot.id}`;
              const login = values.logins[slot.id];
              const started =
                login.saved ||
                [login.username, login.password, login.description].some((v) => v.trim());
              return (
                <fieldset key={slot.id} className="login">
                  <legend>{slot.label}</legend>
                  <p className="hint">{slot.hint}</p>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={login.use}
                      disabled={!started}
                      onChange={(e) => setLogin(slot.id, { use: e.target.checked })}
                    />
                    Use {slot.label} in this scan
                  </label>
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
                        placeholder={login.saved ? "Saved. Leave blank to keep it." : undefined}
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
            requests to them. I accept the <Link to="/terms">terms of use</Link>.
          </label>
          <FieldError id="acknowledged-error" message={errors["acknowledged"]} />
          <p className="hint">
            We record this confirmation with a timestamp, your network address and the version of
            the terms. Read the <Link to="/privacy">privacy notice</Link> for what we keep and how
            to delete it.
          </p>
        </fieldset>

        <div className="actions-row">
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {editing
              ? "Save changes"
              : !canStart
                ? "Save scan"
                : recurring
                  ? "Save and start scan"
                  : "Start scan"}
          </button>
          {submitError && (
            <p className="error" role="alert">
              {submitError}
            </p>
          )}
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
