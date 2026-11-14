import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import { createMockApi, setApi } from "./api/client.js";
import { MOCK_HEALTH } from "./api/staff-mock.js";
import { createMockStaffApi } from "./api/staff-mock.js";
import type { StaffApi } from "./api/staff.js";
import { useSession } from "./state/session.js";
import { renderWithProviders } from "./test/render.js";

const staffApi = (over: Partial<StaffApi> = {}): StaffApi => ({ ...createMockStaffApi(), ...over });

const openStaff = (route: string, staff: StaffApi) => {
  setApi({ ...createMockApi(), staff });
  useSession.getState().setUser({ email: "ops@fhlostonswarm.com", role: "staff" }, "csrf");
  return renderWithProviders(<App />, { route });
};

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("Staff dashboard", () => {
  it("never asks for a staff screen on behalf of a customer", async () => {
    const staff = staffApi({ runs: vi.fn(createMockStaffApi().runs) });
    setApi({ ...createMockApi(), staff });
    useSession.getState().setUser({ email: "buyer@example.com", role: "customer" }, "csrf");
    renderWithProviders(<App />, { route: "/staff/costs" });
    expect(screen.getByTestId("staff-denied")).toBeInTheDocument();
    expect(staff.runs).not.toHaveBeenCalled();
  });

  it("lists runs, filters them, and links to a run", async () => {
    const runs = vi.fn(createMockStaffApi().runs);
    openStaff("/staff", staffApi({ runs }));
    const rows = await screen.findAllByTestId("staff-run-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent("Sweep");
    expect(rows[0]).toHaveTextContent("Complimentary credit");
    expect(rows[0]).toHaveTextContent("US$0.62");
    // A run still going has no cost yet.
    expect(rows[1]).toHaveTextContent("running");
    expect(rows[1]).toHaveTextContent("…");

    await userEvent.selectOptions(screen.getByLabelText("Depth"), "siege");
    await userEvent.selectOptions(screen.getByLabelText("Paid by"), "staff");
    await userEvent.selectOptions(screen.getByLabelText("Test accounts"), "include");
    await waitFor(() =>
      expect(runs).toHaveBeenLastCalledWith({
        tier: "siege",
        entitlement: "staff",
        test: "include",
      }),
    );
    expect(screen.getAllByRole("link", { name: /Nov 2026/ })[0]).toHaveAttribute(
      "href",
      expect.stringContaining("/staff/runs/run_"),
    );
  });

  it("shows a run's cost by component, its caps and its agents", async () => {
    openStaff("/staff/runs/run_0mock0000001aaaaaaaaa", staffApi());
    const cost = await screen.findByTestId("staff-run-cost");
    expect(within(cost).getByText(/400,000 in/)).toBeInTheDocument();
    expect(within(cost).getByText("US$0.62")).toBeInTheDocument();
    expect(
      within(screen.getByTestId("staff-run-budgets")).getByText("Model spend"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("staff-run-gaps")).toHaveTextContent("No login supplied");
    expect(screen.getByTestId("staff-run-events")).toHaveTextContent("Check transport");
    // A finished run can have its email resent, not be stopped.
    expect(screen.getByRole("button", { name: "Resend report email" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Stop run" })).not.toBeInTheDocument();
  });

  it("says so when a run's data was deleted and only the anonymised record is left", async () => {
    openStaff(
      "/staff/runs/run_0mock0000001aaaaaaaaa",
      staffApi({
        run: async () => ({
          detail: null,
          row: {
            runId: "run_0mock0000001aaaaaaaaa",
            tier: "sweep",
            trigger: "manual",
            entitlement: "comp",
            status: "complete",
            startedAt: "2026-11-10T01:00:00.000Z",
            finishedAt: "2026-11-10T01:12:00.000Z",
            durationSeconds: 720,
            findings: 2,
            costUsd: 0.5,
            live: false,
            test: false,
          },
        }),
      }),
    );
    expect(await screen.findByTestId("staff-run-deleted")).toHaveTextContent(
      /only the anonymised cost record/i,
    );
  });

  it("stops a running run after asking the server", async () => {
    const stopRun = vi.fn(async () => undefined);
    const base = createMockStaffApi();
    openStaff(
      "/staff/runs/run_0mock0000002aaaaaaaaa",
      staffApi({
        stopRun,
        run: async (runId) => {
          const r = await base.run(runId);
          return { ...r, detail: { ...r.detail!, status: "running" as const, cost: null } };
        },
      }),
    );
    await userEvent.click(await screen.findByRole("button", { name: "Stop run" }));
    expect(stopRun).toHaveBeenCalledWith("run_0mock0000002aaaaaaaaa");
  });
});

describe("Cost analysis", () => {
  it("shows cost per depth, annualised cost and who paid", async () => {
    openStaff("/staff/costs", staffApi());
    const byDepth = await screen.findByTestId("cost-by-depth");
    expect(within(byDepth).getByText("US$0.60")).toBeInTheDocument();
    // The 95th percentile and the most are both 0.90 for the one depth with runs.
    expect(within(byDepth).getAllByText("US$0.90")).toHaveLength(2);
    // A daily Sweep scan runs 365 times a year: 0.60 x 365.
    expect(within(screen.getByTestId("cost-annual")).getByText("US$219.00")).toBeInTheDocument();
    expect(screen.getByTestId("cost-by-source")).toHaveTextContent("Complimentary credit");
    expect(screen.getByTestId("cost-summary")).toHaveTextContent("4 runs");
  });

  it("turns a margin into a suggested price per depth", async () => {
    openStaff("/staff/costs", staffApi());
    const sweep = await screen.findByTestId("suggested-sweep");
    // 95th percentile 0.90, 100% margin: 1.80 (above the 1.00 floor).
    expect(sweep).toHaveTextContent("US$1.80");
    expect(screen.getByTestId("suggested-scout")).toHaveTextContent("n/a");
    const margin = screen.getByLabelText("Margin over cost (%)");
    await userEvent.clear(margin);
    await userEvent.type(margin, "50");
    expect(sweep).toHaveTextContent("US$1.35");
    const floor = screen.getByLabelText("Floor per run (US$)");
    await userEvent.clear(floor);
    await userEvent.type(floor, "5");
    expect(sweep).toHaveTextContent("US$5.00");
  });

  it("previews a price change before saving it as a new version", async () => {
    const previewCosts = vi.fn(createMockStaffApi().previewCosts);
    const savePricing = vi.fn(createMockStaffApi().savePricing);
    openStaff("/staff/costs", staffApi({ previewCosts, savePricing }));
    const haiku = await screen.findByLabelText(
      "Input price for au.anthropic.claude-haiku-4-5-20251001-v1:0",
    );
    await userEvent.clear(haiku);
    await userEvent.type(haiku, "2");
    await userEvent.type(screen.getByLabelText("Note for the audit log"), "checked");
    await userEvent.click(screen.getByRole("button", { name: "Preview the effect" }));
    expect(await screen.findByTestId("price-preview")).toHaveTextContent("US$2.40");
    expect(
      previewCosts.mock.calls[0]?.[0].bedrock["au.anthropic.claude-haiku-4-5-20251001-v1:0"],
    ).toEqual({
      inputPerMTok: 2,
      outputPerMTok: 5,
    });
    await userEvent.click(screen.getByRole("button", { name: "Save as a new version" }));
    await waitFor(() => expect(savePricing).toHaveBeenCalled());
    expect(savePricing.mock.calls[0]?.[1]).toBe("checked");
  });
});

describe("Users and support", () => {
  it("looks an account up and grants a credit only with a reason", async () => {
    const grantCredit = vi.fn(async () => undefined);
    openStaff("/staff/users", staffApi({ grantCredit }));
    await userEvent.type(await screen.findByLabelText("Email address"), "buyer@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Look up" }));
    expect(await screen.findByTestId("staff-credits")).toHaveTextContent("1 Scout · 2 Sweep");
    expect(screen.getByTestId("staff-grants")).toHaveTextContent("beta tester");

    const grant = screen.getByRole("button", { name: "Grant credit" });
    expect(grant).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText("Depth"), "probe");
    await userEvent.type(screen.getByLabelText(/Reason/), "beta tester");
    expect(grant).toBeEnabled();
    await userEvent.click(grant);
    expect(grantCredit).toHaveBeenCalledWith("a".repeat(64), {
      tier: "probe",
      count: 1,
      reason: "beta tester",
    });
  });

  it("pauses a scan and asks again before deleting an account", async () => {
    const setScanStatus = vi.fn(async () => undefined);
    const deleteAccount = vi.fn(async () => undefined);
    openStaff("/staff/users", staffApi({ setScanStatus, deleteAccount }));
    await userEvent.type(await screen.findByLabelText("Email address"), "buyer@example.com");
    await userEvent.click(screen.getByRole("button", { name: "Look up" }));
    await userEvent.click(await screen.findByRole("button", { name: "Pause" }));
    expect(setScanStatus).toHaveBeenCalledWith("a".repeat(64), "scan_0mock0000001aaaa", "paused");

    await userEvent.click(screen.getByRole("button", { name: "Delete account…" }));
    expect(deleteAccount).not.toHaveBeenCalled();
    await userEvent.type(
      screen.getByLabelText(/Reason/, { selector: "#d-reason" }),
      "asked by email",
    );
    await userEvent.click(screen.getByRole("button", { name: "Delete the account" }));
    expect(deleteAccount).toHaveBeenCalledWith("a".repeat(64), "asked by email");
    await waitFor(() => expect(screen.queryByTestId("staff-account")).not.toBeInTheDocument());
  });
});

describe("Controls", () => {
  it("turns the kill switch on with a reason and reports what it stopped", async () => {
    const setKillSwitch = vi.fn(createMockStaffApi().setKillSwitch);
    openStaff("/staff/controls", staffApi({ setKillSwitch }));
    expect(await screen.findByTestId("kill-state")).toHaveTextContent("Off.");
    const button = screen.getByRole("button", { name: /Turn the kill switch on/ });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/Reason/, { selector: "#k-reason" }), "drill");
    await userEvent.click(button);
    expect(setKillSwitch).toHaveBeenCalledWith(true, "drill");
    expect(await screen.findByText(/1 runs were stopped/)).toBeInTheDocument();
    expect(screen.getByTestId("kill-state")).toHaveTextContent("On.");
    expect(screen.getByRole("button", { name: "Turn the kill switch off" })).toBeDisabled();
  });

  it("saves the limits on use, the caps and the block lists", async () => {
    const saveControls = vi.fn(createMockStaffApi().saveControls);
    openStaff("/staff/controls", staffApi({ saveControls }));
    const sweep = await screen.findByLabelText("Sweep");
    await userEvent.clear(sweep);
    await userEvent.type(sweep, "1");
    await userEvent.clear(screen.getByLabelText(/Alarm when/));
    await userEvent.type(screen.getByLabelText(/Alarm when/), "40");
    await userEvent.click(screen.getByRole("button", { name: "Save limits" }));
    await waitFor(() => expect(saveControls).toHaveBeenCalledTimes(1));
    expect(saveControls.mock.calls[0]?.[0]).toMatchObject({
      concurrency: { scout: 4, sweep: 1, probe: 2, siege: 2 },
      dailySpendAlarmUsd: 40,
      scheduledScans: { maxActivePerAccount: 5, minSpacingHours: 24 },
    });

    const spend = screen.getByLabelText("Sweep Model spend (US$)");
    await userEvent.clear(spend);
    await userEvent.type(spend, "2.5");
    const pages = screen.getByLabelText("Scout Pages");
    await userEvent.clear(pages);
    await userEvent.click(screen.getByRole("button", { name: "Save caps" }));
    await waitFor(() => expect(saveControls).toHaveBeenCalledTimes(2));
    const caps = (
      saveControls.mock.calls[1]?.[0] as { caps: Record<string, Record<string, unknown>> }
    ).caps;
    expect(caps["sweep"]).toMatchObject({
      spendCapUsd: 2.5,
      tokenCap: { input: 600000, output: 30000 },
    });
    // A cleared cap means no fixed cap.
    expect(caps["scout"]?.["pageCap"]).toBeNull();

    await userEvent.type(
      screen.getByLabelText("Blocked target hosts"),
      "Evil.Example{enter}other.example",
    );
    await userEvent.type(screen.getByLabelText("Blocked email domains"), "spam.example");
    await userEvent.click(screen.getByRole("button", { name: "Save block lists" }));
    await waitFor(() => expect(saveControls).toHaveBeenCalledTimes(3));
    expect(saveControls.mock.calls[2]?.[0]).toEqual({
      blockedHosts: ["evil.example", "other.example"],
      blockedEmailDomains: ["spam.example"],
    });
  });

  it("rolls the learning layer back, pins and disables an entry, and shows the audit log", async () => {
    const rollbackLearning = vi.fn(createMockStaffApi().rollbackLearning);
    const setLearningEntry = vi.fn(createMockStaffApi().setLearningEntry);
    openStaff("/staff/controls", staffApi({ rollbackLearning, setLearningEntry }));
    expect(await screen.findByTestId("learning-state")).toHaveTextContent("version 2");
    await userEvent.click(screen.getByRole("button", { name: "Use v1" }));
    expect(rollbackLearning).toHaveBeenCalledWith(1);
    const entries = screen.getByTestId("learning-entries");
    await userEvent.click(within(entries).getAllByRole("button", { name: "Pin" })[0]!);
    expect(setLearningEntry).toHaveBeenCalledWith({
      kind: "item",
      id: "k-owasp-a01",
      pinned: true,
    });
    await userEvent.click(within(entries).getAllByRole("button", { name: "Disable" })[1]!);
    expect(setLearningEntry).toHaveBeenLastCalledWith({
      kind: "agent",
      id: "dyn-sourcemap",
      disabled: true,
    });
    expect(await screen.findByTestId("audit-log")).toHaveTextContent("set-controls");
  });
});

