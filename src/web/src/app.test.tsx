import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "./App.js";
import { ApiError, mockApi, setApi } from "./api/client.js";
import { useSession } from "./state/session.js";
import { renderWithProviders } from "./test/render.js";

const EMAILS = { customer: "buyer@example.com", staff: "ops@fhlostonswarm.com" } as const;

// Signed in as a customer unless a test says otherwise (the store is reset before each test).
const renderApp = (route: string, as: keyof typeof EMAILS | null = "customer") => {
  if (as) useSession.getState().setUser({ email: EMAILS[as], role: as }, "csrf");
  return renderWithProviders(<App />, { route });
};

describe("Login", () => {
  it("signs in with an email and a 6-digit code", async () => {
    renderApp("/login", null);
    await userEvent.type(screen.getByLabelText(/email address/i), "buyer@example.com");
    await userEvent.click(screen.getByRole("button", { name: /email me a code/i }));
    const code = await screen.findByLabelText(/6-digit code/i);
    const submit = screen.getByRole("button", { name: "Sign in" });
    expect(submit).toBeDisabled();
    await userEvent.type(code, "12a3456");
    expect(code).toHaveValue("123456");
    await userEvent.click(submit);
    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
    expect(useSession.getState()).toMatchObject({
      status: "authenticated",
      email: "buyer@example.com",
      role: "customer",
    });
  });
});

describe("Dashboard", () => {
  it("shows credits per depth and past runs, and deletes a run after confirmation", async () => {
    renderApp("/dashboard");
    expect(await screen.findAllByTestId("run-row")).toHaveLength(2);
    expect(screen.getByTestId("credits")).toHaveTextContent(
      "0 Scout · 0 Sweep · 0 Probe · 0 Siege",
    );
    expect(screen.getByTestId("credits")).not.toHaveTextContent(/free/i);

    await userEvent.click(screen.getByRole("button", { name: /delete run for staging/i }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() => expect(screen.getAllByTestId("run-row")).toHaveLength(1));
  });

  it("runs a saved scan again without reconfiguring it", async () => {
    renderApp("/dashboard");
    await userEvent.click(await screen.findByRole("button", { name: /run again for staging/i }));
    expect(await screen.findByRole("heading", { name: "Live swarm view" })).toBeInTheDocument();
  });
});

const fillValidIntake = async () => {
  await userEvent.type(screen.getByLabelText(/application url/i), "https://staging.example.com");
  await userEvent.type(
    screen.getByLabelText("Username", { selector: "#user1-username" }),
    "swarm-test-user",
  );
  await userEvent.type(
    screen.getByLabelText("Password", { selector: "#user1-password" }),
    "not-a-real-password",
  );
  await userEvent.type(
    screen.getByLabelText("What can this account do?", { selector: "#user1-description" }),
    "Standard customer",
  );
  await userEvent.click(screen.getByLabelText(/I am authorised to test/i));
};

describe("Intake", () => {
  it("offers four depths from shallow to deep, with no free option", () => {
    renderApp("/new");
    const depths = within(screen.getByRole("radiogroup", { name: "Scan depth" })).getAllByRole(
      "radio",
    );
    expect(depths.map((r) => (r as HTMLInputElement).value)).toEqual([
      "scout",
      "sweep",
      "probe",
      "siege",
    ]);
    expect(screen.getByRole("radio", { name: "Sweep" })).toBeChecked();
    expect(screen.queryByText(/free/i)).toBeNull();
    expect(screen.queryByText(/lite/i)).toBeNull();
    expect(screen.getByText(/never production/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/I am authorised to test/i)).not.toBeChecked();
  });

  it("defaults to a one-off scan and the account email, and offers every cadence", () => {
    renderApp("/new");
    const how = screen.getByLabelText("How often?");
    expect(how).toHaveValue("once");
    expect(
      within(how)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["One-off", "Daily", "Weekly", "Monthly", "Yearly"]);
    expect(screen.getByLabelText(/email the report notice to/i)).toHaveValue("buyer@example.com");
    expect(screen.getByRole("button", { name: "Start scan" })).toBeInTheDocument();
  });

  it("changes the button and explains repeats when a cadence is chosen", async () => {
    renderApp("/new");
    await userEvent.selectOptions(screen.getByLabelText("How often?"), "weekly");
    expect(screen.getByRole("button", { name: "Save and start scan" })).toBeInTheDocument();
    expect(screen.getByText(/then repeats weekly/i)).toBeInTheDocument();
  });

  it("shows the four login slots and how many the depth uses", async () => {
    renderApp("/new");
    for (const label of ["Admin", "User 1", "User 2", "Other"]) {
      expect(screen.getByRole("group", { name: label })).toBeInTheDocument();
    }
    expect(screen.getByTestId("login-limit")).toHaveTextContent("Sweep uses up to 1 login");
    await userEvent.click(screen.getByRole("radio", { name: "Siege" }));
    expect(screen.getByTestId("login-limit")).toHaveTextContent("Siege uses up to 4 logins");
  });

  it("needs no logins at Scout depth", async () => {
    renderApp("/new");
    await userEvent.click(screen.getByRole("radio", { name: "Scout" }));
    expect(screen.getByTestId("no-logins")).toHaveTextContent(/no logins are needed/i);
    expect(screen.queryByRole("group", { name: "Admin" })).toBeNull();
  });

  it("blocks an empty submission and reports each problem", async () => {
    renderApp("/new");
    await userEvent.click(screen.getByRole("button", { name: "Start scan" }));
    expect(await screen.findByText(/enter a full url/i)).toBeInTheDocument();
    expect(screen.getByText(/must confirm you are authorised/i)).toBeInTheDocument();
    expect(screen.getByText(/add at least one login/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/application url/i)).toHaveAttribute("aria-invalid", "true");
  });

  it("requires a notification address unless notifications are off", async () => {
    renderApp("/new");
    await fillValidIntake();
    await userEvent.clear(screen.getByLabelText(/email the report notice to/i));
    await userEvent.click(screen.getByRole("button", { name: "Start scan" }));
    expect(await screen.findByText(/enter the email address/i)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Notify me"), "never");
    await userEvent.click(screen.getByRole("button", { name: "Start scan" }));
    expect(await screen.findByRole("heading", { name: "Live swarm view" })).toBeInTheDocument();
  });

  it("opens the demo run once the form is valid", async () => {
    renderApp("/new");
    await fillValidIntake();
    await userEvent.click(screen.getByRole("button", { name: "Start scan" }));
    expect(await screen.findByRole("heading", { name: "Live swarm view" })).toBeInTheDocument();
  });
});

describe("Live swarm view", () => {
  it("replays the run to the assembled report", async () => {
    renderApp("/demo?autoplay=0");
    expect(await screen.findAllByTestId("agent-chip")).toHaveLength(12);
    expect(screen.queryAllByTestId("finding")).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "Skip to end" }));
    const banner = await screen.findByTestId("report-banner");
    expect(banner).toHaveTextContent("Report assembled");
    expect(screen.getAllByTestId("finding")).toHaveLength(11);
    expect(screen.getByTestId("run-status")).toHaveTextContent("complete");
    expect(within(banner).getByRole("link", { name: /open the report/i })).toHaveAttribute(
      "href",
      "/runs/run_demo0001/report",
    );
  });

  it("opens the agent drawer from a chip", async () => {
    renderApp("/demo?autoplay=0");
    await userEvent.click(await screen.findByRole("button", { name: /^IDOR/ }));
    expect(await screen.findByTestId("agent-drawer")).toBeInTheDocument();
    expect(screen.getByLabelText(/steer this agent/i)).toBeDisabled();
  });

  it("exposes the motion mode on the canvas", async () => {
    renderApp("/demo?autoplay=0");
    expect(await screen.findByTestId("swarm-canvas")).toHaveAttribute("data-motion", "full");
  });
});

