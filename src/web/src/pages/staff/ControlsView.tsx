import {
  TIERS,
  type StaffControls,
  type StaffLearning,
  type StaffTierCaps,
  type TierId,
} from "@swarm/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { api, messageFor } from "../../api/client.js";
import type { StaffControlsPatch } from "../../api/staff.js";
import { formatDateTime } from "../../format.js";
import { lines } from "./format.js";

type Say = (text: string, error?: boolean) => void;

/** Staff controls: the kill switch, the limits on use, the depth caps, block lists and the learning layer. */
export function ControlsView() {
  const queryClient = useQueryClient();
  const controls = useQuery({ queryKey: ["staff-controls"], queryFn: () => api.staff.controls() });
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const say: Say = (text, error = false) => setMessage({ text, error });

  const save = async (patch: StaffControlsPatch, done: string) => {
    setMessage(null);
    try {
      const next = await api.staff.saveControls(patch);
      queryClient.setQueryData(["staff-controls"], next);
      await queryClient.invalidateQueries({ queryKey: ["staff-audit"] });
      say(done);
    } catch (err) {
      say(messageFor(err, "Could not save the controls."), true);
    }
  };

  if (controls.isPending) return <p className="muted">Loading…</p>;
  if (controls.isError) {
    return (
      <p className="error" role="alert">
        Could not load the controls.
      </p>
    );
  }
  const c = controls.data;
  return (
    <>
      {message && (
        <p className={message.error ? "error" : "banner"} role={message.error ? "alert" : "status"}>
          {message.text}
        </p>
      )}
      <KillSwitchCard controls={c} say={say} />
      <UseLimitsCard key={`use-${c.updatedAt}`} controls={c} save={save} />
      <CapsCard key={`caps-${c.updatedAt}`} controls={c} save={save} />
      <BlockListsCard key={`block-${c.updatedAt}`} controls={c} save={save} />
      <LearningCard say={say} />
      <AuditCard />
    </>
  );
}

function KillSwitchCard({ controls, say }: { controls: StaffControls; say: Say }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState("");
  const on = controls.killSwitch.on;

  const flip = async (turnOn: boolean) => {
    try {
      const result = await api.staff.setKillSwitch(turnOn, reason);
      queryClient.setQueryData(["staff-controls"], result.controls);
      await queryClient.invalidateQueries({ queryKey: ["staff-audit"] });
      await queryClient.invalidateQueries({ queryKey: ["staff-health"] });
      setReason("");
      say(
        turnOn
          ? `The kill switch is on. ${result.stopped} runs were stopped.`
          : "The kill switch is off. New runs can start.",
      );
    } catch (err) {
      say(messageFor(err, "Could not change the kill switch."), true);
    }
  };

  return (
    <section className={`card${on ? " danger-zone" : ""}`} aria-labelledby="kill-title">
      <h2 id="kill-title" className="card-title">
        Kill switch
      </h2>
      <p data-testid="kill-state">
        {on ? (
          <>
            <strong>On.</strong> No new run can start, and everything running was stopped
            {controls.killSwitch.reason ? `: ${controls.killSwitch.reason}` : ""}
            {controls.killSwitch.by ? ` (by ${controls.killSwitch.by})` : ""}.
          </>
        ) : (
          <>
            <strong>Off.</strong> Runs start normally.
          </>
        )}
      </p>
      <div className="field">
        <label htmlFor="k-reason">Reason (kept in the audit log)</label>
        <input id="k-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      {on ? (
        <button
          type="button"
          className="btn btn-primary"
          disabled={reason.trim().length < 3}
          onClick={() => flip(false)}
        >
          Turn the kill switch off
        </button>
      ) : (
        <button
          type="button"
          className="btn btn-danger"
          disabled={reason.trim().length < 3}
          onClick={() => flip(true)}
        >
          Turn the kill switch on and stop every run
        </button>
      )}
    </section>
  );
}

