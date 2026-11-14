import { TIERS, tiers, type TierId } from "@swarm/shared";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { api } from "../../api/client.js";
import type { StaffRunFilters } from "../../api/staff.js";
import { formatDateTime } from "../../format.js";
import { SOURCE_LABELS, formatDuration, usd } from "./format.js";

type Filters = {
  tier: "" | TierId;
  trigger: "" | "manual" | "scheduled";
  entitlement: "" | "staff" | "comp" | "purchase" | "credit";
  status: "" | "queued" | "running" | "complete" | "stopped" | "failed";
  test: "" | "include" | "only";
  from: string;
  to: string;
};

const NONE: Filters = {
  tier: "",
  trigger: "",
  entitlement: "",
  status: "",
  test: "",
  from: "",
  to: "",
};

const toParams = (f: Filters): StaffRunFilters => ({
  ...(f.tier ? { tier: f.tier } : {}),
  ...(f.trigger ? { trigger: f.trigger } : {}),
  ...(f.entitlement ? { entitlement: f.entitlement } : {}),
  ...(f.status ? { status: f.status } : {}),
  ...(f.test ? { test: f.test } : {}),
  ...(f.from ? { from: f.from } : {}),
  ...(f.to ? { to: f.to } : {}),
});

/** Every run, closed ones from the anonymised index and the ones still going from their accounts. */
export function RunsView() {
  const [filters, setFilters] = useState<Filters>(NONE);
  const runs = useQuery({
    queryKey: ["staff-runs", filters],
    queryFn: () => api.staff.runs(toParams(filters)),
    refetchInterval: (query) => (query.state.data?.rows.some((r) => r.live) ? 5000 : false),
  });
  const set = <K extends keyof Filters>(key: K, value: Filters[K]) =>
    setFilters((f) => ({ ...f, [key]: value }));

  return (
    <section className="card" aria-labelledby="runs-title">
      <h2 id="runs-title" className="card-title">
        Runs
      </h2>
      <div className="actions-row" role="search" aria-label="Filter runs">
        <div className="field">
          <label htmlFor="f-from">From</label>
          <input
            id="f-from"
            type="date"
            value={filters.from}
            onChange={(e) => set("from", e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="f-to">To</label>
          <input
            id="f-to"
            type="date"
            value={filters.to}
            onChange={(e) => set("to", e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="f-tier">Depth</label>
          <select
            id="f-tier"
            value={filters.tier}
            onChange={(e) => set("tier", e.target.value as Filters["tier"])}
          >
            <option value="">All</option>
            {TIERS.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-trigger">Trigger</label>
          <select
            id="f-trigger"
            value={filters.trigger}
            onChange={(e) => set("trigger", e.target.value as Filters["trigger"])}
          >
            <option value="">All</option>
            <option value="manual">Manual</option>
            <option value="scheduled">Scheduled</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-paid">Paid by</label>
          <select
            id="f-paid"
            value={filters.entitlement}
            onChange={(e) => set("entitlement", e.target.value as Filters["entitlement"])}
          >
            <option value="">All</option>
            {Object.entries(SOURCE_LABELS).map(([id, label]) => (
              <option key={id} value={id}>
                {label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-status">Status</label>
          <select
            id="f-status"
            value={filters.status}
            onChange={(e) => set("status", e.target.value as Filters["status"])}
          >
            <option value="">All</option>
            {["queued", "running", "complete", "stopped", "failed"].map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="f-test">Test accounts</label>
          <select
            id="f-test"
            value={filters.test}
            onChange={(e) => set("test", e.target.value as Filters["test"])}
          >
            <option value="">Left out</option>
            <option value="include">Included</option>
            <option value="only">Only</option>
          </select>
        </div>
      </div>

      {runs.isPending ? (
        <p className="muted">Loading…</p>
      ) : runs.isError ? (
        <p className="error" role="alert">
          Could not load the runs.
        </p>
      ) : runs.data.rows.length === 0 ? (
        <p className="muted">
          No runs match, from {runs.data.from} to {runs.data.to}.
        </p>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">Started (UTC)</th>
                <th scope="col">Depth</th>
                <th scope="col">Trigger</th>
                <th scope="col">Paid by</th>
                <th scope="col">Status</th>
                <th scope="col">Duration</th>
                <th scope="col">Findings</th>
                <th scope="col">Estimated cost</th>
              </tr>
            </thead>
            <tbody>
              {runs.data.rows.map((r) => (
                <tr key={r.runId} data-testid="staff-run-row">
                  <th scope="row">
                    <Link to={`/staff/runs/${r.runId}`}>{formatDateTime(r.startedAt)}</Link>
                    {r.test && <span className="badge"> test</span>}
                  </th>
                  <td>{tiers[r.tier].name}</td>
                  <td>{r.trigger}</td>
                  <td>{SOURCE_LABELS[r.entitlement]}</td>
                  <td>
                    <span className="badge badge-status" data-status={r.status}>
                      {r.status}
                    </span>
                  </td>
                  <td>{formatDuration(r.durationSeconds)}</td>
                  <td>{r.findings}</td>
                  <td>{usd(r.costUsd)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {runs.data?.truncated && (
        <p className="muted small">Only the newest runs are shown. Narrow the dates to see more.</p>
      )}
    </section>
  );
}
