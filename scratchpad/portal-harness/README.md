Render the real client portal and admin against a fake Supabase, at a real phone size.

    node scratchpad/portal-harness/build-mock.js /tmp/portalmock
    VW=390 WAIT=5000 node scratchpad/cdp.js file:///tmp/portalmock/mock.html "document.title" shot.png

- `cdp.js` (one level up) drives Chrome over DevTools with true device emulation. `--window-size`
  cannot go below ~500px on macOS, so it is the only way to see a 390px layout.
- Env: `VW`/`VH` viewport, `WAIT` ms before evaluating, `FULL=1` full-page screenshot.
- `window.__errs` collects page errors; check it in every probe.
- Fixtures ignore filters: every query on a table returns all of its rows.