function UseLimitsCard({
  controls,
  save,
}: {
  controls: StaffControls;
  save: (p: StaffControlsPatch, done: string) => Promise<void>;
}) {
  const [concurrency, setConcurrency] = useState(controls.concurrency);
  const [alarm, setAlarm] = useState(
    controls.dailySpendAlarmUsd === null ? "" : String(controls.dailySpendAlarmUsd),
  );
  const [active, setActive] = useState(controls.scheduledScans.maxActivePerAccount);
  const [spacing, setSpacing] = useState(controls.scheduledScans.minSpacingHours);

  return (
    <section className="card" aria-labelledby="use-title">
      <h2 id="use-title" className="card-title">
        Limits on use
      </h2>
      <p className="muted">These apply to the next run or scan, with no deploy.</p>
      <h3>Runs at once, per depth</h3>
      <div className="actions-row">
        {TIERS.map((t) => (
          <div className="field" key={t.id}>
            <label htmlFor={`conc-${t.id}`}>{t.name}</label>
            <input
              id={`conc-${t.id}`}
              type="number"
              min={1}
              max={50}
              value={concurrency[t.id]}
              onChange={(e) => setConcurrency({ ...concurrency, [t.id]: Number(e.target.value) })}
            />
            <span className="hint">default {controls.defaults.concurrency[t.id]}</span>
          </div>
        ))}
      </div>
      <h3>Daily spend alarm</h3>
      <div className="field">
        <label htmlFor="alarm">
          Alarm when a day's estimated spend passes (US$, empty for none)
        </label>
        <input
          id="alarm"
          type="number"
          min={0}
          step="any"
          value={alarm}
          onChange={(e) => setAlarm(e.target.value)}
        />
      </div>
      <h3>Scheduled scans, per account</h3>
      <div className="actions-row">
        <div className="field">
          <label htmlFor="sched-active">Most active repeating scans</label>
          <input
            id="sched-active"
            type="number"
            min={0}
            max={100}
            value={active}
            onChange={(e) => setActive(Number(e.target.value))}
          />
        </div>
        <div className="field">
          <label htmlFor="sched-spacing">Shortest time between runs (hours)</label>
          <input
            id="sched-spacing"
            type="number"
            min={0}
            value={spacing}
            onChange={(e) => setSpacing(Number(e.target.value))}
          />
        </div>
      </div>
      <button
        type="button"
        className="btn btn-primary"
        onClick={() =>
          save(
            {
              concurrency,
              dailySpendAlarmUsd: alarm.trim() === "" ? null : Number(alarm),
              scheduledScans: { maxActivePerAccount: active, minSpacingHours: spacing },
            },
            "The limits were saved.",
          )
        }
      >
        Save limits
      </button>
    </section>
  );
}

type CapFields = Record<TierId, { [K in keyof StaffTierCaps]: string }>;

const toFields = (caps: Record<TierId, StaffTierCaps>): CapFields =>
  Object.fromEntries(
    TIERS.map((t) => {
      const c = caps[t.id];
      return [
        t.id,
        {
          pageCap: c.pageCap === null ? "" : String(c.pageCap),
          llmStepCap: c.llmStepCap === null ? "" : String(c.llmStepCap),
          stepCap: String(c.stepCap),
          requestCap: String(c.requestCap),
          requestsPerSecond: String(c.requestsPerSecond),
          tokenCap: c.tokenCap ? `${c.tokenCap.input}/${c.tokenCap.output}` : "",
          spendCapUsd: String(c.spendCapUsd),
        },
      ];
    }),
  ) as unknown as CapFields;

const CAP_COLUMNS: { key: keyof StaffTierCaps; label: string }[] = [
  { key: "spendCapUsd", label: "Model spend (US$)" },
  { key: "stepCap", label: "Checks" },
  { key: "requestCap", label: "Requests" },
  { key: "requestsPerSecond", label: "Requests per second" },
  { key: "pageCap", label: "Pages" },
  { key: "llmStepCap", label: "Model calls" },
  { key: "tokenCap", label: "Tokens in/out" },
];

