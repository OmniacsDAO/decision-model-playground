# Contributing

Use Node 24 or newer. Start the app with `npm run dev`; frontend files are served directly, so refresh after changing them. Keep changes focused and include a short reproduction for bug fixes.

Before submitting a change:

```bash
npm test
npm run test:browser
npm run check:repo
```

Browser checks require Chrome or Chromium. Set `BROWSER_BIN` to its executable if necessary. Tests use dummy credentials and a local provider fixture, with temporary profiles that are removed afterward.

Keep provider logic in `lib/`, shared contract validation in `public/contract.js`, and browser persistence in `public/workspace.js`. Prefer small functions, native browser APIs and Node's built-in modules. Preserve keyboard access, clear error states and mobile layouts. Add regression coverage for behavior changes, especially storage, API compatibility or credential handling.

Use synthetic scenarios when reporting a bug. Include Node/browser versions, a minimal request and the observed behavior. Remove real keys, account data and private endpoint addresses from logs and screenshots. The repository check is a lightweight safeguard, not a complete secret scanner.
