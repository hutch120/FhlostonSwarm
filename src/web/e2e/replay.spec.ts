import { expect, test } from "@playwright/test";
import { signIn } from "./helpers.js";

test.describe("replay smoke test", () => {
  test("agents appear, findings accumulate and the report is assembled", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));

    await page.goto("/demo?speed=16");
    await expect(page.getByRole("heading", { name: "Live swarm view" })).toBeVisible();

    // Twelve agents across five areas are on screen.
    await expect(page.getByTestId("agent-chip")).toHaveCount(12);
    await expect(page.getByTestId("area")).toHaveCount(5);
    await expect(page.getByTestId("swarm-canvas")).toBeVisible();

    // An agent starts working, then findings accumulate.
    await expect(
      page.locator('[data-testid="agent-chip"][data-status="working"]').first(),
    ).toBeVisible();
    await expect(page.getByTestId("finding").first()).toBeVisible();
    const early = await page.getByTestId("finding").count();
    await expect.poll(() => page.getByTestId("finding").count()).toBeGreaterThan(early);

    // The run ends in the assembled-report state with every agent done.
    await expect(page.getByTestId("report-banner")).toContainText("Report assembled", {
      timeout: 30_000,
    });
    await expect(page.getByTestId("run-status")).toHaveText("complete");
    await expect(page.getByTestId("finding")).toHaveCount(11);
    await expect(page.locator('[data-testid="agent-chip"][data-status="done"]')).toHaveCount(12);
    await expect(page.getByTestId("checks-count")).toHaveText("41");

    expect(errors).toEqual([]);
  });

  test("opens an agent drawer with a disabled steering box", async ({ page }) => {
    await page.goto("/demo?speed=16");
    await page.getByRole("button", { name: /^IDOR/ }).click();
    const drawer = page.getByTestId("agent-drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer.getByLabel("Steer this agent")).toBeDisabled();
  });

  test("replay controls restart the run", async ({ page }) => {
    await page.goto("/demo?speed=16");
    await expect(page.getByTestId("report-banner")).toBeVisible({ timeout: 30_000 });
    await page.getByRole("button", { name: "Restart" }).click();
    await expect(page.getByTestId("report-banner")).toBeHidden();
    await expect(page.getByTestId("finding")).toHaveCount(0);
  });

  test("honours prefers-reduced-motion with a still canvas", async ({ browser }) => {
    const context = await browser.newContext({ reducedMotion: "reduce" });
    const page = await context.newPage();
    await page.goto("/demo?autoplay=0");
    await expect(page.getByTestId("swarm-canvas")).toHaveAttribute("data-motion", "reduced");
    await expect(page.getByRole("combobox")).toHaveValue("reduced");
    await context.close();
  });

  test("can reach the report from the finished run", async ({ page }) => {
    await signIn(page);
    await page.goto("/demo?speed=16");
    await page.getByRole("link", { name: "Open the report" }).click({ timeout: 30_000 });
    await expect(page.getByRole("heading", { name: "Report", exact: true })).toBeVisible();
    await expect(page.getByRole("table")).toBeVisible();
  });
});

test.describe("static screens", () => {
  for (const [path, heading] of [
    ["/dashboard", "Dashboard"],
    ["/new", "New assessment"],
    ["/account", "Account"],
    ["/schedules", "Schedules"],
  ] as const) {
    test(`${path} renders once signed in`, async ({ page }) => {
      await signIn(page);
      await page.goto(path);
      await expect(page.getByRole("heading", { name: heading, level: 1 })).toBeVisible();
    });
  }

  for (const [path, heading] of [
    ["/login", "Sign in"],
    ["/staff", "Staff only"],
  ] as const) {
    test(`${path} renders for a visitor`, async ({ page }) => {
      await page.goto(path);
      await expect(page.getByRole("heading", { name: heading, level: 1 })).toBeVisible();
    });
  }

  test("protected screens send a visitor to sign in", async ({ page }) => {
    await page.goto("/dashboard");
    await expect(page.getByRole("heading", { name: "Sign in", level: 1 })).toBeVisible();
  });
});
