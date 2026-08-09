# Installing the Zendesk app

The sidebar ships as a Zendesk Apps Framework (ZAF) v2 app. Installed, it reads
the current ticket from Zendesk and calls the resolution service through
Zendesk's server-side proxy.

## Why the proxy matters

The app never holds a usable credential in the browser.

Backend calls go out with `secure: true`, so the `Authorization` header is
written as `Bearer {{setting.backend_token}}` and Zendesk substitutes the stored
secure setting on its own servers before forwarding the request. The token is
never present in the bundle, in devtools, or in any response an agent can read.

That is why `backend_token` is declared `"secure": true` in `manifest.json`, and
why `npm run app:package` refuses to build if a credential-shaped parameter is
missing that flag. A token shipped in a frontend bundle is a published
credential — every agent with devtools would have your tenant's write access.

Tenancy follows from the token: each token maps to exactly one tenant and role
in `api_credentials`. Installing the app in a second Zendesk account means
issuing a second token, not changing any code.

## Build the package

```bash
npm run app:package
```

Produces `dist/zendesk-app.zip`:

```
manifest.json
assets/index.html      ← sidebar entry
assets/index-*.js      ← bundle
assets/logo.png        ← placeholder, replace before publishing
translations/en.json   ← install-screen copy
```

Validate the manifest on its own with `npm run app:validate`.

## Install

1. Issue an agent token for the account and provision it:
   ```bash
   export AGENT_TOKEN="$(openssl rand -hex 24)"
   npm run db:seed          # stores only the SHA-256 hash
   ```
2. In Zendesk: **Admin Center → Apps and integrations → Zendesk Support apps →
   Upload private app**.
3. Upload `dist/zendesk-app.zip`.
4. Fill in the two settings:
   - **Resolution service URL** — base URL of the API, e.g.
     `https://overlay.example.com`. Must be reachable from Zendesk's servers,
     not just from your network.
   - **Agent token** — the `AGENT_TOKEN` value. Stored encrypted by Zendesk.
5. Open any ticket. The card appears in the right sidebar.

With `zcli` installed you can iterate without re-uploading:

```bash
cd dist/zendesk-app && zcli apps:server
```

Then append `?zcli_apps=true` to a ticket URL to load the local build.

## Behaviour once installed

- Ticket id, agent id, and account subdomain come from ZAF context — there is no
  ticket picker.
- The iframe resizes to its content via `client.invoke("resize")`; Zendesk's
  default height would otherwise clip the card.
- Switching tickets re-reads context on `app.activated` rather than requiring a
  reload.
- Failures are shown as what to do next ("Ask an admin to check the app
  settings"), not as HTTP status codes.

## Standalone demo mode

Run outside Zendesk (`npm run demo:start`), the same bundle detects that the ZAF
SDK is absent, shows a labelled **DEMO MODE** panel with a scenario picker, and
calls the API directly using `VITE_AGENT_TOKEN`.

That build-time token is acceptable for a localhost demo and nowhere else. Any
real install must go through the app package so the credential stays in
Zendesk's secure settings.

## Before submitting to the Marketplace

Not done in this repo:

- `assets/logo.png` is a generated solid-colour placeholder. Marketplace
  submissions need real artwork, plus marketing assets Zendesk requests
  separately.
- `manifest.json` sets `"private": true`. A public listing removes that and
  requires a Zendesk security review.
- The app has not been loaded in a live Zendesk instance. Everything here is
  built to the documented ZAF v2 contract and the package structure is verified
  by `npm run app:package`, but the install flow itself is unexercised.
