import { useEffect } from "react";
import { Link, Navigate, Route, Routes } from "react-router";
import { api } from "./api/client.js";
import { Layout } from "./components/Layout.js";
import { RequireAuth } from "./components/RequireAuth.js";
import { Account } from "./pages/Account.js";
import { Dashboard } from "./pages/Dashboard.js";
import { Intake } from "./pages/Intake.js";
import { LiveRun } from "./pages/LiveRun.js";
import { Login } from "./pages/Login.js";
import { Report } from "./pages/Report.js";
import { Scans } from "./pages/Scans.js";
import { Staff } from "./pages/Staff.js";
import { VerifyLink } from "./pages/VerifyLink.js";
import { useSession } from "./state/session.js";

function NotFound() {
  return (
    <section className="card narrow">
      <h1>Page not found</h1>
      <p>
        <Link to="/dashboard">Back to the dashboard</Link>
      </p>
    </section>
  );
}

/** Asks the server who we are (the session lives in HttpOnly cookies) once on load. */
function useSessionBootstrap() {
  useEffect(() => {
    const { status, setUser, setAnonymous } = useSession.getState();
    if (status !== "loading") return;
    api
      .getSession()
      .then((s) =>
        s.authenticated && s.user && s.csrfToken ? setUser(s.user, s.csrfToken) : setAnonymous(),
      )
      .catch(() => setAnonymous());
  }, []);
}

export function App() {
  useSessionBootstrap();
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="login" element={<Login />} />
        <Route path="auth/verify" element={<VerifyLink />} />
        <Route path="demo" element={<LiveRun />} />
        <Route element={<RequireAuth />}>
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="new" element={<Intake />} />
          <Route path="runs/:runId" element={<LiveRun />} />
          <Route path="runs/:runId/report" element={<Report />} />
          <Route path="scans" element={<Scans />} />
          <Route path="schedules" element={<Navigate to="/scans" replace />} />
          <Route path="account" element={<Account />} />
        </Route>
        <Route path="staff" element={<Staff />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
