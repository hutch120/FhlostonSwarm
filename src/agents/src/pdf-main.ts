import { InternalApi, identityFromEnv } from "./internal.js";
import { renderPdf } from "./pdf.js";

/**
 * The PDF step's entrypoint (same image as the agent task): read the closed run's report, render it
 * to PDF with headless Chromium and hand it back. Best effort: the run does not depend on it.
 */
async function main(): Promise<void> {
  const api = new InternalApi(identityFromEnv());
  const html = await api.getReportHtml();
  const pdf = await renderPdf(html);
  await api.postReportPdf(pdf);
  console.log(JSON.stringify({ msg: "pdf_rendered", bytes: pdf.length }));
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(JSON.stringify({ msg: "pdf_failed", error: (err as Error).message }));
    process.exit(1);
  },
);
