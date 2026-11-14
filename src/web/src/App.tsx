import { DEMO_RUN_ID } from "@swarm/shared";
import { useEffect } from "react";
import { Link, Route, Routes, useParams } from "react-router";
import { privacy, terms } from "../content/legal.js";
import { api } from "./api/client.js";
import { Layout } from "./components/Layout.js";
import { RequireAuth } from "./components/RequireAuth.js";
import { Account } from "./pages/Account.js";
import { Dashboard } from "./pages/Dashboard.js";
import { Intake } from "./pages/Intake.js";
import { Landing } from "./pages/Landing.js";
import { Legal } from "./pages/Legal.js";
import { LiveRun } from "./pages/LiveRun.js";
import { Login } from "./pages/Login.js";
import { NotifyConfirm } from "./pages/NotifyConfirm.js";
import { RunView } from "./pages/RunView.js";
import { Report } from "./pages/Report.js";
import { Scans } from "./pages/Scans.js";
import { Staff } from "./pages/Staff.js";
import { VerifyLink } from "./pages/VerifyLink.js";
import { useSession } from "./state/session.js";

/** The scripted demo replays in the live view; a real run follows its own event stream. */
function RunPage() {
  const { runId = "" } = useParams();
  return runId === DEMO_RUN_ID ? <LiveRun /> : <RunView runId={runId} />;
}

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
        <Route index element={<Landing />} />
        <Route path="login" element={<Login />} />
        <Route path="auth/verify" element={<VerifyLink />} />
        <Route path="notify/confirm" element={<NotifyConfirm />} />
        <Route path="terms" element={<Legal doc={terms} testId="terms" />} />
        <Route path="privacy" element={<Legal doc={privacy} testId="privacy" />} />
        <Route path="demo" element={<LiveRun />} />
        <Route element={<RequireAuth />}>
          <Route path="dashboard" element={<Dashboard />} />
          <Route path="new" element={<Intake />} />
          <Route path="runs/:runId" element={<RunPage />} />
          <Route path="runs/:runId/report" element={<Report />} />
          <Route path="scans" element={<Scans />} />
          <Route path="scans/:scanId/edit" element={<Intake />} />
          <Route path="account" element={<Account />} />
        </Route>
        <Route path="staff/*" element={<Staff />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
