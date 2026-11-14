import {
  RUNS_PER_YEAR,
  TIERS,
  suggestPrice,
  type CostAnalysis,
  type StaffPriceTable,
  type StaffPricing,
} from "@swarm/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { api, messageFor } from "../../api/client.js";
import { SOURCE_LABELS, daysAgo, formatDuration, today, usd } from "./format.js";

const CADENCES = Object.keys(RUNS_PER_YEAR) as (keyof typeof RUNS_PER_YEAR)[];

/** Cost per depth, daily spend, who paid, the pricing worksheet and the price table. */
export function CostView() {
  const [from, setFrom] = useState(daysAgo(30));
  const [to, setTo] = useState(today());
  const [test, setTest] = useState<"" | "include" | "only">("");
  const [version, setVersion] = useState("");
  const params = { from, to, ...(test ? { test } : {}), ...(version ? { pricing: version } : {}) };
  const costs = useQuery({
    queryKey: ["staff-costs", params],
    queryFn: () => api.staff.costs(params),
  });
  const pricing = useQuery({ queryKey: ["staff-pricing"], queryFn: () => api.staff.pricing() });

  return (
    <>
      <section className="card" aria-labelledby="cost-title">
        <h2 id="cost-title" className="card-title">
          Cost analysis
        </h2>
        <div className="actions-row" role="search" aria-label="Choose the runs">
          <div className="field">
            <label htmlFor="c-from">From</label>
            <input id="c-from" type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="c-to">To</label>
            <input id="c-to" type="date" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="c-test">Test accounts</label>
            <select
              id="c-test"
              value={test}
              onChange={(e) => setTest(e.target.value as typeof test)}
            >
              <option value="">Left out</option>
              <option value="include">Included</option>
              <option value="only">Only</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="c-pricing">Prices</label>
            <select id="c-pricing" value={version} onChange={(e) => setVersion(e.target.value)}>
              <option value="">Each run as it was costed</option>
              {pricing.data?.versions.map((v) => (
                <option key={v.version} value={v.version}>
                  All runs at {v.version}
                </option>
              ))}
            </select>
          </div>
        </div>
        {costs.isPending ? (
          <p className="muted">Loading…</p>
        ) : costs.isError ? (
          <p className="error" role="alert">
            Could not load the costs.
          </p>
        ) : (
          <Analysis costs={costs.data} />
        )}
      </section>

      {costs.data && <Worksheet costs={costs.data} />}
      {pricing.data && (
        <PriceEditor
          key={pricing.data.versions.map((v) => v.version).join()}
          pricing={pricing.data}
          range={{ from, to, ...(test ? { test } : {}) }}
          current={costs.data}
        />
      )}
    </>
  );
}

