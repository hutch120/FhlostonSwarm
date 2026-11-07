import { screen, waitFor, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "./App.js";
import { useSession } from "./state/session.js";
import { renderWithProviders } from "./test/render.js";

afterEach(() => {
  useSession.setState({ email: null, role: null });
});

const renderApp = (route: string) => renderWithProviders(<App />, { route });

describe("Login", () => {
  it("signs in with an email and a 6-digit code", async () => {
    renderApp("/login");
    await userEvent.type(screen.getByLabelText(/email address/i), "buyer@example.com");
    await userEvent.click(screen.getByRole("button", { name: /email me a code/i }));
    const code = await screen.findByLabelText(/6-digit code/i);
    const submit = screen.getByRole("button", { name: "Sign in" });
    expect(submit).toBeDisabled();
    await userEvent.type(code, "12a3456");
    expect(code).toHaveValue("123456");
    await userEvent.click(submit);
    expect(await screen.findByRole("heading", { name: "Dashboard" })).toBeInTheDocument();
    expect(useSession.getState()).toMatchObject({ email: "buyer@example.com", role: "user" });
  });
});

describe("Dashboard", () => {
  it("shows credits and past runs, and deletes a run after confirmation", async () => {
    renderApp("/dashboard");
    expect(await screen.findAllByTestId("run-row")).toHaveLength(2);
    expect(screen.getByTestId("credits")).toHaveTextContent("1 free Lite report remaining");

    await userEvent.click(screen.getByRole("button", { name: /delete run for staging/i }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm delete" }));
    await waitFor(() => expect(screen.getAllByTestId("run-row")).toHaveLength(1));
  });
});

describe("Intake", () => {
  it("lists four login slots and the tier information", () => {
    renderApp("/new");
    for (const label of ["Admin", "User 1", "User 2", "Other"]) {
      expect(screen.getByRole("group", { name: label })).toBeInTheDocument();
    }
    expect(screen.getByRole("heading", { name: /^Lite/ })).toBeInTheDocument();
    expect(screen.getByText(/never production/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/I am authorised to test/i)).not.toBeChecked();
  });

  it("only enables the chosen login on Lite and offers the others in Full", async () => {
    renderApp("/new");
    expect(screen.getByLabelText("Username", { selector: "#user1-username" })).toBeEnabled();
    expect(screen.getByLabelText("Username", { selector: "#admin-username" })).toBeDisabled();
    await userEvent.click(screen.getAllByLabelText(/use this login for the lite run/i)[0]!);
    expect(screen.getByLabelText("Username", { selector: "#admin-username" })).toBeEnabled();
    expect(screen.getByLabelText("Username", { selector: "#user1-username" })).toBeDisabled();
  });

  it("blocks an empty submission and reports each problem", async () => {
    renderApp("/new");
    await userEvent.click(screen.getByRole("button", { name: /start lite assessment/i }));
    expect(await screen.findByText(/enter a full url/i)).toBeInTheDocument();
    expect(screen.getByText(/must confirm you are authorised/i)).toBeInTheDocument();
    expect(screen.getByText("Username is required")).toBeInTheDocument();
    expect(screen.getByLabelText(/application url/i)).toHaveAttribute("aria-invalid", "true");
  });

  it("opens the demo run once the form is valid", async () => {
    renderApp("/new");
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
    await userEvent.click(screen.getByRole("button", { name: /start lite assessment/i }));
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

describe("Schedules", () => {
  it("is switched off", () => {
    renderApp("/schedules");
    expect(screen.getByText(/coming soon/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Create schedule" })).toBeDisabled();
    expect(screen.getByLabelText("Cadence")).toBeDisabled();
  });
});

describe("Account", () => {
  it("only enables account deletion after typing DELETE", async () => {
    renderApp("/account");
    const button = screen.getByRole("button", { name: "Delete my account" });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/to confirm/i), "DELETE");
    expect(button).toBeEnabled();
  });
});

describe("Staff", () => {
  it("is gated for everyone except staff", () => {
    renderApp("/staff");
    expect(screen.getByTestId("staff-denied")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Staff" })).not.toBeInTheDocument();
  });

  it("is gated for a normal customer", () => {
    useSession.getState().signIn("buyer@example.com");
    renderApp("/staff");
    expect(screen.getByTestId("staff-denied")).toBeInTheDocument();
  });

  it("opens for a staff email and adds the nav link", () => {
    useSession.getState().signIn("ops@fhlostonswarm.com");
    renderApp("/staff");
    expect(screen.getByTestId("staff-home")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Staff" })).toBeInTheDocument();
  });
});
