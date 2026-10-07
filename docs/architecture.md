# Architecture

```text
Browser: editor + IndexedDB + tab credentials
                    │ same-origin JSON request
                    ▼
Node server: validate + bound + forward
                    │ bearer key for the selected connection
                    ▼
Decision provider: /v1/models or /v1/systemone
```

The Node server serves a fixed list of public assets and two relay routes: `POST /api/check` and `POST /api/evaluate`. `GET /api/bootstrap` supplies built-in examples and a per-process request token. `GET /healthz` checks the app itself. No workspace or credential files are written on the server.

Each API call carries the selected connection configuration. TypeSafe configuration is canonicalized on the server to its official URL and model. Custom destinations accept HTTP(S), reject embedded credentials/query strings, and never follow redirects. A TypeSafe key header is ignored for custom endpoints; custom bearer keys use a separate header. Upstream error text and successful replies are scrubbed for the credential used on that request before returning to the browser. This is not a substitute for reviewing sensitive content you deliberately place in a scenario.

One active request is allowed per normalized destination and key, with a global cap of 16. Cancellation propagates from the browser through the relay. Validation, size caps and timeouts apply before storing a result. Calls are never retried automatically.

IndexedDB holds custom connections, scenarios and the latest 30 runs. Saved scenario updates use one transaction and an expected revision, preventing a stale tab from overwriting another tab's edit. The draft is stored separately in local storage; keys use separate session-storage slots per endpoint. Removing a key cancels an active evaluation using it. Stored data belongs to the browser origin: a different hostname, scheme or port has a separate workspace.

The default server binds to loopback. Host checks and same-origin request checks protect against DNS rebinding and cross-site browser calls. Relay POSTs also require the bootstrap token. CSP permits scripts and connections only from the app's own origin; dynamic display values are escaped and no external scripts, fonts, or analytics are loaded.

To expose the app, set an explicit `APP_ORIGIN`, preserve its Host header at the reverse proxy, and add your own access control. Users who can access the app can instruct the relay to contact addresses reachable from its host. The app intentionally permits private network endpoints for local experimentation; it is not designed as an unrestricted public relay. An access gateway or an isolated deployment network is necessary when the audience is untrusted. Never enter a provider key into a deployment you do not trust: the relay operator can inspect traffic in memory.

## Source map

| Path | Responsibility |
| --- | --- |
| `server.mjs` | HTTP transport, bind settings, Host validation, shutdown |
| `lib/app.mjs` | Routes, response validation, concurrency, browser request token |
| `lib/provider.mjs` | Provider calls, key isolation, timeout, redaction |
| `public/app.js` | Editor, results, connection controls, imports and exports |
| `public/contract.js` | Shared parsing and decision contract validation |
| `public/connections.js` | Public connection schema and URL normalization |
| `public/workspace.js` | Browser storage and revision checks |
| `test/` | Local HTTP fixtures, regression tests, real-browser checks |
