// setTimeout fires after 1 ms for anything above this, which would report a slow check as timed out at once.
const MAX_TIMER_MS = 2 ** 31 - 1;
const TIMED_OUT = Symbol("timed out");

/**
 * A health check for a service. `checks` maps a name to a function (or `{ check, timeoutMs, critical }`) that throws or returns
 * false when something is wrong; it gets an AbortSignal that aborts on timeout. A check is not called again while an earlier
 * call of it is still running. A failing critical check (the default) makes the service "down"; a failing non-critical one
 * only "degraded". Results are cached for `cacheMs` and concurrent calls share one run, so a busy load balancer cannot
 * hammer your database. Error details are only included with `verbose: true`.
 */
export function createHealth({ checks = {}, timeoutMs = 2000, cacheMs = 1000, verbose = false, now = Date.now } = {}) {
  const checkTimeout = (value, where) => {
    if (typeof value !== "number" || Number.isNaN(value) || value <= 0) throw new RangeError(`createHealth: ${where} must be a number of milliseconds above 0`);
    return Math.min(value, MAX_TIMER_MS);
  };
  const globalTimeout = checkTimeout(timeoutMs, "timeoutMs");
  if (typeof cacheMs !== "number" || Number.isNaN(cacheMs) || cacheMs < 0) throw new RangeError("createHealth: cacheMs must be a number of milliseconds, 0 or more");
  const entries = Object.entries(checks).map(([name, spec]) => {
    const def = typeof spec === "function" ? { check: spec } : spec;
    if (typeof def?.check !== "function") throw new TypeError(`createHealth: check "${name}" must be a function`);
    if (def.critical !== undefined && typeof def.critical !== "boolean") throw new TypeError(`createHealth: critical of check "${name}" must be true or false`);
    return [name, { check: def.check, timeoutMs: def.timeoutMs === undefined ? globalTimeout : checkTimeout(def.timeoutMs, `timeoutMs of check "${name}"`), critical: def.critical ?? true, inFlight: false }];
  });
  let cached = null;
  let running = null;

  async function runOne(name, def) {
    const started = now();
    let state = "up";
    let error;
    if (def.inFlight) {
      // The earlier call has not come back yet. Calling again would add one more hung call (and connection) per probe.
      state = "down";
      error = "the previous call of this check is still running";
    } else {
      const controller = new AbortController();
      let timer;
      const timedOut = new Promise((resolve) => {
        timer = setTimeout(resolve, def.timeoutMs, TIMED_OUT);
      });
      def.inFlight = true;
      const call = Promise.resolve().then(() => def.check(controller.signal));
      const settled = () => { def.inFlight = false; };
      call.then(settled, settled);
      try {
        const outcome = await Promise.race([call, timedOut]);
        if (outcome === TIMED_OUT) {
          state = "down";
          error = `timed out after ${def.timeoutMs} ms`;
          controller.abort(new Error(error));
        } else if (outcome === false) {
          state = "down";
          error = "check returned false";
        }
      } catch (e) {
        state = "down";
        error = e?.message ?? String(e);
      } finally {
        clearTimeout(timer);
      }
    }
    const result = { status: state, ms: Math.max(0, now() - started), critical: def.critical };
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
    const age = cached ? now() - cached.time : -1; // a clock that stepped back (negative age) does not keep the cache alive
    if (cached && age >= 0 && age < cacheMs) return cached.report;
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
    /** Request handler for `/ready`: 200 for ok and degraded, 503 for down (also when the run itself breaks). */
    async ready(_req, res) {
      let report;
      try {
        report = await run();
      } catch {
        if (!res.headersSent) send(res, 503, { status: "down" });
        return;
      }
      send(res, report.status === "down" ? 503 : 200, report);
    },
    /** Request handler for `/live`: 200 as long as the process can answer. No checks, so a slow database never restarts the app. */
    live(_req, res) {
      send(res, 200, { status: "ok" });
    }
  };
}
