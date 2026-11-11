import { chromium } from "playwright-core";

const FOOTER = `<div style="font-size:8px;width:100%;text-align:center;color:#666">
Automated security assessment &middot; page <span class="pageNumber"></span> of <span class="totalPages"></span></div>`;

/**
 * Renders a finished report to PDF with headless Chromium. The report is self-contained (no scripts,
 * no external requests), and the browser is given no way to reach a network anyway: every request is
 * refused and names are never resolved, so a hostile string in a report cannot call out.
 */
export async function renderPdf(
  html: string,
  executablePath = process.env["SWARM_CHROMIUM_PATH"],
): Promise<Buffer> {
  const browser = await chromium.launch({
    executablePath,
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--disable-extensions",
      "--disable-background-networking",
      "--host-resolver-rules=MAP * ~NOTFOUND",
    ],
  });
  try {
    const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: "block" });
    await context.route("**/*", (route) => route.abort("blockedbyclient"));
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: "load" });
    return await page.pdf({
      format: "A4",
      printBackground: true,
      margin: { top: "16mm", bottom: "18mm", left: "14mm", right: "14mm" },
      displayHeaderFooter: true,
      headerTemplate: "<span></span>",
      footerTemplate: FOOTER,
    });
  } finally {
    await browser.close().catch(() => undefined);
  }
}
