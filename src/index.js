const sleep = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms).unref?.());
const TIMED_OUT = Symbol("timed out");

/**
 * A health check for a service. `checks` maps a name to a function (or `{ check, timeoutMs, critical }`) that throws or returns
 * false when something is wrong. A failing critical check (the default) makes the service "down"; a failing non-critical one
 * only "degraded". Results are cached for `cacheMs` and concurrent calls share one run, so a busy load balancer cannot
 * hammer your database. Error details are only included with `verbose: true`.
 */
export function createHealth({ checks = {}, timeoutMs = 2000, cacheMs = 1000, verbose = false, now = Date.now } = {}) {
  const entries = Object.entries(checks).map(([name, spec]) => {
    const def = typeof spec === "function" ? { check: spec } : spec;
    if (typeof def?.check !== "function") throw new TypeError(`createHealth: check "${name}" must be a function`);
    return [name, { check: def.check, timeoutMs: def.timeoutMs ?? timeoutMs, critical: def.critical ?? true }];
  });
  let cached = null;
  let running = null;

  async function runOne(name, def) {
    const started = now();
    let state = "up";
    let error;
    try {
      const outcome = await Promise.race([Promise.resolve().then(def.check), sleep(def.timeoutMs, TIMED_OUT)]);
      if (outcome === TIMED_OUT) {
        state = "down";
        error = `timed out after ${def.timeoutMs} ms`;
      } else if (outcome === false) {
        state = "down";
        error = "check returned false";
      }
    } catch (e) {
      state = "down";
      error = e?.message ?? String(e);
    }
    const result = { status: state, ms: now() - started, critical: def.critical };
    if (error && verbose) result.error = error;
    return [name, result];
  }

  async function execute() {
    const results = Object.fromEntries(await Promise.all(entries.map(([name, def]) => runOne(name, def))));
    const failed = Object.values(results).filter((r) => r.status === "down");
    const status = failed.some((r) => r.critical) ? "down" : failed.length > 0 ? "degraded" : "ok";
    return { status, checks: results, at: new Date(now()).toISOString() };
  }

  /** Runs the checks (or returns the cached result). */
  async function run() {
    if (cached && now() - cached.time < cacheMs) return cached.report;
    running ??= execute().then(
      (report) => {
        cached = { time: now(), report };
        running = null;
        return report;
      },
      (error) => {
        running = null;
        throw error;
      }
    );
    return running;
  }

  const send = (res, code, body) => {
    res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  return {
    run,
    /** Request handler for `/ready`: 200 for ok and degraded, 503 for down. */
    async ready(_req, res) {
      const report = await run();
      send(res, report.status === "down" ? 503 : 200, report);
    },
    /** Request handler for `/live`: 200 as long as the process can answer. No checks, so a slow database never restarts the app. */
    live(_req, res) {
      send(res, 200, { status: "ok" });
    }
  };
}
