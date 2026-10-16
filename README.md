# @sandsoftwaresolutions/health

[![CI](https://github.com/SandSoftwareSolutions/ss-health/actions/workflows/ci.yml/badge.svg)](https://github.com/SandSoftwareSolutions/ss-health/actions/workflows/ci.yml)

Health checks for a service, the way a load balancer, Docker or Kubernetes wants them: a **live** endpoint that only says the process runs, and a **ready** endpoint that checks your database and friends. No dependencies.

## Install

```bash
npm install @sandsoftwaresolutions/health
```

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
- **Live is not ready.** `/live` never runs checks. If your database is slow, you want traffic held back (not ready) and not a restart (not live).
- **No leaks.** Error messages are left out unless you set `verbose: true`, because they can contain addresses and passwords. Use `verbose` for private networks only.
- Responses are `no-store`.

Pairs well with `@sandsoftwaresolutions/graceful`: after shutdown starts, answer 503 on `/ready`.
