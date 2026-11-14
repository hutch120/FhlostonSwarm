import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import {
  DEMO_RUN_ID,
  applyEvents,
  buildReport,
  createRunState,
  replayEvents,
  summarise,
  tierRoster,
} from "@swarm/shared";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import { ApiError, createMockApi, setApi, type ApiClient } from "./api/client.js";
import { MOCK_RUNS } from "./api/mock.js";
import { useSession } from "./state/session.js";
import { renderWithProviders } from "./test/render.js";

const EMAILS = { customer: "buyer@example.com", staff: "ops@fhlostonswarm.com" } as const;

// Signed in as a customer unless a test says otherwise (the store is reset before each test).
const renderApp = (route: string, as: keyof typeof EMAILS | null = "customer") => {
  if (as) useSession.getState().setUser({ email: EMAILS[as], role: as }, "csrf");
  return renderWithProviders(<App />, { route });
};

describe("Menu", () => {
  it("keeps the navigation behind a toggle that opens, closes and follows a link", async () => {
    renderApp("/dashboard");
    const toggle = await screen.findByRole("button", { name: "Menu" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(document.getElementById("site-menu")).toHaveAttribute("data-open", "false");

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById("site-menu")).toHaveAttribute("data-open", "true");

    await userEvent.keyboard("{Escape}");
    expect(toggle).toHaveAttribute("aria-expanded", "false");

    await userEvent.click(toggle);
    await userEvent.click(screen.getByRole("link", { name: "Live demo" }));
    expect(await screen.findByRole("heading", { name: "Live swarm view" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Menu" })).toHaveAttribute("aria-expanded", "false");
  });
});

describe("Landing", () => {
  it("introduces the service to a visitor, with the swarm animation and a way in", async () => {
    renderApp("/", null);
    expect(
      await screen.findByRole("heading", { level: 1, name: /find the weak spots/i }),
    ).toBeInTheDocument();
    expect(document.querySelector("canvas.swarm-canvas")).not.toBeNull();
    expect(screen.getByRole("link", { name: "Start a scan" })).toHaveAttribute("href", "/new");
    expect(screen.getByRole("link", { name: /watch the full demo/i })).toHaveAttribute(
      "href",
      "/demo",
    );
    for (const depth of ["Scout", "Sweep", "Probe", "Siege"]) {
      expect(screen.getByRole("heading", { level: 3, name: depth })).toBeInTheDocument();
    }
  });

  it("sends a signed-in visitor to their dashboard", async () => {
    renderApp("/");
    expect(await screen.findByRole("link", { name: "Go to your dashboard" })).toHaveAttribute(
      "href",
      "/dashboard",
    );
  });
});

describe("Login", () => {
  it("signs in with an email and a 6-digit code", async () => {
    renderApp("/login", null);
    await userEvent.type(screen.getByLabelText(/email address/i), "buyer@example.com");
    await userEvent.click(screen.getByRole("button", { name: /email me a code/i }));
    const code = await screen.findByLabelText(/6-digit code/i);
    const submit = screen.getByRole("button", { name: "Sign in" });
    expect(submit).toBeDisabled();
    await userEvent.type(code, "12345");
    expect(submit).toBeDisabled();
    await userEvent.type(code, "6!");
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
    expect(screen.getByTestId("credits")).toHaveTextContent("0 Scout");

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

const withCredits = (over: Partial<ApiClient> = {}): ApiClient => ({
  ...createMockApi(),
  getAccount: async () => ({
    credits: { scout: 5, sweep: 5, probe: 5, siege: 5 },
    unmetered: false,
  }),
  ...over,
});

describe("Intake", () => {
  beforeEach(() => setApi(withCredits()));

  it("offers four depths from shallow to deep", () => {
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
    expect(screen.getByText(/never production/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/I am authorised to test/i)).not.toBeChecked();
  });

  it("defaults to a one-off scan and the account email, and offers every cadence", async () => {
    renderApp("/new");
    const how = screen.getByLabelText("How often?");
    expect(how).toHaveValue("once");
    expect(
      within(how)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["One-off", "Daily", "Weekly", "Monthly", "Yearly"]);
    expect(screen.getByLabelText(/email the report notice to/i)).toHaveValue("buyer@example.com");
    expect(await screen.findByRole("button", { name: "Start scan" })).toBeInTheDocument();
  });

  it("changes the button and explains repeats when a cadence is chosen", async () => {
    renderApp("/new");
    await userEvent.selectOptions(screen.getByLabelText("How often?"), "weekly");
    expect(await screen.findByRole("button", { name: "Save and start scan" })).toBeInTheDocument();
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
    await userEvent.click(await screen.findByRole("button", { name: "Start scan" }));
    expect(await screen.findByText(/enter a full url/i)).toBeInTheDocument();
    expect(screen.getByText(/must confirm you are authorised/i)).toBeInTheDocument();
    expect(screen.getByText(/add at least one login/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/application url/i)).toHaveAttribute("aria-invalid", "true");
  });

  it("requires a notification address unless notifications are off", async () => {
    renderApp("/new");
    await fillValidIntake();
    await userEvent.clear(screen.getByLabelText(/email the report notice to/i));
    await userEvent.click(await screen.findByRole("button", { name: "Start scan" }));
    expect(await screen.findByText(/enter the email address/i)).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText("Notify me"), "never");
    await userEvent.click(await screen.findByRole("button", { name: "Start scan" }));
    expect(await screen.findByRole("heading", { name: "Live swarm view" })).toBeInTheDocument();
  });

  it("opens the demo run once the form is valid", async () => {
    renderApp("/new");
    await fillValidIntake();
    await userEvent.click(await screen.findByRole("button", { name: "Start scan" }));
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
    expect(screen.queryByLabelText(/steer this agent/i)).toBeNull();
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
    expect(
      await screen.findByRole("button", { name: "Resume Daily quick check" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /pause pre-launch report/i })).toBeNull();
  });

  it("deletes a scan after confirmation", async () => {
    renderApp("/scans");
    await userEvent.click(await screen.findByRole("button", { name: "Delete Weekly review" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() => expect(screen.getAllByTestId("scan-row")).toHaveLength(3));
  });

  it("links each scan to its edit form", async () => {
    renderApp("/scans");
    expect(await screen.findByRole("link", { name: "Edit Weekly review" })).toHaveAttribute(
      "href",
      "/scans/scan_weekly01/edit",
    );
  });

  it("says when a run cannot start because there is no credit", async () => {
    setApi({
      ...createMockApi(),
      runScan: async () => {
        throw new ApiError(402, "no_credit");
      },
    });
    renderApp("/scans");
    await userEvent.click(await screen.findByRole("button", { name: "Run Weekly review again" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/no credit/i);
  });

  it("resends the confirmation link for an unconfirmed address", async () => {
    const resend = vi.fn(async () => undefined);
    setApi({ ...createMockApi(), resendNotifyConfirmation: resend });
    renderApp("/scans");
    await userEvent.click(
      await screen.findByRole("button", { name: "Resend confirmation link for Weekly review" }),
    );
    expect(resend).toHaveBeenCalledWith("scan_weekly01");
    expect(await screen.findByRole("status")).toHaveTextContent(/new confirmation link/i);
  });

  it("lists saved targets and names the scans that go with one before deleting it", async () => {
    renderApp("/scans");
    const rows = await screen.findAllByTestId("target-row");
    expect(rows).toHaveLength(2);
    await userEvent.click(
      within(rows[0]!).getByRole("button", { name: "Delete target staging.example-shop.test" }),
    );
    expect(rows[0]).toHaveTextContent("Daily quick check, Weekly review, Monthly deep scan");
    await userEvent.click(screen.getByRole("button", { name: "Confirm delete target" }));
    await waitFor(() => expect(screen.getAllByTestId("target-row")).toHaveLength(1));
    // Its scans went with it.
    await waitFor(() => expect(screen.getAllByTestId("scan-row")).toHaveLength(1));
  });
});

describe("Account", () => {
  it("generates a test passcode for the chosen lifetime", async () => {
    const asked: string[] = [];
    setApi({
      ...createMockApi(),
      createTestPasscode: async (lifetime) => {
        asked.push(lifetime);
        return { code: "abcd-efgh-jkmn-pqrs", expiresAt: Date.now() + 3_600_000 };
      },
    });
    renderApp("/account");
    await userEvent.selectOptions(await screen.findByLabelText("Valid for"), "week");
    await userEvent.click(screen.getByRole("button", { name: "Generate test passcode" }));
    expect(await screen.findByTestId("test-passcode")).toHaveTextContent("abcd-efgh-jkmn-pqrs");
    expect(asked).toEqual(["week"]);
  });

  it("shows credits and walks through deleting the account with a fresh code", async () => {
    const calls: string[] = [];
    setApi({
      ...createMockApi(),
      requestAccountDeletion: async () => void calls.push("code"),
      deleteAccount: async (code) => void calls.push(`delete ${code}`),
    });
    renderApp("/account");
    await waitFor(() =>
      expect(screen.getByTestId("account-credits")).toHaveTextContent(
        "0 Scout · 0 Sweep · 0 Probe · 0 Siege credits",
      ),
    );
    expect(screen.getAllByText("buyer@example.com")).toHaveLength(2);
    const send = screen.getByRole("button", { name: "Email me a deletion code" });
    expect(send).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/to confirm/i), "DELETE");
    await userEvent.click(send);

    const remove = await screen.findByRole("button", { name: "Delete my account" });
    expect(remove).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/6-digit code/i), "12a3456");
    expect(screen.getByLabelText(/6-digit code/i)).toHaveValue("123456");
    await userEvent.click(remove);
    expect(await screen.findByRole("heading", { name: "Sign in" })).toBeInTheDocument();
    expect(calls).toEqual(["code", "delete 123456"]);
    expect(useSession.getState().status).toBe("anonymous");
  });

  it("keeps the account when the code is wrong", async () => {
    setApi({
      ...createMockApi(),
      deleteAccount: async () => {
        throw new ApiError(400, "invalid_or_expired_code");
      },
    });
    renderApp("/account");
    await userEvent.type(await screen.findByLabelText(/to confirm/i), "DELETE");
    await userEvent.click(screen.getByRole("button", { name: "Email me a deletion code" }));
    await userEvent.type(await screen.findByLabelText(/6-digit code/i), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Delete my account" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/wrong or has expired/i);
    expect(useSession.getState().status).toBe("authenticated");
  });

  it("shows the credits the API reports", async () => {
    setApi({
      ...createMockApi(),
      getAccount: async () => ({
        credits: { scout: 5, sweep: 2, probe: 0, siege: 1 },
        unmetered: false,
      }),
    });
    renderApp("/account");
    await waitFor(() =>
      expect(screen.getByTestId("account-credits")).toHaveTextContent(
        "5 Scout · 2 Sweep · 0 Probe · 1 Siege credits",
      ),
    );
  });
});

describe("Terms and privacy", () => {
  it("show without signing in, and the privacy notice covers deletion and what is kept", () => {
    renderApp("/privacy", null);
    const privacy = screen.getByTestId("privacy");
    expect(privacy).toHaveTextContent(/delete a single run, a scan, a target/i);
    expect(privacy).toHaveTextContent(/anonymised cost records/i);
    expect(privacy).toHaveTextContent(/one-way hash/i);
    expect(privacy).toHaveTextContent(/never show a saved password/i);
  });

  it("the terms require authorisation and staging-only credentials", () => {
    renderApp("/terms", null);
    const terms = screen.getByTestId("terms");
    expect(terms).toHaveTextContent(/authorised to test/i);
    expect(terms).toHaveTextContent(/staging, never production/i);
    expect(terms).toHaveTextContent(/one credit/i);
  });

  it("are linked from the footer and from the intake acknowledgement", () => {
    renderApp("/new");
    expect(screen.getAllByRole("link", { name: /terms/i }).length).toBeGreaterThan(1);
    expect(screen.getAllByRole("link", { name: /privacy/i }).length).toBeGreaterThan(1);
  });
});

describe("Notification confirmation", () => {
  it("confirms the address on a click, without signing in", async () => {
    const confirm = vi.fn(async () => undefined);
    setApi({ ...createMockApi(), confirmNotify: confirm });
    renderApp("/notify/confirm?token=abc123", null);
    expect(confirm).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Confirm this address" }));
    expect(await screen.findByTestId("notify-confirmed")).toBeInTheDocument();
    expect(confirm).toHaveBeenCalledWith("abc123");
  });

  it("explains a used or expired link, and an incomplete one", async () => {
    setApi({
      ...createMockApi(),
      confirmNotify: async () => {
        throw new ApiError(400, "invalid_or_expired_link");
      },
    });
    renderApp("/notify/confirm?token=abc123", null);
    await userEvent.click(screen.getByRole("button", { name: "Confirm this address" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/expired or was already used/i);
  });

  it("needs a token", () => {
    renderApp("/notify/confirm", null);
    expect(screen.getByText(/link is incomplete/i)).toBeInTheDocument();
  });
});

describe("A queued run", () => {
  const queued = {
    ...MOCK_RUNS[1]!,
    summary: { ...MOCK_RUNS[1]!.summary, runId: "run_queued001", status: "queued" as const },
  };

  it("waits on its own page: no replay, and no report link on the dashboard", async () => {
    setApi({
      ...createMockApi(),
      listRuns: async () => [queued],
      getRun: async () => queued,
    });
    renderApp("/dashboard");
    const row = await screen.findByTestId("run-row");
    expect(within(row).getByText("queued")).toBeInTheDocument();
    expect(within(row).queryByRole("link", { name: "Report" })).toBeNull();

    await userEvent.click(within(row).getByRole("link", { name: "Watch" }));
    expect(await screen.findByTestId("queued-note")).toHaveTextContent(/credit is spent/i);
    expect(screen.queryByTestId("swarm-canvas")).toBeNull();
    expect(screen.getByTestId("run-status")).toHaveTextContent("queued");
  });

  it("starts when asked, and then follows the run", async () => {
    let status: "queued" | "running" = "queued";
    const start = vi.fn(async () => {
      status = "running";
    });
    setApi({
      ...createMockApi(),
      getRun: async () => ({ ...queued, summary: { ...queued.summary, status } }),
      startRun: start,
    });
    renderApp("/runs/run_queued001");
    await userEvent.click(await screen.findByRole("button", { name: "Start run" }));
    expect(start).toHaveBeenCalledWith("run_queued001");
    expect(await screen.findByRole("heading", { name: "Live swarm view" })).toBeInTheDocument();
    expect(screen.getByTestId("run-status")).toHaveTextContent("running");
  });

  it("shows that it is waiting for a free slot, follows it when it starts, and can be cancelled", async () => {
    let status: "queued" | "running" = "queued";
    const waiting = { ...queued, reason: "Waiting for a free Scout slot. It starts by itself." };
    const stop = vi.fn(async () => undefined);
    setApi({
      ...createMockApi(),
      getRun: async () =>
        status === "queued" ? waiting : { ...queued, summary: { ...queued.summary, status } },
      stopRun: stop,
    });
    renderApp("/runs/run_queued001");
    expect(await screen.findByTestId("queued-wait")).toHaveTextContent(
      "Waiting for a free Scout slot. It starts by itself.",
    );
    // No Start button while it waits: the run starts by itself.
    expect(screen.queryByRole("button", { name: "Start run" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Cancel and return the credit" }));
    expect(stop).toHaveBeenCalledWith("run_queued001");
    status = "running";
  });

  it("says why a start failed and stays queued", async () => {
    setApi({
      ...createMockApi(),
      getRun: async () => queued,
      startRun: async () => {
        throw new ApiError(503, "start_failed");
      },
    });
    renderApp("/runs/run_queued001");
    await userEvent.click(await screen.findByRole("button", { name: "Start run" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/could not be started/i);
    expect(screen.getByTestId("run-status")).toHaveTextContent("queued");
  });

  it("says when the run is gone", async () => {
    setApi({
      ...createMockApi(),
      getRun: async () => {
        throw new ApiError(404, "not_found");
      },
    });
    renderApp("/runs/run_gone00001");
    expect(await screen.findByRole("heading", { name: "Run not found" })).toBeInTheDocument();
  });
});

describe("A real run", () => {
  const RUN = "run_live00001";
  /** The demo script's events, re-addressed to this run (its roster is the Siege one). */
  const events = replayEvents.map((e) => ({ ...e, runId: RUN }));
  const running = {
    ...MOCK_RUNS[0]!,
    target: "staging.example.com",
    summary: { ...MOCK_RUNS[0]!.summary, runId: RUN, status: "running" as const },
  };

  /** An API whose log grows as the test releases events, as a run would. */
  const apiWith = (released: { n: number }, over: Partial<ApiClient> = {}): ApiClient => ({
    ...createMockApi(),
    getRun: async () => running,
    getRunEvents: async (_id, after) => {
      const page = events.slice(0, released.n).filter((e) => e.seq > after);
      return { events: page, lastSeq: page.at(-1)?.seq ?? after, more: false };
    },
    ...over,
  });

  it("follows the event stream with no live channel by polling, and offers Stop", async () => {
    const released = { n: 6 };
    const stop = vi.fn(async () => undefined);
    setApi(apiWith(released, { stopRun: stop }));
    renderApp(`/runs/${RUN}`);

    expect(await screen.findAllByTestId("agent-chip")).toHaveLength(12);
    await waitFor(() =>
      expect(screen.getByTestId("transport")).toHaveTextContent(/every few seconds/i),
    );
    expect(screen.getByTestId("run-status")).toHaveTextContent("running");
    expect(screen.queryByTestId("report-banner")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Stop run" }));
    expect(stop).toHaveBeenCalledWith(RUN);
  });

  it("shows the report link once the complete event arrives, and no Stop button", async () => {
    setApi(apiWith({ n: events.length }));
    renderApp(`/runs/${RUN}`);
    const banner = await screen.findByTestId("report-banner");
    expect(banner).toHaveTextContent("Report assembled");
    expect(within(banner).getByRole("link", { name: /open the report/i })).toHaveAttribute(
      "href",
      `/runs/${RUN}/report`,
    );
    expect(screen.getByTestId("run-status")).toHaveTextContent("complete");
    expect(screen.queryByRole("button", { name: "Stop run" })).toBeNull();
    expect(screen.queryByTestId("transport")).toBeNull();
    expect(screen.getAllByTestId("finding")).toHaveLength(11);
  });

  it("explains a run that ended on our side", async () => {
    const failed = {
      ...running,
      summary: { ...running.summary, status: "failed" as const },
      reason: "The run ended because of a problem on our side. Your credit has been returned.",
    };
    setApi(apiWith({ n: 0 }, { getRun: async () => failed }));
    renderApp(`/runs/${RUN}`);
    const banner = await screen.findByTestId("report-banner");
    expect(banner).toHaveTextContent(/credit has been returned/i);
    expect(screen.getByTestId("run-status")).toHaveTextContent("failed");
  });

  it("lists a stopped run's report on the dashboard", async () => {
    const stopped = { ...running, summary: { ...running.summary, status: "stopped" as const } };
    setApi({ ...createMockApi(), listRuns: async () => [stopped] });
    renderApp("/dashboard");
    const row = await screen.findByTestId("run-row");
    expect(within(row).getByRole("link", { name: "Report" })).toHaveAttribute(
      "href",
      `/runs/${RUN}/report`,
    );
  });
});

describe("A real report", () => {
  const RUN = "run_live00001";
  const base = (() => {
    const { areas, agents } = tierRoster("siege");
    const state = applyEvents(
      createRunState({ runId: DEMO_RUN_ID, tier: "siege", areas, agents }),
      replayEvents,
    );
    return buildReport({
      state,
      events: replayEvents,
      summary: summarise(state),
      target: "staging.example.com",
      generatedAt: "2026-11-10T00:00:00.000Z",
    });
  })();
  const report = { ...base, runId: RUN };

  it("shows the findings, what could not be tested and the disclaimer", async () => {
    setApi({ ...createMockApi(), getReport: async () => report });
    renderApp(`/runs/${RUN}/report`);
    expect(await screen.findByRole("heading", { name: "Report" })).toBeInTheDocument();
    expect(screen.getAllByTestId("report-finding")).toHaveLength(report.findings.length);
    expect(screen.getByTestId("report-gaps")).toBeInTheDocument();
    expect(screen.getByRole("note")).toHaveTextContent(/automated, AI-assisted/);
    expect(screen.getByRole("link", { name: "Back to the run" })).toHaveAttribute(
      "href",
      `/runs/${RUN}`,
    );
  });

  it("shows the full report: priorities, testing by phase, the AI outcome and unconfirmed findings", async () => {
    setApi({ ...createMockApi(), getReport: async () => report });
    renderApp(`/runs/${RUN}/report`);
    await screen.findByRole("heading", { name: "Report" });
    expect(screen.getByTestId("report-summary")).toHaveTextContent(/unconfirmed/);
    expect(screen.getByTestId("report-ai")).toHaveTextContent(/AI\/LLM testing:/);
    const priorities = screen.getByTestId("report-priorities");
    expect(within(priorities).getAllByRole("listitem").length).toBe(report.priorities.length);
    // Every phase of the depth is listed, with each check's result.
    for (const phase of report.phases) {
      expect(screen.getByTestId(`report-phase-${phase.phase}`)).toBeInTheDocument();
    }
    expect(screen.getAllByText("Unconfirmed").length).toBe(report.counts.unconfirmed);
  });

  it("downloads the PDF through a time-limited link, and says when it is not ready", async () => {
    const link = vi
      .fn<ApiClient["getReportLink"]>()
      .mockRejectedValueOnce(new ApiError(404, "report_not_ready"))
      .mockResolvedValueOnce({
        url: "https://data.test/report.pdf",
        expiresAt: "2026-11-10T00:05:00.000Z",
      });
    setApi({ ...createMockApi(), getReport: async () => report, getReportLink: link });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    renderApp(`/runs/${RUN}/report`);
    const button = await screen.findByRole("button", { name: "Download PDF" });
    await userEvent.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent(/PDF is still being prepared/);
    await userEvent.click(button);
    expect(link).toHaveBeenLastCalledWith(RUN, "pdf");
    await vi.waitFor(() => expect(click).toHaveBeenCalled());
    click.mockRestore();
  });

  it("shows what the scan understood and what this depth did not include", async () => {
    const shallow = {
      ...buildReport({
        state: applyEvents(
          createRunState({ runId: RUN, ...tierRoster("sweep"), tier: "sweep" }),
          [],
        ),
        events: [],
        summary: summarise(
          applyEvents(createRunState({ runId: RUN, ...tierRoster("sweep"), tier: "sweep" }), []),
        ),
        target: "staging.example.com",
        generatedAt: "2026-11-10T00:00:00.000Z",
        profile: {
          purpose: "An orders portal where customers track deliveries.",
          areas: [
            { name: "Orders", description: "Past orders.", path: "/orders", requiresLogin: true },
            { name: "Pricing", description: "Plans.", requiresLogin: false },
          ],
          roles: [{ name: "Administrator", description: "Manages users.", access: ["Orders"] }],
          flows: [{ name: "Track an order", description: "Open orders and pick one." }],
          technologies: ["nginx"],
          coverage: { pagesVisited: 9, loginsUsed: 1, signedIn: true },
        },
      }),
      runId: RUN,
    };
    setApi({ ...createMockApi(), getReport: async () => shallow });
    renderApp(`/runs/${RUN}/report`);
    const understood = await screen.findByTestId("report-profile");
    expect(understood).toHaveTextContent("An orders portal where customers track deliveries.");
    expect(understood).toHaveTextContent(
      "Described from 9 pages, including the signed-in side (1 login)",
    );
    expect(understood).toHaveTextContent("Orders /orders (signed in): Past orders.");
    expect(understood).toHaveTextContent("Administrator: Manages users. Reaches: Orders.");
    // Sweep leaves out the deeper agents, and says so.
    const notIncluded = screen.getByTestId("report-not-included");
    for (const name of ["Session", "Access", "Prompt", "Output", "IDOR"]) {
      expect(within(notIncluded).getByText(name)).toBeInTheDocument();
    }
  });

  it("downloads the HTML through a time-limited link", async () => {
    const link = vi.fn(async () => ({
      url: "https://data.test/report.html",
      expiresAt: "2026-11-10T00:05:00.000Z",
    }));
    setApi({ ...createMockApi(), getReport: async () => report, getReportLink: link });
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => undefined);
    renderApp(`/runs/${RUN}/report`);
    await userEvent.click(await screen.findByRole("button", { name: "Download HTML" }));
    expect(link).toHaveBeenCalledWith(RUN, "html");
    expect(click).toHaveBeenCalled();
    click.mockRestore();
  });

  it("says when the report is not ready", async () => {
    renderApp(`/runs/${RUN}/report`);
    expect(await screen.findByText(/report is not ready yet/i)).toBeInTheDocument();
  });
});

describe("Intake: credits, saved targets and editing", () => {
  beforeEach(() => setApi(withCredits()));

  const stubSave = () =>
    vi.fn<ApiClient["saveScan"]>(async (_values, { scanId, start }) => ({
      scanId: scanId ?? "scan_new00001",
      ...(start ? { runId: "run_new000001" } : {}),
    }));

  it("with no credit for the depth it explains how to get one and only saves the scan", async () => {
    const save = stubSave();
    setApi({ ...createMockApi(), saveScan: save });
    renderApp("/new");
    expect(await screen.findByTestId("no-credit")).toHaveTextContent(/no sweep credits/i);
    expect(screen.getByRole("link", { name: "support@fhlostonswarm.com" })).toHaveAttribute(
      "href",
      "mailto:support@fhlostonswarm.com",
    );
    await fillValidIntake();
    await userEvent.click(screen.getByRole("button", { name: "Save scan" }));
    expect(await screen.findByRole("heading", { name: "Scans" })).toBeInTheDocument();
    expect(save).toHaveBeenCalledWith(expect.anything(), { start: false });
  });

  it("tells a customer with credit how many they have, and staff that none is needed", async () => {
    setApi({
      ...createMockApi(),
      getAccount: async () => ({
        credits: { scout: 0, sweep: 3, probe: 0, siege: 0 },
        unmetered: false,
      }),
    });
    renderApp("/new");
    expect(await screen.findByTestId("credit-note")).toHaveTextContent("you have 3");
    await userEvent.click(screen.getByRole("radio", { name: "Scout" }));
    expect(await screen.findByTestId("no-credit")).toHaveTextContent(/no scout credits/i);
  });

  it("lets staff start without a credit", async () => {
    setApi({
      ...createMockApi(),
      getAccount: async () => ({
        credits: { scout: 0, sweep: 0, probe: 0, siege: 0 },
        unmetered: true,
      }),
    });
    renderApp("/new", "staff");
    expect(await screen.findByTestId("credit-note")).toHaveTextContent(/without a credit/i);
    expect(screen.getByRole("button", { name: "Start scan" })).toBeInTheDocument();
  });

  it("starts the run and opens it when the form is valid", async () => {
    const save = stubSave();
    const run = {
      ...MOCK_RUNS[1]!,
      summary: { ...MOCK_RUNS[1]!.summary, runId: "run_new000001", status: "queued" as const },
    };
    setApi({ ...withCredits(), saveScan: save, getRun: async () => run });
    renderApp("/new");
    await fillValidIntake();
    await userEvent.click(await screen.findByRole("button", { name: "Start scan" }));
    expect(await screen.findByTestId("queued-note")).toBeInTheDocument();
    expect(save).toHaveBeenCalledTimes(1);
    const [values, options] = save.mock.calls[0]!;
    expect(options).toEqual({ start: true });
    expect(values).toMatchObject({ tier: "sweep", appUrl: "https://staging.example.com" });
    expect(values.logins.user1).toMatchObject({ username: "swarm-test-user", use: true });
  });

  it("shows a server rejection of a URL on that field", async () => {
    setApi({
      ...withCredits(),
      saveScan: async () => {
        throw new ApiError(400, "app_url_private_address");
      },
    });
    renderApp("/new");
    await fillValidIntake();
    await userEvent.click(await screen.findByRole("button", { name: "Start scan" }));
    expect(await screen.findByText(/private or reserved/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/application url/i)).toHaveAttribute("aria-invalid", "true");
  });

  it("shows another server error above the button, and lets the customer retry", async () => {
    setApi({
      ...withCredits(),
      saveScan: async () => {
        throw new ApiError(402, "no_credit");
      },
    });
    renderApp("/new");
    await fillValidIntake();
    await userEvent.click(await screen.findByRole("button", { name: "Start scan" }));
    expect(await screen.findByText(/no credit for that scan depth/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Start scan" })).toBeEnabled();
  });

  it("reuses a saved target: its URLs and logins come with it, and passwords stay hidden", async () => {
    renderApp("/new");
    await screen.findByRole("option", { name: "staging.example-shop.test" });
    const select = screen.getByLabelText("Use a saved target");
    expect(within(select).getAllByRole("option")).toHaveLength(3);
    await userEvent.selectOptions(select, "tgt_staging01");
    expect(screen.getByLabelText(/application url/i)).toHaveValue(
      "https://staging.example-shop.test",
    );
    const password = screen.getByLabelText("Password", { selector: "#admin-password" });
    expect(password).toHaveValue("");
    expect(password).toHaveAttribute("placeholder", "Saved. Leave blank to keep it.");
    expect(screen.getByLabelText("Use Admin in this scan")).toBeChecked();
    expect(screen.getByLabelText("Use User 1 in this scan")).not.toBeChecked();

    await userEvent.selectOptions(select, "");
    expect(screen.getByLabelText(/application url/i)).toHaveValue("");
  });

  it("limits the logins a scan uses to the depth, with a clear message", async () => {
    renderApp("/new");
    await screen.findByRole("option", { name: "staging.example-shop.test" });
    await userEvent.selectOptions(screen.getByLabelText("Use a saved target"), "tgt_staging01");
    await userEvent.click(screen.getByLabelText("Use User 1 in this scan"));
    await userEvent.click(screen.getByLabelText(/I am authorised to test/i));
    await userEvent.click(await screen.findByRole("button", { name: "Start scan" }));
    expect(await screen.findByText(/up to 1 login and 2 are selected/i)).toBeInTheDocument();
  });

  it("edits a saved scan: filled in from the scan, and saving does not start a run", async () => {
    const save = stubSave();
    setApi({ ...withCredits(), saveScan: save });
    renderApp("/scans/scan_weekly01/edit");
    expect(await screen.findByRole("heading", { name: "Edit scan" })).toBeInTheDocument();
    expect(screen.getByLabelText(/scan name/i)).toHaveValue("Weekly review");
    expect(screen.getByRole("radio", { name: "Probe" })).toBeChecked();
    expect(screen.getByLabelText("How often?")).toHaveValue("weekly");
    expect(screen.getByLabelText(/email the report notice to/i)).toHaveValue(
      "security@example-shop.test",
    );
    expect(screen.getByTestId("shared-target-note")).toHaveTextContent("all 3 scans");
    expect(screen.queryByLabelText("Use a saved target")).toBeNull();
    expect(screen.queryByTestId("no-credit")).toBeNull();

    await userEvent.click(screen.getByLabelText(/I am authorised to test/i));
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    expect(await screen.findByRole("heading", { name: "Scans" })).toBeInTheDocument();
    expect(save).toHaveBeenCalledWith(expect.objectContaining({ targetId: "tgt_staging01" }), {
      scanId: "scan_weekly01",
      start: false,
    });
  });

  it("says when the scan to edit does not exist", async () => {
    renderApp("/scans/scan_missing01/edit");
    expect(await screen.findByRole("heading", { name: "Scan not found" })).toBeInTheDocument();
  });
});

describe("Dashboard credits and errors", () => {
  it("explains how credits are granted", async () => {
    renderApp("/dashboard");
    expect(await screen.findByText(/granted by our team/i)).toBeInTheDocument();
  });

  it("shows why a run could not start", async () => {
    setApi({
      ...createMockApi(),
      runScan: async () => {
        throw new ApiError(402, "no_credit");
      },
    });
    renderApp("/dashboard");
    await userEvent.click(await screen.findByRole("button", { name: /run again for staging/i }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/no credit/i);
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
      ...createMockApi(),
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
      ...createMockApi(),
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
      ...createMockApi(),
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
      ...createMockApi(),
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
      ...createMockApi(),
      staffWhoami: async () => {
        throw new ApiError(403, "forbidden");
      },
    });
    renderApp("/staff", "staff");
    expect(await screen.findByTestId("staff-denied")).toBeInTheDocument();
  });
});
