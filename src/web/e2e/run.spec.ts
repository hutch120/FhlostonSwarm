import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { signIn } from "./helpers.js";

const API = "http://localhost:8787";
const SITE = "http://localhost:5173";

const expected = JSON.parse(
  readFileSync(new URL("../../synthetic-target/expected.json", import.meta.url), "utf8"),
) as { findings: { agent: string; step: string; severity: string; titleIncludes: string }[] };

/**
 * A real run against the synthetic target, end to end through the real UI: the local API runs the
 * actual agent behind the actual scope proxy in-process (no AWS), so this covers start, the live view,
 * stop, the report and its download.
 */
async function newRun(page: Page, email: string): Promise<string> {
  const grant = await page.request.post(`${API}/__dev/grant`, {
    data: { to: email, tier: "sweep", count: 1 },
  });
  expect(grant.ok()).toBe(true);
  // The intake refuses loopback addresses, so the dev server saves the synthetic target directly.
  const seeded = await page.request.post(`${API}/__dev/seed-target`, { data: { to: email } });
  const { targetId } = (await seeded.json()) as { targetId: string };

  const session = await page.request.get(`${API}/api/auth/session`);
  const { csrfToken } = (await session.json()) as { csrfToken: string };
  const headers = { origin: SITE, "x-csrf-token": csrfToken, "content-type": "application/json" };
  const scan = await page.request.post(`${API}/api/scans`, {
    headers,
    data: {
      targetId,
      name: "Synthetic target",
      tier: "sweep",
      frequency: "once",
      timezone: "Australia/Sydney",
      notifyEmail: email,
      notifyOn: "never",
      loginSlots: ["user1"],
    },
  });
  expect(scan.status()).toBe(201);
  const { id: scanId } = (await scan.json()) as { id: string };
  const run = await page.request.post(`${API}/api/scans/${scanId}/run`, { headers, data: {} });
  expect(run.status()).toBe(201);
  return ((await run.json()) as { runId: string }).runId;
}

test.describe("a real run", () => {
  test("starts from its page, animates live, finds what the synthetic target is known to have, and the report downloads", async ({
    page,
  }) => {
    const email = await signIn(page);
    const runId = await newRun(page, email);

    await page.goto(`/runs/${runId}`);
    await expect(page.getByTestId("queued-note")).toContainText("credit is spent");
    await expect(page.getByTestId("run-status")).toHaveText("queued");
    await page.getByRole("button", { name: "Start run" }).click();

    // The live view: the tier's agents, working and finishing, with findings arriving.
    await expect(page.getByRole("heading", { name: "Live swarm view" })).toBeVisible();
    await expect(page.getByTestId("agent-chip")).toHaveCount(7);
    await expect(page.getByTestId("run-status")).toHaveText("running");
    await expect(page.getByTestId("transport")).toBeVisible();

    const banner = page.getByTestId("report-banner");
    await expect(banner).toContainText("Report assembled", { timeout: 60_000 });
    await expect(page.getByTestId("run-status")).toHaveText("complete");
    await expect(page.getByTestId("finding")).toHaveCount(expected.findings.length);
    await expect(page.getByRole("button", { name: "Stop run" })).toHaveCount(0);

    // The dashboard lists it with its report.
    await page.goto("/dashboard");
    const row = page.getByTestId("run-row").first();
    await expect(row).toContainText("complete");
    await expect(row).toContainText("127.0.0.1");

    // The report: every expected finding, what could not be tested, and a download.
    await row.getByRole("link", { name: "Report" }).click();
    await expect(page.getByRole("heading", { name: "Report", level: 1 })).toBeVisible();
    await expect(page.getByTestId("report-finding")).toHaveCount(expected.findings.length);
    for (const want of expected.findings) {
      await expect(
        page.getByTestId("report-finding").filter({ hasText: want.titleIncludes }),
      ).toHaveCount(1);
    }
    await expect(page.getByTestId("report-gaps")).toContainText("not available yet");

    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download HTML" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toBe(`swarm-report-${runId}.html`);
    const html = readFileSync((await file.path())!, "utf8");
    expect(html).toContain("Security assessment: 127.0.0.1");
    for (const want of expected.findings) expect(html).toContain(want.titleIncludes);
    expect(html).not.toContain("<script");
  });

  test("can be stopped while running: it closes as stopped with a partial report", async ({
    page,
  }) => {
    const email = await signIn(page);
    const runId = await newRun(page, email);
    await page.goto(`/runs/${runId}`);
    await page.getByRole("button", { name: "Start run" }).click();
    await expect(page.getByTestId("run-status")).toHaveText("running");

    await page.getByRole("button", { name: "Stop run" }).click();
    await expect(page.getByTestId("run-status")).toHaveText("stopped", { timeout: 30_000 });
    await expect(page.getByTestId("report-banner")).toContainText("Run stopped.");
    await expect(page.getByRole("button", { name: "Stop run" })).toHaveCount(0);

    await page.getByRole("link", { name: "Open the report" }).click();
    await expect(page.getByTestId("report-status")).toHaveText("stopped");
  });

  test("a run page survives a reload: it catches up from the log and still shows the result", async ({
    page,
  }) => {
    const email = await signIn(page);
    const runId = await newRun(page, email);
    await page.goto(`/runs/${runId}`);
    await page.getByRole("button", { name: "Start run" }).click();
    await expect(page.getByTestId("report-banner")).toContainText("Report assembled", {
      timeout: 60_000,
    });

    await page.reload();
    await expect(page.getByTestId("report-banner")).toContainText("Report assembled");
    await expect(page.getByTestId("finding")).toHaveCount(expected.findings.length);
    await expect(page.getByTestId("run-status")).toHaveText("complete");
  });
});
