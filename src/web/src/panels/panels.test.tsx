import { fireEvent, render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import {
  AGENTS,
  AREAS,
  DEMO_RUN_ID,
  applyEvents,
  createRunState,
  replayEvents,
  type RunState,
  type TierId,
} from "@swarm/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ReplayPlayer } from "../replay/player.js";
import { usePlayerStore } from "../replay/useReplay.js";
import { useUiStore } from "../state/ui.js";
import { AgentDrawer } from "./AgentDrawer.js";
import { AreasPanel } from "./AreasPanel.js";
import { Counters } from "./Counters.js";
import { EventLog } from "./EventLog.js";
import { FindingsPanel } from "./FindingsPanel.js";
import { ReplayControls } from "./ReplayControls.js";

const fresh = (tier: TierId = "siege") =>
  createRunState({ runId: DEMO_RUN_ID, tier, areas: AREAS, agents: AGENTS });
const finished = (): RunState => applyEvents(fresh(), replayEvents);
const partway = (): RunState => applyEvents(fresh(), replayEvents.slice(0, 45));

describe("AreasPanel", () => {
  it("lists five areas with twelve agents, all waiting at the start", () => {
    render(<AreasPanel state={fresh()} selected={null} onSelect={() => {}} />);
    expect(screen.getAllByTestId("area")).toHaveLength(5);
    const chips = screen.getAllByTestId("agent-chip");
    expect(chips).toHaveLength(12);
    expect(chips.every((c) => c.getAttribute("data-status") === "idle")).toBe(true);
    for (const bar of screen.getAllByRole("progressbar")) {
      expect(bar).toHaveAttribute("aria-valuenow", "0");
    }
  });

  it("shows progress and agent status as the run advances", () => {
    render(<AreasPanel state={partway()} selected={null} onSelect={() => {}} />);
    const statuses = screen.getAllByTestId("agent-chip").map((c) => c.getAttribute("data-status"));
    expect(statuses).toContain("working");
    const values = screen
      .getAllByRole("progressbar")
      .map((b) => Number(b.getAttribute("aria-valuenow")));
    expect(Math.max(...values)).toBeGreaterThan(0);
  });

  it("reaches 100% everywhere when the run is finished", () => {
    render(<AreasPanel state={finished()} selected={null} onSelect={() => {}} />);
    for (const bar of screen.getAllByRole("progressbar")) {
      expect(bar).toHaveAttribute("aria-valuenow", "100");
    }
    expect(screen.getAllByTestId("agent-chip").every((c) => c.dataset["status"] === "done")).toBe(
      true,
    );
  });

  it("selects an agent when its chip is pressed", async () => {
    const onSelect = vi.fn();
    render(<AreasPanel state={fresh()} selected="tls" onSelect={onSelect} />);
    expect(screen.getByRole("button", { name: /^TLS/ })).toHaveAttribute("aria-pressed", "true");
    await userEvent.click(screen.getByRole("button", { name: /^IDOR/ }));
    expect(onSelect).toHaveBeenCalledWith("idor");
  });
});

describe("FindingsPanel", () => {
  it("shows an empty state before any finding", () => {
    render(<FindingsPanel state={fresh()} />);
    expect(screen.getByTestId("findings-count")).toHaveTextContent("0");
    expect(screen.queryAllByTestId("finding")).toHaveLength(0);
  });

  it("lists findings worst first with verified and unverified badges", () => {
    render(<FindingsPanel state={finished()} />);
    const items = screen.getAllByTestId("finding");
    expect(items).toHaveLength(11);
    expect(items.map((i) => i.dataset["severity"])).toEqual([
      "critical",
      "high",
      "high",
      "medium",
      "medium",
      "medium",
      "medium",
      "low",
      "low",
      "low",
      "info",
    ]);
    expect(within(items[0]!).getByText("F-01")).toBeInTheDocument();
    expect(within(items[0]!).getByText("Verified")).toBeInTheDocument();
    expect(screen.getAllByText("Verified")).toHaveLength(7);
    // The demo's failed cross-checks are shown as unconfirmed, the rest were never cross-checked.
    expect(screen.getAllByText("Unconfirmed")).toHaveLength(1);
    expect(screen.getAllByText("Unverified")).toHaveLength(3);
  });
});

describe("EventLog", () => {
  it("waits for the first event", () => {
    render(<EventLog state={fresh()} />);
    expect(screen.getByText(/waiting for the first event/i)).toBeInTheDocument();
  });

  it("shows the newest event first", () => {
    render(<EventLog state={finished()} />);
    const lines = within(screen.getByTestId("event-log")).getAllByRole("listitem");
    expect(lines[0]).toHaveTextContent(/run complete/i);
    expect(lines.length).toBeLessThanOrEqual(120);
  });

  it("describes findings and gaps", () => {
    render(<EventLog state={finished()} />);
    expect(screen.getAllByText(/could not test/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/scope gap/i).length).toBeGreaterThan(0);
  });
});

describe("Counters", () => {
  it("shows checks, requests, gaps and coverage", () => {
    render(<Counters state={finished()} />);
    expect(screen.getByTestId("checks-count")).toHaveTextContent("41");
    expect(screen.getByTestId("requests-count")).toHaveTextContent("974");
    expect(screen.getByTestId("gaps-count")).toHaveTextContent("3");
    const coverage = screen.getByRole("meter", { name: "Coverage" });
    expect(coverage).toHaveAttribute("aria-valuetext", "100%");
    expect(coverage).toHaveAttribute("aria-valuemax", "100");
  });

  it("starts at no coverage and never shows dollars or caps", () => {
    const { container } = render(<Counters state={fresh("scout")} />);
    expect(screen.getByRole("meter", { name: "Coverage" })).toHaveAttribute("aria-valuetext", "0%");
    expect(container).not.toHaveTextContent(/\$|budget|spend|cap/i);
  });
});

describe("AgentDrawer", () => {
  it("renders nothing without a selected agent", () => {
    const { container } = render(<AgentDrawer state={fresh()} agentId={null} onClose={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the agent's progress and recent steps", () => {
    render(<AgentDrawer state={finished()} agentId="authn" onClose={() => {}} />);
    expect(screen.getByRole("heading", { name: /login agent/i })).toBeInTheDocument();
    expect(screen.getByTestId("drawer-status")).toHaveTextContent("Done");
    expect(screen.getByText(/4 of 4 steps/)).toBeInTheDocument();
    expect(screen.getByText(/MFA enforcement/)).toBeInTheDocument();
  });

  it("closes", async () => {
    const onClose = vi.fn();
    render(<AgentDrawer state={fresh()} agentId="dns" onClose={onClose} />);
    await userEvent.click(screen.getByRole("button", { name: /close agent details/i }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("ReplayControls", () => {
  afterEach(() => {
    usePlayerStore.setState({
      player: null,
      playing: false,
      speed: 1,
      positionMs: 0,
      durationMs: 0,
      finished: false,
    });
  });

  const mount = () => {
    const player = new ReplayPlayer(replayEvents, { onEvent: () => {}, onReset: () => {} });
    usePlayerStore.setState({ player, ...player.snapshot });
    return player;
  };

  it("is disabled until a player exists", () => {
    render(<ReplayControls />);
    expect(screen.getByRole("button", { name: "Play" })).toBeDisabled();
  });

  it("plays, pauses and changes speed through the player", async () => {
    const player = mount();
    render(<ReplayControls />);
    await userEvent.click(screen.getByRole("button", { name: "4x" }));
    expect(player.snapshot.speed).toBe(4);
    await userEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(player.snapshot.playing).toBe(true);
  });

  it("scrubs and shows the clock", () => {
    const player = mount();
    render(<ReplayControls />);
    fireEvent.change(screen.getByRole("slider"), { target: { value: "20000" } });
    expect(player.snapshot.positionMs).toBe(20000);
  });

  it("switches motion mode", async () => {
    render(<ReplayControls />);
    await userEvent.selectOptions(screen.getByRole("combobox"), "low-power");
    expect(useUiStore.getState().motion).toBe("low-power");
    useUiStore.setState({ motion: "full" });
  });
});
