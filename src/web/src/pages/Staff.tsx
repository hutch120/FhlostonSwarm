import { useQuery } from "@tanstack/react-query";
import { Suspense, lazy } from "react";
import { Link } from "react-router";
import { api } from "../api/client.js";
import { useSession } from "../state/session.js";

// A separate chunk: it carries dollars and caps, so it is only fetched once the server has said yes.
const StaffScreens = lazy(() => import("./staff/StaffScreens.js"));

/**
 * Staff area. The role here only decides what to show: the server re-checks it on every request, and
 * this page asks it (/api/staff/whoami) before loading anything.
 */
export function Staff() {
  const { status, role } = useSession();
  const whoami = useQuery({
    queryKey: ["staff-whoami"],
    queryFn: () => api.staffWhoami(),
    enabled: role === "staff",
    retry: false,
  });

  if (status === "loading") {
    return (
      <p className="muted" role="status">
        Loading…
      </p>
    );
  }

  if (role !== "staff" || whoami.isError) {
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
      <div data-testid="staff-home">
        <p className="muted" data-testid="staff-verified">
          {whoami.data ? `The server confirmed you as staff (${whoami.data.email}).` : "Checking…"}
        </p>
        {whoami.data && (
          <Suspense
            fallback={
              <p className="muted" role="status">
                Loading…
              </p>
            }
          >
            <StaffScreens />
          </Suspense>
        )}
      </div>
    </>
  );
}
