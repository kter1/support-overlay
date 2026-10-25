/** Capture the actual local fixture UI. Optional playwright-core + Chromium + ffmpeg required. */
const fs = require("fs");
const path = require("path");
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE || "playwright-core",
);

async function main() {
  const output = path.resolve(process.env.DEMO_OUTPUT || ".tmp/portfolio-demo");
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    headless: true,
    args: ["--no-sandbox"],
  });
  let context;
  try {
    context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
      recordVideo: { dir: output, size: { width: 1440, height: 1000 } },
    });
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("http://localhost:5173", { waitUntil: "networkidle" });
    const amount = page.getByRole("button", { name: /Amount:/ }).first();
    await amount.waitFor();
    // Recording-only captions, outside the product UI. No responses are mocked.
    async function caption(title, detail) {
      await page.evaluate(
        ({ title, detail }) => {
          let box = document.getElementById("recording-caption");
          if (!box) {
            box = document.createElement("div");
            box.id = "recording-caption";
            Object.assign(box.style, {
              position: "fixed",
              bottom: "38px",
              left: "252px",
              right: "416px",
              zIndex: "99999",
              background: "#233b38",
              color: "#fff",
              padding: "18px 24px",
              borderRadius: "12px",
              fontFamily: "system-ui",
              pointerEvents: "none",
              boxShadow: "0 4px 24px #0003",
            });
            document.body.appendChild(box);
          }
          box.replaceChildren();
          const heading = document.createElement("strong");
          heading.style.fontSize = "19px";
          heading.textContent = title;
          const description = document.createElement("div");
          description.style.marginTop = "6px";
          description.textContent = detail;
          box.append(heading, description);
        },
        { title, detail },
      );
    }
    await caption(
      "Support Overlay — customer words → merchant records",
      "Local prototype • fixture simulators • recorded against the running API and Postgres",
    );
    await page.waitForTimeout(4500);
    await page.mouse.move(680, 180);
    const amountBounds = await amount.boundingBox();
    await page.mouse.move(
      amountBounds.x + amountBounds.width / 2,
      amountBounds.y + amountBounds.height / 2,
      { steps: 24 },
    );
    await amount.hover();
    await page.getByRole("dialog").waitFor();
    await caption(
      "Explain the match before acting",
      "Hovering the customer’s amount reveals candidate records and the evidence behind the match.",
    );
    await page.screenshot({
      path: path.join(output, "01-amount-evidence.png"),
    });
    await page.waitForTimeout(6500);
    await page.mouse.move(1400, 100);
    const date = page.getByRole("button", { name: /Date:/ }).first();
    await date.hover();
    await page.getByRole("dialog").waitFor();
    await caption(
      "Ambiguity stays visible",
      "A date can match multiple records. The agent sees the alternatives instead of an unexplained guess.",
    );
    await page.screenshot({ path: path.join(output, "02-date-evidence.png") });
    await page.waitForTimeout(6500);
    await page.getByRole("button", { name: /Already refunded/ }).click();
    await page
      .getByText(/A refund was already issued/i)
      .first()
      .waitFor();
    await caption(
      "Catch duplicate refund risk across tickets",
      "Customer history surfaces an earlier confirmed refund before the agent acts.",
    );
    await page.screenshot({ path: path.join(output, "03-duplicate-risk.png") });
    await page.waitForTimeout(6500);
    await page.getByRole("button", { name: /Degraded/ }).click();
    await page
      .getByText(/Source record no longer available/i)
      .first()
      .waitFor();
    await caption(
      "Keep source failures visible",
      "Unavailable merchant records are marked explicitly; the preserved case evidence remains available to the agent.",
    );
    await page.screenshot({
      path: path.join(output, "04-source-unavailable.png"),
    });
    await page.waitForTimeout(6500);
    if (errors.length)
      throw new Error(`UI errors during recording: ${errors.join("; ")}`);
    const video = page.video();
    await context.close();
    context = null;
    await video.saveAs(path.join(output, "support-overlay-demo.webm"));
    console.log(`Recorded fixture demo and four screenshots in ${output}`);
  } finally {
    if (context) await context.close();
    await browser.close();
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