describe("Report", () => {
  it("shows the demo findings table", () => {
    renderApp("/runs/run_demo0001/report");
    expect(screen.getByRole("heading", { name: "Report" })).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(12);
    expect(screen.getByRole("button", { name: "Download PDF" })).toBeDisabled();
  });
});

describe("Scans", () => {
  it("lists saved scans with depth, cadence and notification address", async () => {
    renderApp("/scans");
    const rows = await screen.findAllByTestId("scan-row");
    expect(rows).toHaveLength(4);
    const daily = within(rows[0]!);
    expect(daily.getByText("Daily quick check")).toBeInTheDocument();
    expect(daily.getByText("Scout")).toBeInTheDocument();
    expect(daily.getByText("Daily")).toBeInTheDocument();
    expect(daily.getByText("buyer@example.com")).toBeInTheDocument();
    // An address other than the account email stays unconfirmed until its owner follows the link.
    expect(within(rows[1]!).getByText("Unconfirmed")).toBeInTheDocument();
    expect(within(rows[3]!).getByText("One-off")).toBeInTheDocument();
  });

  it("runs a saved scan again without reconfiguring it", async () => {
    renderApp("/scans");
    await userEvent.click(await screen.findByRole("button", { name: "Run Weekly review again" }));
    expect(await screen.findByRole("heading", { name: "Live swarm view" })).toBeInTheDocument();
  });

  it("pauses and resumes a recurring scan, but not a one-off", async () => {
    renderApp("/scans");
    await userEvent.click(await screen.findByRole("button", { name: "Pause Daily quick check" }));
    expect(screen.getByRole("button", { name: "Resume Daily quick check" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /pause pre-launch report/i })).toBeNull();
  });

  it("deletes a scan after confirmation", async () => {
    renderApp("/scans");
    await userEvent.click(await screen.findByRole("button", { name: "Delete Weekly review" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() => expect(screen.getAllByTestId("scan-row")).toHaveLength(3));
  });

  it("keeps the old /schedules address working", async () => {
    renderApp("/schedules");
    expect(await screen.findByRole("heading", { name: "Scans" })).toBeInTheDocument();
  });
});

describe("Account", () => {
  it("shows credits, has no free report, and only enables deletion after typing DELETE", async () => {
    renderApp("/account");
    await waitFor(() =>
      expect(screen.getByTestId("account-credits")).toHaveTextContent(
        "0 Scout · 0 Sweep · 0 Probe · 0 Siege credits",
      ),
    );
    expect(screen.queryByText(/free/i)).toBeNull();
    expect(screen.getAllByText("buyer@example.com")).toHaveLength(2);
    const button = screen.getByRole("button", { name: "Delete my account" });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/to confirm/i), "DELETE");
    expect(button).toBeEnabled();
  });

  it("shows the credits the API reports", async () => {
    setApi({
      ...mockApi,
      getAccount: async () => ({ credits: { scout: 5, sweep: 2, probe: 0, siege: 1 } }),
    });
    renderApp("/account");
    await waitFor(() =>
      expect(screen.getByTestId("account-credits")).toHaveTextContent(
        "5 Scout · 2 Sweep · 0 Probe · 1 Siege credits",
      ),
    );
  });
});

