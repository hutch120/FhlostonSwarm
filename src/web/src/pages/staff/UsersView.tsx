import { TIERS, tiers, type StaffAccount, type TierId } from "@swarm/shared";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";
import { api, messageFor } from "../../api/client.js";
import { formatDateTime } from "../../format.js";
import { SOURCE_LABELS } from "./format.js";

/** Look an account up by email: credits, saved scans and runs, and the support actions. */
export function UsersView() {
  const queryClient = useQueryClient();
  const [email, setEmail] = useState("");
  const [account, setAccount] = useState<StaffAccount | null>(null);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [tier, setTier] = useState<TierId>("scout");
  const [count, setCount] = useState(1);
  const [reason, setReason] = useState("");
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleteReason, setDeleteReason] = useState("");

  const say = (text: string, error = false) => setMessage({ text, error });

  const find = async (address: string) => {
    setMessage(null);
    try {
      setAccount(await api.staff.account(address));
    } catch (err) {
      setAccount(null);
      say(messageFor(err, "Could not look that up."), true);
    }
  };

  /** Runs an action on the open account and reloads it (unless the action removes it). */
  const act = async (
    action: (a: StaffAccount) => Promise<void>,
    done: string,
    failed: string,
    options: { reload?: boolean } = {},
  ): Promise<boolean> => {
    if (!account) return false;
    setMessage(null);
    try {
      await action(account);
      say(done);
      if (options.reload !== false) setAccount(await api.staff.account(account.email));
      await queryClient.invalidateQueries({ queryKey: ["staff-runs"] });
      return true;
    } catch (err) {
      say(messageFor(err, failed), true);
      return false;
    }
  };

  return (
    <>
      <section className="card" aria-labelledby="lookup-title">
        <h2 id="lookup-title" className="card-title">
          Find a user
        </h2>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void find(email);
          }}
        >
          <div className="field">
            <label htmlFor="u-email">Email address</label>
            <input
              id="u-email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              autoComplete="off"
            />
          </div>
          <button type="submit" className="btn btn-primary" disabled={email.trim() === ""}>
            Look up
          </button>
        </form>
        <p className="muted small">
          The address is turned into the account key on the server. Saved passwords are never shown.
        </p>
        {message && (
          <p className={message.error ? "error" : "hint"} role={message.error ? "alert" : "status"}>
            {message.text}
          </p>
        )}
      </section>

      {account && (
        <>
          <section className="card" aria-labelledby="account-title" data-testid="staff-account">
            <h2 id="account-title" className="card-title">
              {account.email}
              {account.test && <span className="badge"> test</span>}
            </h2>
            <dl className="kv">
              <dt>Role</dt>
              <dd>{account.role}</dd>
              <dt>Account key</dt>
              <dd>
                <code>{account.accountHash.slice(0, 12)}…</code>
              </dd>
              <dt>Joined</dt>
              <dd>
                {account.createdAt
                  ? formatDateTime(new Date(account.createdAt).toISOString())
                  : "n/a"}
              </dd>
              <dt>Last signed in</dt>
              <dd>
                {account.lastLoginAt
                  ? formatDateTime(new Date(account.lastLoginAt).toISOString())
                  : "n/a"}
              </dd>
              <dt>Saved targets</dt>
              <dd>{account.targets}</dd>
              <dt>Credits left</dt>
              <dd data-testid="staff-credits">
                {TIERS.map((t) => `${account.credits[t.id]} ${t.name}`).join(" · ")}
              </dd>
            </dl>
          </section>

          <section className="card" aria-labelledby="grant-title">
            <h3 id="grant-title" className="card-title">
              Grant a complimentary credit
            </h3>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void act(
                  (a) => api.staff.grantCredit(a.accountHash, { tier, count, reason }),
                  `Granted ${count} ${tiers[tier].name} credit${count === 1 ? "" : "s"}.`,
                  "Could not grant the credit.",
                ).then(() => setReason(""));
              }}
            >
              <div className="actions-row">
                <div className="field">
                  <label htmlFor="g-tier">Depth</label>
                  <select
                    id="g-tier"
                    value={tier}
                    onChange={(e) => setTier(e.target.value as TierId)}
                  >
                    {TIERS.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label htmlFor="g-count">How many</label>
                  <input
                    id="g-count"
                    type="number"
                    min={1}
                    max={100}
                    value={count}
                    onChange={(e) => setCount(Number(e.target.value))}
                  />
                </div>
                <div className="field">
                  <label htmlFor="g-reason">Reason (kept in the audit log)</label>
                  <input id="g-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
                </div>
              </div>
              <button
                type="submit"
                className="btn btn-primary"
                disabled={reason.trim().length < 3 || count < 1}
              >
                Grant credit
              </button>
            </form>
            <h4>Earlier grants</h4>
            {account.ledger.grants.length === 0 ? (
              <p className="muted">None.</p>
            ) : (
              <ul data-testid="staff-grants">
                {[...account.ledger.grants].reverse().map((g, i) => (
                  <li key={i}>
                    {g.count} {tiers[g.tier].name} ({g.source}): {g.reason}, by {g.by}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card" aria-labelledby="scans-title">
            <h3 id="scans-title" className="card-title">
              Saved scans
            </h3>
            {account.scans.length === 0 ? (
              <p className="muted">None.</p>
            ) : (
              <div className="table-wrap">
                <table data-testid="staff-scans">
                  <thead>
                    <tr>
                      <th scope="col">Scan</th>
                      <th scope="col">Target</th>
                      <th scope="col">Depth</th>
                      <th scope="col">How often</th>
                      <th scope="col">Status</th>
                      <th scope="col">Notices</th>
                      <th scope="col">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {account.scans.map((s) => (
                      <tr key={s.id}>
                        <th scope="row">{s.name}</th>
                        <td>{s.target}</td>
                        <td>{tiers[s.tier].name}</td>
                        <td>{s.frequency}</td>
                        <td>{s.status}</td>
                        <td>
                          {s.notifyOn}
                          {s.notifyConfirmed ? "" : " (address not confirmed)"}
                        </td>
                        <td className="actions">
                          <button
                            type="button"
                            className="btn btn-ghost"
                            onClick={() =>
                              act(
                                (a) =>
                                  api.staff.setScanStatus(
                                    a.accountHash,
                                    s.id,
                                    s.status === "active" ? "paused" : "active",
                                  ),
                                s.status === "active" ? "Scan paused." : "Scan resumed.",
                                "Could not change the scan.",
                              )
                            }
                          >
                            {s.status === "active" ? "Pause" : "Resume"}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card" aria-labelledby="user-runs-title">
            <h3 id="user-runs-title" className="card-title">
              Runs
            </h3>
            {account.runs.length === 0 ? (
              <p className="muted">None.</p>
            ) : (
              <div className="table-wrap">
                <table data-testid="staff-user-runs">
                  <thead>
                    <tr>
                      <th scope="col">Started (UTC)</th>
                      <th scope="col">Depth</th>
                      <th scope="col">Status</th>
                      <th scope="col">Paid by</th>
                    </tr>
                  </thead>
                  <tbody>
                    {account.runs.map((r) => (
                      <tr key={r.runId}>
                        <th scope="row">
                          <Link to={`/staff/runs/${r.runId}`}>{formatDateTime(r.startedAt)}</Link>
                        </th>
                        <td>{tiers[r.tier].name}</td>
                        <td>{r.status}</td>
                        <td>{SOURCE_LABELS[r.entitlement]}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <section className="card danger-zone" aria-labelledby="delete-account-title">
            <h3 id="delete-account-title" className="card-title">
              Delete this account
            </h3>
            <p>
              On the customer's request. Everything saved for the account is removed and its runs
              are stopped; only anonymised cost records and the audit log remain.
            </p>
            {confirmingDelete ? (
              <>
                <div className="field">
                  <label htmlFor="d-reason">Reason (kept in the audit log)</label>
                  <input
                    id="d-reason"
                    value={deleteReason}
                    onChange={(e) => setDeleteReason(e.target.value)}
                  />
                </div>
                <div className="actions-row">
                  <button
                    type="button"
                    className="btn btn-danger"
                    disabled={deleteReason.trim().length < 3}
                    onClick={async () => {
                      const deleted = await act(
                        (a) => api.staff.deleteAccount(a.accountHash, deleteReason),
                        "The account was deleted.",
                        "Could not delete the account.",
                        { reload: false },
                      );
                      if (!deleted) return;
                      setAccount(null);
                      setConfirmingDelete(false);
                      setDeleteReason("");
                    }}
                  >
                    Delete the account
                  </button>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    onClick={() => setConfirmingDelete(false)}
                  >
                    Cancel
                  </button>
                </div>
              </>
            ) : (
              <button
                type="button"
                className="btn btn-danger"
                onClick={() => setConfirmingDelete(true)}
              >
                Delete account…
              </button>
            )}
          </section>
        </>
      )}
    </>
  );
}
