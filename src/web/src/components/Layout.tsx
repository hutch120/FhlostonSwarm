import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { NavLink, Outlet, Link, useLocation, useNavigate } from "react-router";
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
  const location = useLocation();
  // On a narrow screen the nav and session controls sit behind a toggle. The menu is open for
  // the page it was opened on, so following a link closes it.
  const [openAt, setOpenAt] = useState<string | null>(null);
  const menuOpen = openAt === location.pathname;
  const setMenuOpen = (open: boolean) => setOpenAt(open ? location.pathname : null);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpenAt(null);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [menuOpen]);
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
        <button
          type="button"
          className="btn btn-ghost menu-toggle"
          aria-expanded={menuOpen}
          aria-controls="site-menu"
          onClick={() => setMenuOpen(!menuOpen)}
        >
          <svg width="20" height="20" viewBox="0 0 20 20" aria-hidden="true" focusable="false">
            <path
              d={menuOpen ? "M4 4l12 12M16 4L4 16" : "M3 5h14M3 10h14M3 15h14"}
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              fill="none"
            />
          </svg>
          <span>Menu</span>
        </button>
        <div id="site-menu" className="menu" data-open={menuOpen}>
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
        </div>
      </header>
      <main id="main" className="main">
        <Outlet />
      </main>
      <footer className="footer">
        <span>Swarm, a Fhloston Advisory product.</span>
        <span>Automated, AI-assisted assessment.</span>
        <span>
          <Link to="/terms">Terms</Link> · <Link to="/privacy">Privacy</Link>
        </span>
      </footer>
    </div>
  );
}
