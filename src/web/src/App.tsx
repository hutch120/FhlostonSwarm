import { Link, Navigate, Route, Routes } from "react-router";
import { Layout } from "./components/Layout.js";
import { Account } from "./pages/Account.js";
import { Dashboard } from "./pages/Dashboard.js";
import { Intake } from "./pages/Intake.js";
import { LiveRun } from "./pages/LiveRun.js";
import { Login } from "./pages/Login.js";
import { Report } from "./pages/Report.js";
import { Schedules } from "./pages/Schedules.js";
import { Staff } from "./pages/Staff.js";

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

export function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="login" element={<Login />} />
        <Route path="dashboard" element={<Dashboard />} />
        <Route path="new" element={<Intake />} />
        <Route path="demo" element={<LiveRun />} />
        <Route path="runs/:runId" element={<LiveRun />} />
        <Route path="runs/:runId/report" element={<Report />} />
        <Route path="schedules" element={<Schedules />} />
        <Route path="account" element={<Account />} />
        <Route path="staff" element={<Staff />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}
