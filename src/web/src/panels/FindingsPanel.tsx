import type { Finding, RunState } from "@swarm/shared";

export function SeverityBadge({ severity }: { severity: Finding["severity"] }) {
  return (
    <span className="badge badge-sev" data-severity={severity}>
      {severity}
    </span>
  );
}

export function VerifiedBadge({ verified }: { verified: boolean }) {
  return verified ? (
    <span className="badge badge-verified">Verified</span>
  ) : (
    <span className="badge badge-unverified" title="Not yet cross-checked by a second agent">
      Unverified
    </span>
  );
}

/** Findings as they arrive, worst first. Candidates are unverified until a second agent confirms. */
export function FindingsPanel({ state }: { state: RunState }) {
  const { findings } = state;
  return (
    <section className="panel" aria-labelledby="findings-heading">
      <h2 id="findings-heading" className="panel-title">
        Findings{" "}
        <span className="count" data-testid="findings-count">
          {findings.length}
        </span>
      </h2>
      {findings.length === 0 ? (
        <p className="muted">Nothing yet. Findings appear here as agents report them.</p>
      ) : (
        <ol className="findings">
          {findings.map((f) => (
            <li key={f.id} className="finding" data-testid="finding" data-severity={f.severity}>
              <div className="finding-head">
                <SeverityBadge severity={f.severity} />
                <span className="finding-id">{f.id}</span>
                <VerifiedBadge verified={f.verified} />
              </div>
              <p className="finding-title">{f.title}</p>
              <p className="finding-meta">
                {state.agents[f.agent]?.spec.name ?? f.agent} · <code>{f.component}</code>
              </p>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