function Analysis({ costs }: { costs: CostAnalysis }) {
  return (
    <>
      <p data-testid="cost-summary">
        <strong>{costs.runs}</strong> runs, <strong>{usd(costs.totalUsd)}</strong> in total
        {costs.pricing.mode === "repriced" && (
          <span className="muted">
            {" "}
            at prices {costs.pricing.version}
            {costs.notRepriced > 0 && ` (${costs.notRepriced} older runs kept as recorded)`}
          </span>
        )}
        .
      </p>
      <div className="table-wrap">
        <table data-testid="cost-by-depth">
          <thead>
            <tr>
              <th scope="col">Depth</th>
              <th scope="col">Runs</th>
              <th scope="col">Average</th>
              <th scope="col">Median</th>
              <th scope="col">95th percentile</th>
              <th scope="col">Most</th>
              <th scope="col">Average time</th>
              <th scope="col">Per finding</th>
              <th scope="col">Total</th>
            </tr>
          </thead>
          <tbody>
            {TIERS.map((t) => {
              const s = costs.byTier[t.id];
              return (
                <tr key={t.id}>
                  <th scope="row">{t.name}</th>
                  <td>{s.runs}</td>
                  <td>{usd(s.avgUsd)}</td>
                  <td>{usd(s.medianUsd)}</td>
                  <td>{usd(s.p95Usd)}</td>
                  <td>{usd(s.maxUsd)}</td>
                  <td>{formatDuration(s.avgDurationSeconds)}</td>
                  <td>{s.costPerFindingUsd === null ? "n/a" : usd(s.costPerFindingUsd)}</td>
                  <td>{usd(s.totalUsd)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h3>Annualised cost of a repeating scan</h3>
      <p className="muted small">
        The average cost of a run times the runs a year of that cadence.
      </p>
      <div className="table-wrap">
        <table data-testid="cost-annual">
          <thead>
            <tr>
              <th scope="col">Depth</th>
              {CADENCES.map((c) => (
                <th key={c} scope="col">
                  {c} ({RUNS_PER_YEAR[c]} a year)
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {TIERS.map((t) => (
              <tr key={t.id}>
                <th scope="row">{t.name}</th>
                {CADENCES.map((c) => (
                  <td key={c}>
                    {costs.byTier[t.id].runs
                      ? usd(costs.byTier[t.id].avgUsd * RUNS_PER_YEAR[c])
                      : "n/a"}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="stack">
        <div>
          <h3>Who paid</h3>
          <div className="table-wrap">
            <table data-testid="cost-by-source">
              <thead>
                <tr>
                  <th scope="col">Paid by</th>
                  <th scope="col">Runs</th>
                  <th scope="col">Cost</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(costs.bySource).map(([source, v]) => (
                  <tr key={source}>
                    <th scope="row">{SOURCE_LABELS[source as keyof typeof SOURCE_LABELS]}</th>
                    <td>{v.runs}</td>
                    <td>{usd(v.usd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <h3>Where it goes</h3>
          <div className="table-wrap">
            <table data-testid="cost-components">
              <tbody>
                <tr>
                  <th scope="row">Model</th>
                  <td>{usd(costs.components.bedrockUsd)}</td>
                </tr>
                <tr>
                  <th scope="row">Compute</th>
                  <td>{usd(costs.components.fargateUsd)}</td>
                </tr>
                <tr>
                  <th scope="row">Data out</th>
                  <td>{usd(costs.components.egressUsd)}</td>
                </tr>
                <tr>
                  <th scope="row">Orchestration</th>
                  <td>{usd(costs.components.orchestrationUsd)}</td>
                </tr>
                <tr>
                  <th scope="row">Learning passes</th>
                  <td>{usd(costs.components.learnerUsd)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <h3>Spend by day</h3>
          {costs.byDay.length === 0 ? (
            <p className="muted">No runs closed in this range.</p>
          ) : (
            <div className="table-wrap">
              <table data-testid="cost-by-day">
                <thead>
                  <tr>
                    <th scope="col">Day (UTC)</th>
                    <th scope="col">Runs</th>
                    <th scope="col">Cost</th>
                  </tr>
                </thead>
                <tbody>
                  {costs.byDay.map((d) => (
                    <tr key={d.day}>
                      <th scope="row">{d.day}</th>
                      <td>{d.runs}</td>
                      <td>{usd(d.usd)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
        <div>
          <h3>Most expensive runs</h3>
          <ul>
            {costs.topRuns.map((r) => (
              <li key={r.runId}>
                <Link to={`/staff/runs/${r.runId}`}>{r.runId}</Link> ({r.tier}) {usd(r.costUsd)}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </>
  );
}

/** Margin in, suggested price per depth out, against the measured cost. Pricing itself is still to be decided. */
function Worksheet({ costs }: { costs: CostAnalysis }) {
  const [margin, setMargin] = useState(100);
  const [floor, setFloor] = useState(1);
  const [basis, setBasis] = useState<"avgUsd" | "p95Usd">("p95Usd");
  return (
    <section className="card" aria-labelledby="worksheet-title">
      <h2 id="worksheet-title" className="card-title">
        Pricing worksheet
      </h2>
      <p className="muted">
        Price is the measured cost plus a margin, never below the floor. Prices are still to be
        decided; this only shows what a margin would mean.
      </p>
      <div className="actions-row">
        <div className="field">
          <label htmlFor="w-margin">Margin over cost (%)</label>
          <input
            id="w-margin"
            type="number"
            min={0}
            step={5}
            value={margin}
            onChange={(e) => setMargin(Number(e.target.value))}
          />
        </div>
        <div className="field">
          <label htmlFor="w-floor">Floor per run (US$)</label>
          <input
            id="w-floor"
            type="number"
            min={0}
            step={0.25}
            value={floor}
            onChange={(e) => setFloor(Number(e.target.value))}
          />
        </div>
        <div className="field">
          <label htmlFor="w-basis">Cost to price from</label>
          <select
            id="w-basis"
            value={basis}
            onChange={(e) => setBasis(e.target.value as typeof basis)}
          >
            <option value="p95Usd">95th percentile (safe)</option>
            <option value="avgUsd">Average</option>
          </select>
        </div>
      </div>
      <div className="table-wrap">
        <table data-testid="worksheet">
          <thead>
            <tr>
              <th scope="col">Depth</th>
              <th scope="col">Measured cost</th>
              <th scope="col">Suggested price</th>
              <th scope="col">Daily scan, a year: cost</th>
              <th scope="col">Daily scan, a year: price</th>
              <th scope="col">Current price</th>
            </tr>
          </thead>
          <tbody>
            {TIERS.map((t) => {
              const s = costs.byTier[t.id];
              const cost = s[basis];
              const price = suggestPrice(cost, margin / 100, floor);
              return (
                <tr key={t.id}>
                  <th scope="row">{t.name}</th>
                  <td>{s.runs ? usd(cost) : "no runs"}</td>
                  <td data-testid={`suggested-${t.id}`}>{s.runs ? usd(price) : "n/a"}</td>
                  <td>{s.runs ? usd(s.avgUsd * RUNS_PER_YEAR.daily) : "n/a"}</td>
                  <td>{s.runs ? usd(price * RUNS_PER_YEAR.daily) : "n/a"}</td>
                  <td className="muted">TBD</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const blankModel = { inputPerMTok: 0, outputPerMTok: 0 };

/** The versioned price table: edit, see what it would change, save as a new version. */
function PriceEditor({
  pricing,
  range,
  current,
}: {
  pricing: StaffPricing;
  range: { from: string; to: string; test?: "include" | "only" };
  current: CostAnalysis | undefined;
}) {
  const queryClient = useQueryClient();
  // A new version name that is not taken: today's date, or the date with a counter.
  const [draft, setDraft] = useState<StaffPriceTable>(() => {
    const taken = new Set(pricing.versions.map((v) => v.version));
    let version = today();
    for (let n = 2; taken.has(version); n += 1) version = `${today()}-${n}`;
    return { ...pricing.active, version };
  });
  const [note, setNote] = useState("");
  const [newModel, setNewModel] = useState("");
  const [preview, setPreview] = useState<CostAnalysis | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const num = (value: string) =>
    Number.isFinite(Number(value)) && value !== "" ? Number(value) : 0;

  const run = async (action: () => Promise<void>, failed: string) => {
    setMessage(null);
    try {
      await action();
    } catch (err) {
      setMessage({ text: messageFor(err, failed), error: true });
    }
  };

  return (
    <section className="card" aria-labelledby="prices-title">
      <h2 id="prices-title" className="card-title">
        Price table
      </h2>
      <p>
        In force: <strong data-testid="active-pricing">{pricing.active.version}</strong>
        {pricing.active.verified
          ? " (checked against AWS prices)"
          : " (not yet checked against AWS prices)"}
        . Every saved table is kept, and a run keeps the prices it was costed with.
      </p>
      <div className="actions-row">
        <div className="field">
          <label htmlFor="p-version">New version name</label>
          <input
            id="p-version"
            value={draft.version}
            onChange={(e) => setDraft({ ...draft, version: e.target.value })}
          />
        </div>
        <div className="field">
          <label htmlFor="p-vcpu">Compute per vCPU hour (US$)</label>
          <input
            id="p-vcpu"
            type="number"
            step="any"
            value={draft.fargate.vcpuPerHour}
            onChange={(e) =>
              setDraft({
                ...draft,
                fargate: { ...draft.fargate, vcpuPerHour: num(e.target.value) },
              })
            }
          />
        </div>
        <div className="field">
          <label htmlFor="p-gb">Compute per GB hour (US$)</label>
          <input
            id="p-gb"
            type="number"
            step="any"
            value={draft.fargate.gbPerHour}
            onChange={(e) =>
              setDraft({ ...draft, fargate: { ...draft.fargate, gbPerHour: num(e.target.value) } })
            }
          />
        </div>
        <div className="field">
          <label htmlFor="p-egress">Data out per GB (US$)</label>
          <input
            id="p-egress"
            type="number"
            step="any"
            value={draft.egressPerGb}
            onChange={(e) => setDraft({ ...draft, egressPerGb: num(e.target.value) })}
          />
        </div>
        <div className="field">
          <label htmlFor="p-sfn">Per state transition (US$)</label>
          <input
            id="p-sfn"
            type="number"
            step="any"
            value={draft.stepFunctionsPerTransition}
            onChange={(e) =>
              setDraft({ ...draft, stepFunctionsPerTransition: num(e.target.value) })
            }
          />
        </div>
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th scope="col">Model</th>
              <th scope="col">Input per million tokens (US$)</th>
              <th scope="col">Output per million tokens (US$)</th>
            </tr>
          </thead>
          <tbody>
            {Object.entries(draft.bedrock).map(([model, price]) => (
              <tr key={model}>
                <th scope="row">{model}</th>
                <td>
                  <input
                    aria-label={`Input price for ${model}`}
                    type="number"
                    step="any"
                    value={price.inputPerMTok}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        bedrock: {
                          ...draft.bedrock,
                          [model]: { ...price, inputPerMTok: num(e.target.value) },
                        },
                      })
                    }
                  />
                </td>
                <td>
                  <input
                    aria-label={`Output price for ${model}`}
                    type="number"
                    step="any"
                    value={price.outputPerMTok}
                    onChange={(e) =>
                      setDraft({
                        ...draft,
                        bedrock: {
                          ...draft.bedrock,
                          [model]: { ...price, outputPerMTok: num(e.target.value) },
                        },
                      })
                    }
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="actions-row">
        <div className="field">
          <label htmlFor="p-model">Add a model</label>
          <input
            id="p-model"
            value={newModel}
            placeholder="au.anthropic.claude-…"
            onChange={(e) => setNewModel(e.target.value)}
          />
        </div>
        <button
          type="button"
          className="btn"
          disabled={newModel.trim() === "" || newModel.trim() in draft.bedrock}
          onClick={() => {
            setDraft({ ...draft, bedrock: { ...draft.bedrock, [newModel.trim()]: blankModel } });
            setNewModel("");
          }}
        >
          Add model
        </button>
      </div>
      <label className="check">
        <input
          type="checkbox"
          checked={draft.verified}
          onChange={(e) => setDraft({ ...draft, verified: e.target.checked })}
        />
        These prices have been checked against the current AWS price list
      </label>
      <div className="field">
        <label htmlFor="p-note">Note for the audit log</label>
        <input id="p-note" value={note} onChange={(e) => setNote(e.target.value)} />
      </div>
      <div className="actions-row">
        <button
          type="button"
          className="btn"
          onClick={() =>
            run(
              async () => setPreview(await api.staff.previewCosts(draft, range)),
              "Could not preview the table.",
            )
          }
        >
          Preview the effect
        </button>
        <button
          type="button"
          className="btn btn-primary"
          onClick={() =>
            run(async () => {
              await api.staff.savePricing(draft, note);
              setPreview(null);
              setMessage({
                text: `Saved ${draft.version}. New runs are costed with it.`,
                error: false,
              });
              await queryClient.invalidateQueries({ queryKey: ["staff-pricing"] });
              await queryClient.invalidateQueries({ queryKey: ["staff-costs"] });
            }, "Could not save the table.")
          }
        >
          Save as a new version
        </button>
      </div>
      {message && (
        <p className={message.error ? "error" : "hint"} role={message.error ? "alert" : "status"}>
          {message.text}
        </p>
      )}
      {preview && (
        <p data-testid="price-preview">
          The same {preview.runs} runs would cost <strong>{usd(preview.totalUsd)}</strong> at{" "}
          {draft.version}
          {current ? `, against ${usd(current.totalUsd)} now` : ""}.
          {preview.notRepriced > 0 &&
            ` ${preview.notRepriced} older runs keep their recorded cost.`}
        </p>
      )}
      <h3>Versions</h3>
      <ul data-testid="price-versions">
        {pricing.versions.map((v) => (
          <li key={v.version}>
            <strong>{v.version}</strong>{" "}
            {v.shipped ? "(shipped with the code)" : `saved by ${v.by}`}
            {v.note ? `: ${v.note}` : ""}
          </li>
        ))}
      </ul>
    </section>
  );
}
