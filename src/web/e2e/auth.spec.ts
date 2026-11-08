import { expect, test } from "@playwright/test";
import { lastMail, requestCode, signIn, testEmail } from "./helpers.js";

test.describe("auth", () => {
  test("signs in with an emailed code, survives a reload, and signs out", async ({ page }) => {
    const email = await signIn(page);
    await page.goto("/account");
    await expect(page.getByTestId("free-report")).toHaveText("1 free Lite report available");

    // The session survives a reload (cookies, not page state).
    await page.reload();
    await expect(page.getByRole("heading", { name: "Account", level: 1 })).toBeVisible();
    await expect(page.getByText(email).first()).toBeVisible();

    // The cookies are HttpOnly and not readable from the page.
    expect(await page.evaluate(() => document.cookie)).toBe("");

    await page.getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("heading", { name: "Sign in", level: 1 })).toBeVisible();
    await page.goto("/account");
    await expect(page.getByRole("heading", { name: "Sign in", level: 1 })).toBeVisible();
  });

  test("a wrong code is rejected with a clear message", async ({ page }) => {
    const email = testEmail();
    await requestCode(page, email);
    const { code } = await lastMail(page, email);
    await page.getByLabel("6-digit code").fill(code === "000000" ? "111111" : "000000");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("wrong or has expired");
  });

  test("the magic link signs in", async ({ page }) => {
    const email = testEmail();
    await requestCode(page, email);
    const { link } = await lastMail(page, email);
    await page.goto(new URL(link).pathname + new URL(link).search);
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Dashboard", level: 1 })).toBeVisible();
  });

  test("a customer cannot open the staff area, a staff mailbox can", async ({ page, browser }) => {
    await signIn(page);
    await page.goto("/staff");
    await expect(page.getByRole("heading", { name: "Staff only" })).toBeVisible();
    // The server says no, whatever the browser does.
    const denied = await page.request.get("/api/staff/whoami");
    expect(denied.status()).toBe(403);

    const context = await browser.newContext();
    const staffPage = await context.newPage();
    await signIn(staffPage, testEmail("fhlostonswarm.com"));
    await staffPage.goto("/staff");
    await expect(staffPage.getByTestId("staff-verified")).toContainText("confirmed you as staff");
    expect((await staffPage.request.get("/api/staff/whoami")).status()).toBe(200);
    await context.close();
  });

  test("the shared support address is never staff", async ({ page }) => {
    await signIn(page, "support@fhlostonswarm.com");
    expect((await page.request.get("/api/staff/whoami")).status()).toBe(403);
  });

  test("mutating API calls without the CSRF token are refused", async ({ page }) => {
    await signIn(page);
    const res = await page.request.post("/api/auth/logout", {
      data: {},
      headers: { origin: "http://localhost:5173" },
    });
    expect(res.status()).toBe(403);
    expect((await page.request.get("/api/me")).status()).toBe(200);
  });
});
