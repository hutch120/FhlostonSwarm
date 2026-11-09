import { expect, test, type Page } from "@playwright/test";
import { signIn, testEmail } from "./helpers.js";

const API = "http://localhost:8787";

const grant = async (page: Page, to: string, tier: string, count: number) => {
  const res = await page.request.post(`${API}/__dev/grant`, { data: { to, tier, count } });
  expect(res.ok()).toBe(true);
};

async function fillIntake(page: Page, over: { notifyEmail?: string } = {}) {
  await page.goto("/new");
  await page.getByLabel("Application URL (required)").fill("https://staging.example.com");
  await page.getByLabel("Username", { exact: true }).nth(1).fill("swarm-test-user1");
  await page.locator("#user1-password").fill("not-a-real-password");
  await page.locator("#user1-description").fill("Standard customer");
  await page.getByLabel("How often?").selectOption("weekly");
  if (over.notifyEmail) await page.getByLabel("Email the report notice to").fill(over.notifyEmail);
  await page.getByLabel(/I am authorised to test/).check();
}

test.describe("intake, saved scans, credits and deletion", () => {
  test("a granted credit runs a saved scan, which can be run again, then everything is deleted", async ({
    page,
  }) => {
    const email = await signIn(page);
    await grant(page, email, "sweep", 2);

    // The intake shows the terms and how many credits are left.
    await page.goto("/new");
    await expect(page.getByTestId("credit-note")).toContainText("you have 2");
    await expect(page.getByRole("link", { name: "terms of use" })).toBeVisible();

    await fillIntake(page);
    await page.getByRole("button", { name: "Save and start scan" }).click();

    // The run is queued: its credit is spent, nothing executes yet.
    await expect(page.getByTestId("queued-note")).toContainText("credit is spent");
    await expect(page.getByTestId("run-status")).toHaveText("queued");

    await page.goto("/dashboard");
    await expect(page.getByTestId("credits")).toContainText("1 Sweep");
    await expect(page.getByTestId("run-row")).toHaveCount(1);
    await expect(page.getByTestId("run-row").first()).toContainText("queued");
    await expect(page.getByTestId("run-row").first()).toContainText("staging.example.com");

    // The scan is saved; run it again without re-entering anything.
    await page.goto("/scans");
    const row = page.getByTestId("scan-row");
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("Sweep");
    await expect(row).toContainText("Weekly");
    await row.getByRole("button", { name: /Run .* again/ }).click();
    await expect(page.getByTestId("queued-note")).toBeVisible();

    await page.goto("/dashboard");
    await expect(page.getByTestId("run-row")).toHaveCount(2);
    await expect(page.getByTestId("credits")).toContainText("0 Sweep");

    // With no credit left a third run is refused and nothing is added.
    await page.goto("/scans");
    await page
      .getByTestId("scan-row")
      .getByRole("button", { name: /Run .* again/ })
      .click();
    await expect(page.getByRole("alert")).toContainText("no credit");
    await page.goto("/dashboard");
    await expect(page.getByTestId("run-row")).toHaveCount(2);

    // Delete one run, then the scan, then the rest.
    await page
      .getByRole("button", { name: /Delete run for/ })
      .first()
      .click();
    await page.getByRole("button", { name: "Confirm delete" }).click();
    await expect(page.getByTestId("run-row")).toHaveCount(1);

    await page.goto("/scans");
    await page
      .getByRole("button", { name: /^Delete / })
      .first()
      .click();
    await page.getByRole("button", { name: "Confirm delete" }).click();
    await expect(page.getByTestId("scan-row")).toHaveCount(0);
    await page.getByRole("button", { name: /Delete target/ }).click();
    await page.getByRole("button", { name: "Confirm delete target" }).click();
    await expect(page.getByTestId("target-row")).toHaveCount(0);

    // Deleting the scan did not delete its past run.
    await page.goto("/dashboard");
    await expect(page.getByTestId("run-row")).toHaveCount(1);
    await expect(page.getByRole("button", { name: /Run again/ })).toHaveCount(0);
    await page.getByRole("button", { name: /Delete run for/ }).click();
    await page.getByRole("button", { name: "Confirm delete" }).click();
    await expect(page.getByTestId("run-row")).toHaveCount(0);
  });

  test("with no credit the scan is saved but not started, and says how to get one", async ({
    page,
  }) => {
    await signIn(page);
    await page.goto("/new");
    await expect(page.getByTestId("no-credit")).toContainText("no Sweep credits");
    await fillIntake(page);
    await page.getByRole("button", { name: "Save scan" }).click();
    await expect(page.getByRole("heading", { name: "Scans", level: 1 })).toBeVisible();
    await expect(page.getByTestId("scan-row")).toHaveCount(1);
    await page.goto("/dashboard");
    await expect(page.getByTestId("run-row")).toHaveCount(0);
    // Running it needs a credit.
    await page.goto("/scans");
    await page.getByRole("button", { name: /Run .* again/ }).click();
    await expect(page.getByRole("alert")).toContainText("no credit");
  });

  test("an unsafe target is refused on the field, and nothing is saved", async ({ page }) => {
    const email = await signIn(page);
    await grant(page, email, "sweep", 1);
    await fillIntake(page);
    await page.getByLabel("Application URL (required)").fill("http://169.254.169.254/latest");
    await page.getByRole("button", { name: /start scan/i }).click();
    await expect(page.getByText(/private or reserved/)).toBeVisible();
    await page.goto("/scans");
    await expect(page.getByTestId("scan-row")).toHaveCount(0);
    await expect(page.getByTestId("target-row")).toHaveCount(0);
  });

  test("another notification address is unconfirmed until its link is followed once", async ({
    page,
    browser,
  }) => {
    const email = await signIn(page);
    await grant(page, email, "sweep", 1);
    const notify = testEmail("example.org");
    await fillIntake(page, { notifyEmail: notify });
    await page.getByRole("button", { name: "Save and start scan" }).click();
    await expect(page.getByTestId("queued-note")).toBeVisible();

    await page.goto("/scans");
    await expect(page.getByTestId("scan-row")).toContainText("Unconfirmed");

    // The recipient may not be signed in anywhere: a fresh browser follows the link.
    const mail = await page.request.get(
      `${API}/__dev/confirmation?to=${encodeURIComponent(notify)}`,
    );
    const { link } = (await mail.json()) as { link: string };
    const url = new URL(link);
    const stranger = await browser.newContext();
    const other = await stranger.newPage();
    await other.goto(url.pathname + url.search);
    await other.getByRole("button", { name: "Confirm this address" }).click();
    await expect(other.getByTestId("notify-confirmed")).toBeVisible();
    // A second use fails.
    await other.goto(url.pathname + url.search);
    await other.getByRole("button", { name: "Confirm this address" }).click();
    await expect(other.getByRole("alert")).toContainText("expired or was already used");
    await stranger.close();

    await page.reload();
    await expect(page.getByTestId("scan-row")).not.toContainText("Unconfirmed");
  });

  test("editing a scan keeps the saved password hidden and does not start a run", async ({
    page,
  }) => {
    const email = await signIn(page);
    await grant(page, email, "sweep", 1);
    await fillIntake(page);
    await page.getByRole("button", { name: "Save and start scan" }).click();
    await expect(page.getByTestId("queued-note")).toBeVisible();

    await page.goto("/scans");
    await page.getByRole("link", { name: /^Edit / }).click();
    await expect(page.getByRole("heading", { name: "Edit scan" })).toBeVisible();
    await expect(page.locator("#user1-password")).toHaveValue("");
    await expect(page.locator("#user1-password")).toHaveAttribute("placeholder", /Saved/);
    expect(await page.content()).not.toContain("not-a-real-password");
    await page.getByLabel("Scan name (optional)").fill("Renamed scan");
    await page.getByLabel(/I am authorised to test/).check();
    await page.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByTestId("scan-row")).toContainText("Renamed scan");
    await page.goto("/dashboard");
    await expect(page.getByTestId("run-row")).toHaveCount(1);
    await expect(page.getByTestId("credits")).toContainText("0 Sweep");
  });

  test("deleting the account needs the emailed code and removes everything", async ({
    page,
    browser,
  }) => {
    const email = await signIn(page);
    await grant(page, email, "sweep", 1);
    await fillIntake(page);
    await page.getByRole("button", { name: "Save and start scan" }).click();
    await expect(page.getByTestId("queued-note")).toBeVisible();

    await page.goto("/account");
    await page.getByLabel(/to confirm/).fill("DELETE");
    await page.getByRole("button", { name: "Email me a deletion code" }).click();

    // A wrong code changes nothing.
    await page.getByLabel(/6-digit code/).fill("000000");
    await page.getByRole("button", { name: "Delete my account" }).click();
    await expect(page.getByRole("alert")).toContainText("wrong or has expired");

    const res = await page.request.get(
      `${API}/__dev/deletion-code?to=${encodeURIComponent(email)}`,
    );
    const { code } = (await res.json()) as { code: string };
    await page.getByLabel(/6-digit code/).fill(code);
    await page.getByRole("button", { name: "Delete my account" }).click();
    await expect(page.getByRole("heading", { name: "Sign in", level: 1 })).toBeVisible();

    // Signing in again finds an empty account.
    const fresh = await browser.newContext();
    const again = await fresh.newPage();
    await signIn(again, email);
    await again.goto("/scans");
    await expect(again.getByTestId("scan-row")).toHaveCount(0);
    await again.goto("/dashboard");
    await expect(again.getByTestId("run-row")).toHaveCount(0);
    await expect(again.getByTestId("credits")).toContainText("0 Sweep");
    await fresh.close();
  });

  test("the terms and privacy notice are public", async ({ page }) => {
    await page.goto("/privacy");
    await expect(page.getByRole("heading", { name: "Privacy notice" })).toBeVisible();
    await expect(page.getByText(/anonymised cost records/i)).toBeVisible();
    await page.goto("/terms");
    await expect(page.getByRole("heading", { name: "Terms of use" })).toBeVisible();
  });
});
