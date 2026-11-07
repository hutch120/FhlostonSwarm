import { NavLink, Outlet, Link } from "react-router";
import { useSession } from "../state/session.js";

const NAV = [
  { to: "/dashboard", label: "Dashboard" },
  { to: "/new", label: "New assessment" },
  { to: "/demo", label: "Live demo" },
  { to: "/schedules", label: "Schedules" },
  { to: "/account", label: "Account" },
] as const;

export function Layout() {
  const { email, role, signOut } = useSession();
  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <Link to="/" className="brand" aria-label="Swarm home">
          <span className="brand-mark" aria-hidden="true" />
          Swarm
        </Link>
        <nav aria-label="Main">
          <ul className="nav">
            {NAV.map((item) => (
              <li key={item.to}>
                <NavLink to={item.to}>{item.label}</NavLink>
              </li>
            ))}
            {role === "staff" && (
              <li>
                <NavLink to="/staff">Staff</NavLink>
              </li>
            )}
          </ul>
        </nav>
        <div className="session">
          {email ? (
            <>
              <span className="muted session-email">{email}</span>
              <button type="button" className="btn btn-ghost" onClick={signOut}>
                Sign out
              </button>
            </>
          ) : (
            <Link to="/login" className="btn">
              Sign in
            </Link>
          )}
        </div>
      </header>
      <main id="main" className="main">
        <Outlet />
      </main>
      <footer className="footer">
        <span>Swarm, a Fhloston Advisory product.</span>
        <span>
          Automated, AI-assisted assessment. Not a certification and not a substitute for a manual
          penetration test.
        </span>
      </footer>
    </div>
  );
}
