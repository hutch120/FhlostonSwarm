import { useState } from "react";
import { Link, useSearchParams } from "react-router";
import { api, messageFor } from "../api/client.js";

/**
 * Landing page for the link mailed to a notification address. The address's owner may not have an
 * account or be signed in, so the token alone proves control of the mailbox. Confirming happens on
 * a click, so mail scanners that follow links cannot use the link up.
 */
export function NotifyConfirm() {
  const [params] = useSearchParams();
  const token = params.get("token");
  const [state, setState] = useState<"idle" | "busy" | "done">("idle");
  const [error, setError] = useState<string | null>(null);

  const confirm = async () => {
    if (!token) return;
    setState("busy");
    setError(null);
    try {
      await api.confirmNotify(token);
      setState("done");
    } catch (err) {
      setError(messageFor(err, "That link did not work."));
      setState("idle");
    }
  };

  return (
    <section className="card narrow" aria-labelledby="confirm-title">
      <h1 id="confirm-title">Confirm notification address</h1>
      {state === "done" ? (
        <p role="status" data-testid="notify-confirmed">
          Thank you. This address will now receive the scan notices it was set up for. Every notice
          includes a link to stop them.
        </p>
      ) : token ? (
        <>
          <p className="muted">
            A Swarm user asked us to send security scan notices to this address. Confirm to start
            receiving them. If this is not for you, close this page and nothing will be sent.
          </p>
          <button
            type="button"
            className="btn btn-primary"
            disabled={state === "busy"}
            onClick={confirm}
          >
            Confirm this address
          </button>
        </>
      ) : (
        <p>This confirmation link is incomplete. Use the link in the email we sent.</p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <p className="muted small">
        <Link to="/privacy">Privacy notice</Link>
      </p>
    </section>
  );
}
