import { useQueryClient } from "@tanstack/react-query";
import { NavLink, Outlet, Link, useNavigate } from "react-router";
import { api } from "../api/client.js";
import { useSession } from "../state/session.js";

const NAV = [
  { to: "/dashboard", label: "Dashboard" },
  { to: "/new", label: "New assessment" },
  { to: "/demo", label: "Live demo" },
  { to: "/scans", label: "Scans" },
  { to: "/account", label: "Account" },
] as const;

export function Layout() {
  const { email, role } = useSession();
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  // The server revokes the session; the page then forgets everything it cached for this user.
  const signOut = async () => {
    try {
      await api.logout();
    } catch {
      // Offline or the server is unreachable: still drop local state; the session expires on its own.
    }
    useSession.getState().setAnonymous();
    queryClient.clear();
    navigate("/login");
  };

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        Skip to content
      </a>
      <header className="topbar">
        <Link to="/" className="brand" aria-label="Swarm home">
          <img className="brand-mark" src="/favicon.svg" alt="" aria-hidden="true" />
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
        <span>
          <Link to="/terms">Terms</Link> · <Link to="/privacy">Privacy</Link>
        </span>
      </footer>
    </div>
  );
}
