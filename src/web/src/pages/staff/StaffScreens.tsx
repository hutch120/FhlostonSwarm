import { NavLink, Route, Routes } from "react-router";
import { ControlsView } from "./ControlsView.js";
import { CostView } from "./CostView.js";
import { HealthView } from "./HealthView.js";
import { RunDetail } from "./RunDetail.js";
import { RunsView } from "./RunsView.js";
import { UsersView } from "./UsersView.js";

const TABS = [
  { to: "/staff", label: "Runs", end: true },
  { to: "/staff/costs", label: "Cost analysis", end: false },
  { to: "/staff/users", label: "Users and support", end: false },
  { to: "/staff/controls", label: "Controls", end: false },
  { to: "/staff/health", label: "Health", end: false },
] as const;

/**
 * The staff screens. Loaded as their own chunk, only after the server has confirmed the role, so a
 * customer's browser never downloads them. Every call they make is checked again by the server.
 */
export default function StaffScreens() {
  return (
    <>
      <nav aria-label="Staff">
        <ul className="nav subnav">
          {TABS.map((tab) => (
            <li key={tab.to}>
              <NavLink to={tab.to} end={tab.end}>
                {tab.label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
      <Routes>
        <Route index element={<RunsView />} />
        <Route path="runs/:runId" element={<RunDetail />} />
        <Route path="costs" element={<CostView />} />
        <Route path="users" element={<UsersView />} />
        <Route path="controls" element={<ControlsView />} />
        <Route path="health" element={<HealthView />} />
        <Route path="*" element={<p className="muted">That staff screen does not exist.</p>} />
      </Routes>
    </>
  );
}