describe("Health", () => {
  it("shows spend against the alarm, runs in flight, mail and throttling", async () => {
    openStaff("/staff/health", staffApi());
    expect(await screen.findByTestId("health-spend")).toHaveTextContent("US$1.25");
    expect(screen.getByTestId("health-spend")).toHaveTextContent("Under the alarm of US$25.00");
    expect(within(screen.getByTestId("health-pools")).getAllByRole("row")).toHaveLength(5);
    expect(screen.getByTestId("health-stuck")).toHaveTextContent("None");
    expect(screen.getByTestId("health-ses")).toHaveTextContent("100 sent, 1 bounced (1.00%)");
    expect(screen.getByTestId("health-bedrock")).toHaveTextContent("3 throttled");
  });

  it("warns about stuck runs, a tripped alarm and unreadable metrics", async () => {
    openStaff(
      "/staff/health",
      staffApi({
        health: async () => ({
          ...MOCK_HEALTH,
          killSwitchOn: true,
          spendToday: { day: "2026-11-14", usd: 30, runs: 9, alarmUsd: 25, alarmed: true },
          stuckRuns: [
            {
              runId: "run_0stuck",
              tier: "probe",
              status: "running",
              startedAt: "2026-11-14T00:00:00.000Z",
              ageMinutes: 300,
            },
          ],
          ses: null,
          bedrock: null,
        }),
      }),
    );
    expect(await screen.findByTestId("health-spend")).toHaveTextContent(
      "Over the alarm of US$25.00 (staff were told)",
    );
    expect(screen.getByTestId("health-stuck")).toHaveTextContent("300 minutes");
    expect(screen.getByTestId("health-ses")).toHaveTextContent("Not available");
    expect(screen.getByRole("alert")).toHaveTextContent("kill switch is on");
  });
});
