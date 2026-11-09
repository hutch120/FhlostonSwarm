import { TIERS } from "@swarm/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router";
import { api, messageFor } from "../api/client.js";
import { useSession } from "../state/session.js";

const CONFIRM_WORD = "DELETE";

export function Account() {
  const { email, role } = useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [typed, setTyped] = useState("");
  const [codeSent, setCodeSent] = useState(false);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const account = useQuery({ queryKey: ["account"], queryFn: () => api.getAccount() });

  const sendCode = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.requestAccountDeletion();
      setCodeSent(true);
    } catch (err) {
      setError(messageFor(err, "Could not send the code. Try again."));
    } finally {
      setBusy(false);
    }
  };

  const deleteAccount = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.deleteAccount(code);
      useSession.getState().setAnonymous();
      queryClient.clear();
      navigate("/login");
    } catch (err) {
      setError(messageFor(err, "Could not delete the account."));
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <h1>Account</h1>
      </div>

      <section className="card" aria-labelledby="profile-title">
        <h2 id="profile-title" className="card-title">
          Profile
        </h2>
        <p>
          Signed in as <strong>{email}</strong>
          {role === "staff" && <span className="badge"> Staff</span>}
        </p>
        <p data-testid="account-credits">
          {account.data
            ? TIERS.map((t) => `${account.data.credits[t.id]} ${t.name}`).join(" · ") + " credits"
            : "Loading…"}
        </p>
      </section>

      <section className="card danger-zone" aria-labelledby="delete-title">
        <h2 id="delete-title" className="card-title">
          Delete account
        </h2>
        <p>
          Deleting your account removes every saved target and login, scan, run, report, piece of
          evidence and credit we hold for you, and signs you out everywhere. This cannot be undone.
          Anonymised cost figures (depth, timings, token counts, cost; never your email, targets or
          findings) are kept for cost analysis. See the privacy notice for what else is kept.
        </p>
        <div className="field">
          <label htmlFor="confirm-delete">
            Type <code>{CONFIRM_WORD}</code> to confirm
          </label>
          <input
            id="confirm-delete"
            autoComplete="off"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
        </div>
        {!codeSent ? (
          <button
            type="button"
            className="btn btn-danger"
            disabled={typed !== CONFIRM_WORD || busy}
            onClick={sendCode}
          >
            Email me a deletion code
          </button>
        ) : (
          <>
            <div className="field">
              <label htmlFor="delete-code">6-digit code from the email we sent to {email}</label>
              <input
                id="delete-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              />
            </div>
            <button
              type="button"
              className="btn btn-danger"
              disabled={typed !== CONFIRM_WORD || code.length !== 6 || busy}
              onClick={deleteAccount}
            >
              Delete my account
            </button>
          </>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
      </section>
    </>
  );
}
