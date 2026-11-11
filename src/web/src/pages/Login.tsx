import { useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { api, messageFor } from "../api/client.js";
import { useSession } from "../state/session.js";

export function Login() {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const setUser = useSession((s) => s.setUser);
  const navigate = useNavigate();
  const from = (useLocation().state as { from?: string } | null)?.from ?? "/dashboard";

  const requestCode = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.requestCode(email);
      setStep("code");
    } catch (err) {
      setError(messageFor(err, "Could not send the code. Try again."));
    } finally {
      setBusy(false);
    }
  };

  const verify = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const { user, csrfToken } = await api.verifyCode(email, code);
      setUser(user, csrfToken);
      navigate(from, { replace: true });
    } catch (err) {
      setError(messageFor(err, "That code did not work."));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card narrow" aria-labelledby="login-title">
      <h1 id="login-title">Sign in</h1>
      <p className="muted">We email you a 6-digit code. No passwords.</p>

      {step === "email" ? (
        <form onSubmit={requestCode} noValidate={false}>
          <div className="field">
            <label htmlFor="email">Email address</label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            Email me a code
          </button>
        </form>
      ) : (
        <form onSubmit={verify}>
          <p>
            If <strong>{email}</strong> can receive mail, a code is on its way. It expires in 10
            minutes. Testing? Enter a test passcode from your Account page instead.{" "}
            <button type="button" className="link" onClick={() => setStep("email")}>
              Use a different email
            </button>
          </p>
          <div className="field">
            <label htmlFor="code">6-digit code or test passcode</label>
            <input
              id="code"
              autoComplete="one-time-code"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={32}
              required
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/[^A-Za-z0-9 -]/g, ""))}
            />
          </div>
          <button
            type="submit"
            className="btn btn-primary"
            disabled={busy || code.trim().length < 6}
          >
            Sign in
          </button>
        </form>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
