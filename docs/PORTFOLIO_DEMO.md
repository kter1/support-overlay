# Support workspace demo

[Watch the recorded demo](media/support-overlay-demo.mp4).

The standalone application uses a ticket list, an annotated conversation, and a
resolution panel. Evidence, source freshness, prior-refund warnings, and real
available actions sit together. Smaller screens stack the panels; Zendesk keeps
a compact conversation-first layout with the same components and API behavior.

## What the recording demonstrates

1. Ticket #10006: read a refund request without an order number; hover `$39` to
   inspect the merchant records and the explanation behind the match.
2. Hover `8/1`: inspect every candidate instead of concealing ambiguity.
3. Ticket #10005: see the earlier confirmed refund directly above actions.
4. Ticket #10002: see unavailable source records and preserved case evidence.

This is the actual UI connected to the running API, worker, and PostgreSQL,
using **fixture simulators**. Captions are added only by the recording tool.
Responses are not intercepted, and the recorder does not submit actions or reset
data. The video does not demonstrate live Stripe, Shopify, Zendesk, or timeout
injection. Real Stripe verification is a separate milestone requiring a test key.

## Browser regression checks

Start the local stack with `npm run demo:start`; wait for `npm run demo:smoke`
to pass. The browser checks use isolated HTTP fixtures and a ZAF shim, so their
action checks never submit real actions or move money.

The cloud environment includes Chromium, ffmpeg, and an external Playwright
installation. From the repository root:

```bash
PLAYWRIGHT_MODULE=/opt/codex/cua_node/lib/node_modules/playwright-core \
  node scripts/test-workspace.cjs
```

Checks cover 1440px/1280px desktop, 900px stacked, 390px mobile, 320px embedded,
keyboard-accessible evidence and viewport bounds, failed load/retry, missing
conversation, late responses after ticket changes, transient action state,
transport retry idempotency, and embedded resize callbacks. Screenshots are
written to `.tmp/workspace-tests/`.

## Re-record

```bash
mkdir -p /workspace/.tools/playwright/ffmpeg-1011
test -e /workspace/.tools/playwright/ffmpeg-1011/ffmpeg-linux || \
  ln -s /usr/bin/ffmpeg /workspace/.tools/playwright/ffmpeg-1011/ffmpeg-linux
PLAYWRIGHT_BROWSERS_PATH=/workspace/.tools/playwright \
PLAYWRIGHT_MODULE=/opt/codex/cua_node/lib/node_modules/playwright-core \
  node scripts/record-demo.cjs
ffmpeg -y -i .tmp/portfolio-demo/support-overlay-demo.webm \
  -c:v libx264 -preset fast -crf 23 -pix_fmt yuv420p -movflags +faststart \
  .tmp/portfolio-demo/support-overlay-demo.mp4
```

Review the recording before copying it to `docs/media/support-overlay-demo.mp4`.
Check every scene, caption, and displayed warning. Keep fixture labeling visible
and exclude credentials, terminal output, and account details. Artifacts stay
ignored until deliberately copied into `docs/media/`.

For another machine, install `playwright-core` as external tooling and set
`PLAYWRIGHT_MODULE`, `CHROMIUM_PATH`, and `PLAYWRIGHT_BROWSERS_PATH` appropriately.
The ffmpeg cache revision must match the Playwright release. No browser tooling
is added to the application's production dependencies.
