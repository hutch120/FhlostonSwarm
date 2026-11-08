import { expect, type Page } from "@playwright/test";

const API = "http://localhost:8787";

let counter = 0;
/** A unique synthetic mailbox per call: swarm-test- local part, so it is plainly test data. */
export const testEmail = (domain = "example.com") =>
  `swarm-test-e2e-${Date.now().toString(36)}-${counter++}@${domain}`;

/** Reads the last mail the local API "sent" to the address. */
export async function lastMail(page: Page, to: string) {
  const res = await page.request.get(`${API}/__dev/mail?to=${encodeURIComponent(to)}`);
  expect(res.ok()).toBe(true);
  return (await res.json()) as { code: string; link: string };
}

export async function requestCode(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("Email address").fill(email);
  await page.getByRole("button", { name: "Email me a code" }).click();
  await expect(page.getByLabel("6-digit code")).toBeVisible();
}

/** Signs in through the real login screen against the local API. */
export async function signIn(page: Page, email = testEmail()) {
  await requestCode(page, email);
  const { code } = await lastMail(page, email);
  await page.getByLabel("6-digit code").fill(code);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Dashboard", level: 1 })).toBeVisible();
  return email;
}
