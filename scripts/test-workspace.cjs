/** Browser regressions. Uses isolated HTTP fixtures; never submits real actions. */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require(
  process.env.PLAYWRIGHT_MODULE || "playwright-core",
);
const base = process.env.DEMO_BASE_URL || "http://localhost:5173";
const output = path.resolve(".tmp/workspace-tests");

function fixture(id = "10006") {
  const body = `Please refund $39 for my order on 8/1. Ticket #${id}.`;
  const candidate = {
    provider: "stripe",
    recordType: "charge",
    reference: "ch_test",
    status: "succeeded",
    amountCents: 3900,
    currency: "usd",
    occurredAt: "2026-08-01T12:00:00Z",
    description: "Test purchase",
  };
  return {
    issueId: `issue-${id}`,
    zendeskTicketId: id,
    issueState: "OPEN",
    matchBand: "HIGH",
    confidenceScore: 0.94,
    freshness: { is_fresh: true },
    lastRebuiltAt: "2026-10-25T12:00:00Z",
    availableCtas: [
      {
        actionType: "CLOSE_CONFIRMED",
        label: "Mark as resolved",
        requiresApproval: false,
        disabled: false,
      },
      {
        actionType: "ESCALATE",
        label: "Escalate for review",
        requiresApproval: false,
        disabled: false,
      },
    ],
    context: {
      primary_ask: "refund_request",
      message_count: 1,
      thread: [
        {
          source_id: `message-${id}`,
          kind: "comment",
          author_role: "customer",
          body,
          created_at: "2026-10-25T11:00:00Z",
          annotations: [
            {
              start: 14,
              end: 17,
              kind: "money",
              display: "$39.00",
              excerpt: "$39",
              confidence: 0.94,
              author_role: "customer",
              candidates: [
                candidate,
                {
                  ...candidate,
                  provider: "shopify",
                  reference: "#123",
                  recordType: "order",
                },
              ],
              matched_on: "amount",
            },
          ],
        },
      ],
    },
  };
}

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium",
    args: ["--no-sandbox"],
  });
  let passed = 0;
  const check = (name) => {
    passed++;
    console.log(`PASS ${name}`);
  };
  try {
    const context = await browser.newContext();
    await context.route("https://static.zdassets.com/**", (route) =>
      route.fulfill({ body: "" }),
    );
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (e) => errors.push(e.message));
    let mode = "normal";
    let release;
    let delayed;
    let actionKeys = [];
    await page.route("**/api/v1/card/*", async (route) => {
      const id = new URL(route.request().url()).pathname.split("/").pop();
      if (mode === "delay")
        await new Promise((resolve) => {
          release = resolve;
          delayed = id;
        });
      if (mode === "error")
        return route.fulfill({
          status: 500,
          json: { error: "Temporary failure" },
        });
      const data = fixture(id);
      if (mode === "empty") data.context = null;
      await route.fulfill({ json: data });
    });
    await page.route("**/api/v1/actions", async (route) => {
      actionKeys.push(route.request().postDataJSON().idempotency_key);
      if (actionKeys.length === 1) return route.abort("failed");
      await route.fulfill({ json: { outcome: "EXECUTED" } });
    });
    await page.goto(base);
    await page.locator('[data-layout="workspace"]').waitFor();
    assert.equal(await page.locator(".message-body").count(), 1);
    check("one conversation with workspace presentation");
    for (const width of [1440, 1280, 900, 390]) {
      await page.setViewportSize({ width, height: 900 });
      const bounds = await page.locator(".conversation-panel").boundingBox();
      const resolution = await page.locator(".resolution-panel").boundingBox();
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        true,
      );
      if (width >= 1100) assert(resolution.x > bounds.x + bounds.width);
      else assert(resolution.y >= bounds.y + bounds.height);
      if (width < 760) assert(await page.locator("#ticket-picker").isVisible());
      await page.screenshot({
        path: path.join(output, `workspace-${width}.png`),
      });
      check(`${width}px layout without overflow`);
    }
    const amount = page.getByRole("button", { name: /Amount:/ });
    await amount.focus();
    await page.getByRole("dialog").waitFor();
    assert.match(await page.getByRole("dialog").innerText(), /2 records match/);
    assert.match(await page.getByRole("dialog").innerText(), /\$39\.00/);
    const popup = await page.getByRole("dialog").boundingBox();
    assert(
      popup.x >= 0 &&
        popup.x + popup.width <= 390 &&
        popup.y >= 0 &&
        popup.y + popup.height <= 900,
    );
    await page.keyboard.press("Escape");
    assert.equal(await page.getByRole("dialog").count(), 0);
    check("keyboard inspection, ambiguity and viewport-clamped popover");

    await page
      .getByRole("button", { name: "Mark as resolved", exact: true })
      .click();
    await page.getByText(/Couldn't reach the server/).waitFor();
    await page
      .getByRole("button", { name: "Mark as resolved", exact: true })
      .click();
    await page.getByText("Action submitted", { exact: true }).waitFor();
    assert.equal(actionKeys.length, 2);
    assert.equal(actionKeys[0], actionKeys[1]);
    check("action transport retry retains its idempotency key");
    await page.locator("#ticket-picker").selectOption("10001");
    await page.locator(".eyebrow").filter({ hasText: "10001" }).waitFor();
    await page.locator('[data-layout="workspace"]').waitFor();
    assert.equal(
      await page.getByText("Action submitted", { exact: true }).count(),
      0,
    );
    check("ticket changes reset transient action results");

    mode = "error";
    await page.locator("#ticket-picker").selectOption("10002");
    await page.getByRole("alert").waitFor();
    mode = "normal";
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await page.locator('[data-layout="workspace"]').waitFor();
    check("failed load and explicit retry");
    mode = "empty";
    await page.locator("#ticket-picker").selectOption("10005");
    await page
      .getByText(
        "The ticket thread could not be read, so there is nothing to annotate.",
      )
      .waitFor();
    check("missing conversation stays explicit");

    // Hold an old request, switch tickets, then deliver it after the new one.
    mode = "delay";
    await page.locator("#ticket-picker").selectOption("10003");
    await page.getByRole("status").waitFor();
    while (!release) await page.waitForTimeout(20);
    const oldRelease = release;
    assert.equal(delayed, "10003");
    mode = "normal";
    await page.locator("#ticket-picker").selectOption("10006");
    await page.locator('[data-layout="workspace"]').waitFor();
    oldRelease();
    await page.waitForTimeout(150);
    assert.match(await page.locator(".eyebrow").innerText(), /10006/);
    assert.match(
      await page.locator(".message-body").innerText(),
      /Ticket #10006/,
    );
    assert.doesNotMatch(await page.locator("body").innerText(), /NaN/);
    check("late previous-ticket responses cannot replace current data");

    // Frame the real entrypoint with a ZAF shim, using a different URL ticket.
    const embedded = await browser.newContext({
      viewport: { width: 320, height: 1000 },
    });
    await embedded.route("https://static.zdassets.com/**", (route) =>
      route.fulfill({ body: "" }),
    );
    await embedded.addInitScript(
      ({ data }) => {
        if (window.self === window.top) return;
        window.resizeCalls = [];
        const client = {
          get: async () => ({
            "ticket.id": "10006",
            "currentUser.id": "test-agent",
          }),
          context: async () => ({ account: { subdomain: "test" } }),
          invoke: async (...args) => {
            window.resizeCalls.push(args);
          },
          on: () => {},
          metadata: async () => ({}),
          request: async () => ({ status: 200, responseJSON: data }),
        };
        Object.defineProperty(window, "ZAFClient", {
          configurable: true,
          get: () => ({ init: () => client }),
          set: () => {},
        });
      },
      { data: fixture() },
    );
    await embedded.route("**/__workspace-test-host", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: `<html><body style="margin:0"><iframe title="Zendesk sidebar" src="${base}/?ticket=10001" style="border:0;width:320px;height:1000px"></iframe></body></html>`,
      }),
    );
    const host = await embedded.newPage();
    await host.goto(`${base}/__workspace-test-host`);
    const frame = host.frameLocator("iframe");
    await frame.locator('[data-layout="compact"]').waitFor();
    assert.equal(await frame.locator(".workspace").count(), 0);
    await frame.getByRole("button", { name: "Transaction & evidence" }).click();
    await frame.getByRole("region", { name: "Merchant evidence" }).waitFor();
    const iframe = host.frames().find((f) => f.url().includes("?ticket="));
    assert.equal(
      await iframe.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    assert((await iframe.evaluate(() => window.resizeCalls.length)) > 0);
    const compactAmount = frame.getByRole("button", { name: /Amount:/ });
    await compactAmount.focus();
    await frame.getByRole("dialog").waitFor();
    const compactPopup = await frame.getByRole("dialog").boundingBox();
    assert(compactPopup.x >= 0 && compactPopup.x + compactPopup.width <= 320);
    await host.screenshot({ path: path.join(output, "embedded-320.png") });
    check("compact Zendesk presentation, resizing and narrow evidence dialog");
    assert.deepEqual(errors, []);
    await embedded.close();
    await context.close();
    console.log(`${passed} browser checks passed`);
  } finally {
    await browser.close();
  }
}
main().catch((e) => {
  console.error(e.stack);
  process.exitCode = 1;
});
