# @sandsoftwaresolutions/health

[![CI](https://github.com/SandSoftwareSolutions/ss-health/actions/workflows/ci.yml/badge.svg)](https://github.com/SandSoftwareSolutions/ss-health/actions/workflows/ci.yml)

Health checks for a service, the way a load balancer, Docker or Kubernetes wants them: a **live** endpoint that only says the process runs, and a **ready** endpoint that checks your database and friends. No dependencies.

## Install

```bash
npm install @sandsoftwaresolutions/health
```

Works with `import` and `require()`, and ships TypeScript types for both.

## Usage

```js
import { createServer } from "node:http";
import { createHealth } from "@sandsoftwaresolutions/health";

const health = createHealth({
  checks: {
    database: () => db.prepare("SELECT 1").get(),
    disk: () => freeSpaceMb() > 100,                              // return false to fail
    mail: { check: pingSmtp, critical: false, timeoutMs: 5000 }   // may fail without taking the service down
  },
  timeoutMs: 2000,
  cacheMs: 1000
});

createServer((req, res) => {
  if (req.url === "/live") return health.live(req, res);
  if (req.url === "/ready") return health.ready(req, res);
  /* ... */
}).listen(3000);
```

`GET /ready` answers with

```json
{ "status": "ok", "checks": { "database": { "status": "up", "ms": 1, "critical": true } }, "at": "2026-10-17T10:00:00.000Z" }
```

## How it behaves

- **ok / degraded / down.** A failing *critical* check (the default) makes the service `down` (HTTP 503). A failing non-critical one only makes it `degraded` (still HTTP 200), so a broken mail server does not get your app restarted.
- **A check passes** when it returns without throwing and does not return `false`. It fails when it throws, returns `false`, or takes longer than its timeout.
- **Caching.** Results are cached for `cacheMs` and simultaneous requests share one run, so a busy load balancer cannot hammer your database.
- **A hung check is not piled up.** A check that is still running from an earlier probe is not called again: it is reported `down` ("the previous call of this check is still running") until it comes back. Otherwise every probe would add one more hung call to your database. Each check also gets an `AbortSignal` (`check(signal)`) that aborts when it times out, so a check can cancel its own work. Give a check its own timeout if it can hang for ever, because until it settles it stays `down`.
- **Timeouts** must be a number above 0 (`RangeError` otherwise); a very large one is cut to 2^31-1 ms. A clock that steps back does not freeze the cache.
- **Live is not ready.** `/live` never runs checks. If your database is slow, you want traffic held back (not ready) and not a restart (not live).
- **No leaks.** Error messages are left out unless you set `verbose: true`, because they can contain addresses and passwords. Use `verbose` for private networks only.
- Responses are `no-store`. The check names, their status and timing are in the answer: put `/ready` where only your orchestrator can reach it, or name checks so that they reveal little. If the run itself breaks, `/ready` answers `503 {"status":"down"}`.

Pairs well with `@sandsoftwaresolutions/graceful`: after shutdown starts, answer 503 on `/ready`.
