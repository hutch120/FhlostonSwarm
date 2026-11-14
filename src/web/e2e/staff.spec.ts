import { expect, test } from "@playwright/test";
import { signIn, testEmail } from "./helpers.js";

test.describe("staff dashboard", () => {
  test("staff see the runs, cost analysis, users, controls and health screens", async ({
    page,
  }) => {
    await signIn(page, testEmail("fhlostonswarm.com"));
    await page.goto("/staff");
    await expect(page.getByTestId("staff-verified")).toContainText("confirmed you as staff");

    // The runs table is there (empty on a fresh local API), as are the filters.
    await expect(page.getByRole("heading", { name: "Runs", level: 2 })).toBeVisible();
    await expect(page.getByLabel("Paid by")).toBeVisible();

    await page.getByRole("link", { name: "Cost analysis" }).click();
    await expect(page.getByRole("heading", { name: "Pricing worksheet" })).toBeVisible();
    await expect(page.getByTestId("active-pricing")).not.toBeEmpty();
    await page.getByLabel("Margin over cost (%)").fill("25");

    await page.getByRole("link", { name: "Health" }).click();
    await expect(page.getByTestId("health-spend")).toContainText("US$0.00");
    // The local API has no CloudWatch.
    await expect(page.getByTestId("health-ses")).toContainText("Not available");

    await page.getByRole("link", { name: "Users and support" }).click();
    await page.getByLabel("Email address").fill("nobody@example.com");
    await page.getByRole("button", { name: "Look up" }).click();
    await expect(page.getByRole("alert")).toContainText("no longer exists");
  });

  test("a change in Controls is saved, applied by the server and logged", async ({ page }) => {
    await signIn(page, testEmail("fhlostonswarm.com"));
    await page.goto("/staff/controls");
    await expect(page.getByTestId("kill-state")).toContainText("Off.");

    await page.getByLabel("Blocked target hosts").fill("e2e-blocked.example");
    await page.getByRole("button", { name: "Save block lists" }).click();
    await expect(page.getByRole("status")).toContainText("block lists were saved");

    // The server holds it: a reload shows it, and the audit log has the entry.
    await page.reload();
    await expect(page.getByLabel("Blocked target hosts")).toHaveValue("e2e-blocked.example");
    await expect(page.getByTestId("audit-log")).toContainText("set-controls");

    // Put it back, as a shared environment must be left.
    await page.getByLabel("Blocked target hosts").fill("");
    await page.getByRole("button", { name: "Save block lists" }).click();
    await expect(page.getByRole("status")).toContainText("block lists were saved");
  });

  test("a customer is refused every staff call by the server", async ({ page }) => {
    await signIn(page);
    for (const path of ["runs", "costs", "controls", "health", "learning", "pricing", "audit"]) {
      expect((await page.request.get(`/api/staff/${path}`)).status(), path).toBe(403);
    }
  });
});
