import { Link } from "react-router";
import { useSession } from "../state/session.js";

const VIEWS = [
  "Runs",
  "Run detail",
  "Cost analysis",
  "Users and support",
  "Controls",
  "Health",
] as const;

/** Gated placeholder. The role check that matters is server-side (Phase 3); this only hides the UI. */
export function Staff() {
  const role = useSession((s) => s.role);

  if (role !== "staff") {
    return (
      <section className="card narrow" aria-labelledby="staff-title" data-testid="staff-denied">
        <h1 id="staff-title">Staff only</h1>
        <p>This area is for Swarm staff. Sign in with a staff email address to continue.</p>
        <Link to="/login" className="btn">
          Sign in
        </Link>
      </section>
    );
  }

  return (
    <>
      <div className="page-head">
        <h1>Staff</h1>
      </div>
      <section className="card" aria-labelledby="views-title" data-testid="staff-home">
        <h2 id="views-title" className="card-title">
          Planned views
        </h2>
        <p className="muted">Placeholder. These arrive with the staff dashboard phase.</p>
        <ul>
          {VIEWS.map((v) => (
            <li key={v}>{v}</li>
          ))}
        </ul>
      </section>
    </>
  );
}
