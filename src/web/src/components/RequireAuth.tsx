import { Navigate, Outlet, useLocation } from "react-router";
import { useSession } from "../state/session.js";

/** Sends signed-out visitors to the login screen and returns them here afterwards. */
export function RequireAuth() {
  const status = useSession((s) => s.status);
  const location = useLocation();

  if (status === "loading") {
    return (
      <p className="muted" role="status">
        Loading…
      </p>
    );
  }
  if (status === "anonymous") {
    return <Navigate to="/login" replace state={{ from: location.pathname + location.search }} />;
  }
  return <Outlet />;
}