describe("Session", () => {
  it("sends signed-out visitors from a protected page to the login screen", async () => {
    renderApp("/dashboard", null);
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });

  it("returns to the page they asked for after signing in", async () => {
    renderApp("/account", null);
    await userEvent.type(await screen.findByLabelText(/email address/i), "buyer@example.com");
    await userEvent.click(screen.getByRole("button", { name: /email me a code/i }));
    await userEvent.type(await screen.findByLabelText(/6-digit code/i), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("heading", { name: "Account" })).toBeInTheDocument();
  });

  it("keeps the public demo open without signing in", async () => {
    renderApp("/demo?autoplay=0", null);
    expect(await screen.findByRole("heading", { name: "Live swarm view" })).toBeInTheDocument();
  });

  it("restores a session the server still knows about on load", async () => {
    useSession.setState({ status: "loading" });
    setApi({
      ...mockApi,
      getSession: async () => ({
        authenticated: true,
        user: { email: "back@example.com", role: "customer" },
        csrfToken: "c",
      }),
    });
    renderApp("/dashboard", null);
    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
    expect(screen.getByText("back@example.com")).toBeInTheDocument();
  });

  it("treats a failed or empty session lookup as signed out", async () => {
    useSession.setState({ status: "loading" });
    setApi({
      ...mockApi,
      getSession: async () => {
        throw new Error("offline");
      },
    });
    renderApp("/dashboard", null);
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
  });

  it("signs out through the server and clears the page", async () => {
    let loggedOut = false;
    setApi({
      ...mockApi,
      logout: async () => {
        loggedOut = true;
      },
    });
    renderApp("/dashboard");
    await userEvent.click(await screen.findByRole("button", { name: "Sign out" }));
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(loggedOut).toBe(true);
    expect(useSession.getState()).toMatchObject({
      status: "anonymous",
      email: null,
      csrfToken: null,
    });
  });

  it("shows a clear message when the code is wrong", async () => {
    setApi({
      ...mockApi,
      verifyCode: async () => {
        throw new ApiError(401, "invalid_or_expired_code");
      },
    });
    renderApp("/login", null);
    await userEvent.type(screen.getByLabelText(/email address/i), "buyer@example.com");
    await userEvent.click(screen.getByRole("button", { name: /email me a code/i }));
    await userEvent.type(await screen.findByLabelText(/6-digit code/i), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/wrong or has expired/i);
  });

  it("completes a magic-link sign-in on a click", async () => {
    renderApp("/auth/verify?token=abc.def", null);
    await userEvent.click(screen.getByRole("button", { name: "Sign in" }));
    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
  });

  it("explains an incomplete magic link", () => {
    renderApp("/auth/verify", null);
    expect(screen.getByText(/link is incomplete/i)).toBeInTheDocument();
  });
});

describe("Staff", () => {
  it("is gated when signed out", () => {
    renderApp("/staff", null);
    expect(screen.getByTestId("staff-denied")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Staff" })).not.toBeInTheDocument();
  });

  it("is gated for a normal customer", () => {
    renderApp("/staff", "customer");
    expect(screen.getByTestId("staff-denied")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Staff" })).not.toBeInTheDocument();
  });

  it("opens for staff once the server confirms the role, and adds the nav link", async () => {
    renderApp("/staff", "staff");
    expect(await screen.findByTestId("staff-home")).toBeInTheDocument();
    expect(await screen.findByTestId("staff-verified")).toHaveTextContent("confirmed you as staff");
    expect(screen.getByRole("link", { name: "Staff" })).toBeInTheDocument();
  });

  it("stays closed when the server disagrees with the browser's idea of the role", async () => {
    setApi({
      ...mockApi,
      staffWhoami: async () => {
        throw new ApiError(403, "forbidden");
      },
    });
    renderApp("/staff", "staff");
    expect(await screen.findByTestId("staff-denied")).toBeInTheDocument();
  });
});
