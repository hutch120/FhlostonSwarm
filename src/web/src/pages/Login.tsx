import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router";
import { api } from "../api/client.js";
import { useSession } from "../state/session.js";

export function Login() {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const signIn = useSession((s) => s.signIn);
  const navigate = useNavigate();

  const requestCode = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.requestCode(email);
      setStep("code");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send the code");
    } finally {
      setBusy(false);
    }
  };

  const verify = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const result = await api.verifyCode(email, code);
      signIn(result.email);
      navigate("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "That code did not work");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card narrow" aria-labelledby="login-title">
      <h1 id="login-title">Sign in</h1>
      <p className="muted">
        We email you a 6-digit code. No passwords. New accounts get one free Lite report.
      </p>
      <p className="notice" role="note">
        Preview: there is no backend yet, so no email is sent and any 6-digit code is accepted.
      </p>

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
            Code sent to <strong>{email}</strong>.{" "}
            <button type="button" className="link" onClick={() => setStep("email")}>
              Use a different email
            </button>
          </p>
          <div className="field">
            <label htmlFor="code">6-digit code</label>
            <input
              id="code"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              required
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
            />
          </div>
          <button type="submit" className="btn btn-primary" disabled={busy || code.length !== 6}>
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
