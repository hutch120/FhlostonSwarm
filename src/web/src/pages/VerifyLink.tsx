import { useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { api, messageFor } from "../api/client.js";
import { useSession } from "../state/session.js";

/** Magic-link landing page. The sign-in happens on a click, so link scanners cannot use the link up. */
export function VerifyLink() {
  const [params] = useSearchParams();
  const token = params.get("token");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const setUser = useSession((s) => s.setUser);
  const navigate = useNavigate();

  const confirm = async () => {
    if (!token) return;
    setBusy(true);
    setError(null);
    try {
      const { user, csrfToken } = await api.verifyLink(token);
      setUser(user, csrfToken);
      navigate("/dashboard", { replace: true });
    } catch (err) {
      setError(messageFor(err, "That link did not work. Request a new code."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card narrow" aria-labelledby="verify-title">
      <h1 id="verify-title">Confirm sign-in</h1>
      {token ? (
        <>
          <p className="muted">Continue to finish signing in to Swarm on this device.</p>
          <button type="button" className="btn btn-primary" disabled={busy} onClick={confirm}>
            Sign in
          </button>
        </>
      ) : (
        <p>This sign-in link is incomplete. Request a new code from the sign-in page.</p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
