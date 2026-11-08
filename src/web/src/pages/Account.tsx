import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useNavigate } from "react-router";
import { api } from "../api/client.js";
import { useSession } from "../state/session.js";

const CONFIRM_WORD = "DELETE";

export function Account() {
  const { email, role } = useSession();
  const navigate = useNavigate();
  const [typed, setTyped] = useState("");
  const account = useQuery({ queryKey: ["account"], queryFn: () => api.getAccount() });

  const deleteAccount = async () => {
    await api.deleteAccount();
    useSession.getState().setAnonymous();
    navigate("/login");
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
        <p data-testid="free-report">
          {account.data
            ? account.data.freeLiteRemaining > 0
              ? `${account.data.freeLiteRemaining} free Lite report available`
              : "Your free Lite report has been used"
            : "Loading…"}
        </p>
      </section>

      <section className="card danger-zone" aria-labelledby="delete-title">
        <h2 id="delete-title" className="card-title">
          Delete account
        </h2>
        <p>
          Deleting your account removes every run, report, piece of evidence and credential we hold
          for you. This cannot be undone. Anonymised cost figures (tier, timings, token counts,
          cost; never your email, targets or findings) are kept for cost analysis.
        </p>
        <p className="notice" role="note">
          Preview: nothing is stored, so there is nothing to delete yet.
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
        <button
          type="button"
          className="btn btn-danger"
          disabled={typed !== CONFIRM_WORD}
          onClick={deleteAccount}
        >
          Delete my account
        </button>
      </section>
    </>
  );
}