type CapsPatch = NonNullable<NonNullable<StaffControlsPatch["caps"]>[TierId]>;

function parseCaps(fields: CapFields[TierId]): CapsPatch {
  const optional = (v: string) => (v.trim() === "" ? null : Number(v));
  const [input, output] = fields.tokenCap.split("/").map((v) => Number(v.trim()));
  return {
    pageCap: optional(fields.pageCap),
    llmStepCap: optional(fields.llmStepCap),
    stepCap: Number(fields.stepCap),
    requestCap: Number(fields.requestCap),
    requestsPerSecond: Number(fields.requestsPerSecond),
    tokenCap: fields.tokenCap.trim() === "" ? null : { input: input ?? 0, output: output ?? 0 },
    spendCapUsd: Number(fields.spendCapUsd),
  };
}

function CapsCard({
  controls,
  save,
}: {
  controls: StaffControls;
  save: (p: StaffControlsPatch, done: string) => Promise<void>;
}) {
  const [fields, setFields] = useState(() => toFields(controls.caps));
  const set = (tier: TierId, key: keyof StaffTierCaps, value: string) =>
    setFields({ ...fields, [tier]: { ...fields[tier], [key]: value } });

  return (
    <section className="card" aria-labelledby="caps-title">
      <h2 id="caps-title" className="card-title">
        Depth caps
      </h2>
      <p className="muted">
        What one run of each depth may use. A change applies to runs that start after it. Spend caps
        must keep rising with depth. Empty means no fixed cap. Tokens are typed as input/output.
      </p>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Depth</th>
              {CAP_COLUMNS.map((col) => (
                <th key={col.key} scope="col">
                  {col.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {TIERS.map((t) => (
              <tr key={t.id}>
                <th scope="row">{t.name}</th>
                {CAP_COLUMNS.map((col) => (
                  <td key={col.key}>
                    <input
                      aria-label={`${t.name} ${col.label}`}
                      value={fields[t.id][col.key]}
                      onChange={(e) => set(t.id, col.key, e.target.value)}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <button
        type="button"
        className="btn btn-primary"
        onClick={() =>
          save(
            { caps: Object.fromEntries(TIERS.map((t) => [t.id, parseCaps(fields[t.id])])) },
            "The caps were saved.",
          )
        }
      >
        Save caps
      </button>
    </section>
  );
}

function BlockListsCard({
  controls,
  save,
}: {
  controls: StaffControls;
  save: (p: StaffControlsPatch, done: string) => Promise<void>;
}) {
  const [hosts, setHosts] = useState(controls.blockedHosts.join("\n"));
  const [domains, setDomains] = useState(controls.blockedEmailDomains.join("\n"));
  return (
    <section className="card" aria-labelledby="block-title">
      <h2 id="block-title" className="card-title">
        Block lists
      </h2>
      <p className="muted">
        One domain per line. They add to the lists in the code. A blocked host (and its subdomains)
        cannot be scanned, by customers or staff. A blocked email domain cannot sign in or receive
        scan notices.
      </p>
      <div className="field">
        <label htmlFor="blocked-hosts">Blocked target hosts</label>
        <textarea
          id="blocked-hosts"
          rows={4}
          value={hosts}
          onChange={(e) => setHosts(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="blocked-domains">Blocked email domains</label>
        <textarea
          id="blocked-domains"
          rows={4}
          value={domains}
          onChange={(e) => setDomains(e.target.value)}
        />
      </div>
      <button
        type="button"
        className="btn btn-primary"
        onClick={() =>
          save(
            { blockedHosts: lines(hosts), blockedEmailDomains: lines(domains) },
            "The block lists were saved.",
          )
        }
      >
        Save block lists
      </button>
    </section>
  );
}

function LearningCard({ say }: { say: Say }) {
  const queryClient = useQueryClient();
  const learning = useQuery({ queryKey: ["staff-learning"], queryFn: () => api.staff.learning() });

  const change = async (action: () => Promise<StaffLearning>, done: string) => {
    try {
      queryClient.setQueryData(["staff-learning"], await action());
      await queryClient.invalidateQueries({ queryKey: ["staff-audit"] });
      say(done);
    } catch (err) {
      say(messageFor(err, "Could not change the learning layer."), true);
    }
  };

  if (!learning.data)
    return (
      <section className="card">
        <p className="muted">Loading the learning layer…</p>
      </section>
    );
  const l = learning.data;
  const entries = [
    ...l.items.map((e) => ({ ...e, kind: "item" as const })),
    ...l.agents.map((e) => ({ ...e, kind: "agent" as const })),
  ];
  return (
    <section className="card" aria-labelledby="learning-title">
      <h2 id="learning-title" className="card-title">
        Learning layer
      </h2>
      <p data-testid="learning-state">
        Runs use version <strong>{l.version ?? "none"}</strong>.{" "}
        {l.killSwitchOn
          ? "The layer is OFF: runs use the baseline only."
          : l.enabled
            ? "The layer is on."
            : "The layer is off in the configuration."}
      </p>
      <button
        type="button"
        className="btn"
        onClick={() =>
          change(
            () => api.staff.setLearningEnabled(l.killSwitchOn),
            l.killSwitchOn ? "The learning layer is on." : "The learning layer is off.",
          )
        }
      >
        {l.killSwitchOn ? "Turn the learning layer on" : "Turn the learning layer off"}
      </button>
      <h3>Versions</h3>
      <ul data-testid="learning-versions">
        {l.versions.map((v) => (
          <li key={v.version}>
            <strong>v{v.version}</strong> {formatDateTime(v.createdAt)}: {v.items} items, {v.agents}{" "}
            agents. {v.reason}{" "}
            {v.version === l.version ? (
              <span className="badge">in use</span>
            ) : (
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() =>
                  change(
                    () => api.staff.rollbackLearning(v.version),
                    `Runs now use version ${v.version}.`,
                  )
                }
              >
                Use v{v.version}
              </button>
            )}
          </li>
        ))}
      </ul>
      <h3>Items and agents</h3>
      <div className="table-wrap">
        <table data-testid="learning-entries">
          <thead>
            <tr>
              <th scope="col">Entry</th>
              <th scope="col">Status</th>
              <th scope="col">Source</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <tr key={e.id}>
                <th scope="row">
                  {e.title} <span className="muted">({e.kind})</span>
                </th>
                <td>
                  {e.status}
                  {e.pinned ? ", pinned" : ""}
                  {e.disabled ? ", disabled" : ""}
                </td>
                <td>{e.source}</td>
                <td className="actions">
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() =>
                      change(
                        () =>
                          api.staff.setLearningEntry({ kind: e.kind, id: e.id, pinned: !e.pinned }),
                        e.pinned ? "Unpinned." : "Pinned.",
                      )
                    }
                  >
                    {e.pinned ? "Unpin" : "Pin"}
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() =>
                      change(
                        () =>
                          api.staff.setLearningEntry({
                            kind: e.kind,
                            id: e.id,
                            disabled: !e.disabled,
                          }),
                        e.disabled ? "Enabled." : "Disabled.",
                      )
                    }
                  >
                    {e.disabled ? "Enable" : "Disable"}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="muted small">
        Pinning or disabling publishes a new version; rolling back only moves the pointer, so no
        version is lost.
      </p>
    </section>
  );
}

function AuditCard() {
  const audit = useQuery({ queryKey: ["staff-audit"], queryFn: () => api.staff.audit() });
  return (
    <section className="card" aria-labelledby="audit-title">
      <h2 id="audit-title" className="card-title">
        Audit log
      </h2>
      {!audit.data ? (
        <p className="muted">Loading…</p>
      ) : audit.data.length === 0 ? (
        <p className="muted">Nothing yet.</p>
      ) : (
        <ul data-testid="audit-log">
          {audit.data.map((a, i) => (
            <li key={`${a.at}-${i}`}>
              <span className="muted">{formatDateTime(a.at)}</span> {a.action} by {a.by}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
