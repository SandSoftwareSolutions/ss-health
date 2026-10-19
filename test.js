import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { test } from "node:test";

import { createHealth } from "./src/index.js";

const never = () => new Promise(() => {});

test("ok, degraded and down", async () => {
  assert.equal((await createHealth({ checks: { db: () => true } }).run()).status, "ok");
  const degraded = await createHealth({ checks: { db: () => true, mail: { check: () => { throw new Error("smtp"); }, critical: false } } }).run();
  assert.equal(degraded.status, "degraded");
  assert.equal(degraded.checks.mail.status, "down");
  const down = await createHealth({ checks: { db: () => false } }).run();
  assert.equal(down.status, "down");
  assert.equal((await createHealth().run()).status, "ok");
});

test("a hanging check times out and is reported as down", async () => {
  const health = createHealth({ checks: { slow: never }, timeoutMs: 50, verbose: true });
  const report = await health.run();
  assert.equal(report.status, "down");
  assert.match(report.checks.slow.error, /timed out after 50 ms/);
});

test("error details are hidden unless verbose", async () => {
  const quiet = await createHealth({ checks: { db: () => { throw new Error("password=hunter2"); } } }).run();
  assert.equal(quiet.checks.db.error, undefined);
  assert.ok(!JSON.stringify(quiet).includes("hunter2"));
  const loud = await createHealth({ checks: { db: () => { throw new Error("boom"); } }, verbose: true }).run();
  assert.equal(loud.checks.db.error, "boom");
});

test("results are cached and concurrent calls share one run", async () => {
  let calls = 0;
  let t = 1000;
  const health = createHealth({ checks: { db: async () => { calls++; await new Promise((r) => setTimeout(r, 20)); } }, cacheMs: 500, now: () => t });
  await Promise.all([health.run(), health.run(), health.run()]);
  assert.equal(calls, 1);
  await health.run();
  assert.equal(calls, 1);
  t += 600;
  await health.run();
  assert.equal(calls, 2);
});

test("checks run in parallel", async () => {
  const wait = () => new Promise((r) => setTimeout(r, 100));
  const started = Date.now();
  await createHealth({ checks: { a: wait, b: wait, c: wait } }).run();
  assert.ok(Date.now() - started < 250);
});

test("HTTP handlers: ready 200/503, live always 200", async () => {
  let healthy = true;
  const health = createHealth({ checks: { db: () => healthy }, cacheMs: 0 });
  const server = createServer((req, res) => (req.url === "/live" ? health.live(req, res) : health.ready(req, res)));
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const get = (path) => new Promise((resolve, reject) => {
    request({ host: "127.0.0.1", port: server.address().port, path }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(body), cache: res.headers["cache-control"] }));
    }).on("error", reject).end();
  });
  assert.equal((await get("/ready")).status, 200);
  healthy = false;
  const bad = await get("/ready");
  assert.equal(bad.status, 503);
  assert.equal(bad.body.status, "down");
  assert.equal(bad.cache, "no-store");
  assert.deepEqual((await get("/live")).body, { status: "ok" });
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

test("a check must be a function", () => {
  assert.throws(() => createHealth({ checks: { x: 5 } }), TypeError);
});

// ---- review additions ----

const get = (port, path) => new Promise((resolve, reject) => {
  const req = request({ host: "127.0.0.1", port, path }, (res) => {
    let body = "";
    res.on("data", (c) => (body += c));
    res.on("end", () => resolve({ status: res.statusCode, body }));
  });
  req.setTimeout(2000, () => req.destroy(new Error("no answer within 2 s")));
  req.on("error", reject).end();
});

test("a check that hangs is not started again while the earlier call is still running", async () => {
  let calls = 0;
  let release;
  const health = createHealth({ checks: { db: () => { calls++; return calls === 1 ? new Promise((r) => (release = r)) : true; } }, timeoutMs: 20, cacheMs: 0, verbose: true });
  const first = await health.run();
  const second = await health.run();
  const third = await health.run();
  assert.equal(calls, 1, "every probe would add one more hung call to the database");
  for (const report of [first, second, third]) assert.equal(report.status, "down");
  assert.match(second.checks.db.error, /still running/);
  release();
  await new Promise((r) => setTimeout(r, 5));
  assert.equal((await health.run()).status, "ok");
  assert.equal(calls, 2);
});

test("a check gets a signal that aborts when it times out", async () => {
  let received;
  const health = createHealth({ checks: { db: (signal) => { received = signal; return new Promise(() => {}); } }, timeoutMs: 20 });
  await health.run();
  assert.ok(received instanceof AbortSignal);
  assert.equal(received.aborted, true);
});

test("timeouts are checked: a huge one does not fire at once, nonsense is refused", async () => {
  const slow = async () => { await new Promise((r) => setTimeout(r, 30)); };
  assert.equal((await createHealth({ checks: { db: slow }, timeoutMs: 1e12 }).run()).status, "ok");
  assert.equal((await createHealth({ checks: { db: { check: slow, timeoutMs: 1e12 } } }).run()).status, "ok");
  for (const bad of [0, -1, NaN, "5"]) {
    assert.throws(() => createHealth({ timeoutMs: bad }), RangeError, String(bad));
    assert.throws(() => createHealth({ checks: { db: { check: slow, timeoutMs: bad } } }), RangeError, String(bad));
  }
  assert.throws(() => createHealth({ cacheMs: NaN }), RangeError);
  assert.throws(() => createHealth({ cacheMs: -1 }), RangeError);
  assert.throws(() => createHealth({ checks: { db: { check: slow, critical: "no" } } }), TypeError);
});

test("a clock that jumps back does not freeze the cache", async () => {
  let t = 100_000, calls = 0;
  const health = createHealth({ checks: { db: () => { calls++; } }, cacheMs: 500, now: () => t });
  await health.run();
  t = 0;
  await health.run();
  assert.equal(calls, 2);
  assert.ok((await health.run()).checks.db.ms >= 0);
});

test("ready answers 503 instead of hanging when the run itself breaks", async () => {
  const health = createHealth({ checks: { db: () => true }, now: () => { throw new Error("clock broke"); } });
  const server = createServer((req, res) => health.ready(req, res)); // no .catch: like createServer(health.ready)
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const answer = await get(server.address().port, "/ready");
  assert.equal(answer.status, 503);
  assert.deepEqual(JSON.parse(answer.body), { status: "down" });
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
});

test("a check called __proto__ is just a name", async () => {
  const report = await createHealth({ checks: Object.fromEntries([["__proto__", () => true]]) }).run();
  assert.equal(report.status, "ok");
  assert.deepEqual(Object.keys(report.checks), ["__proto__"]);
  assert.equal(Object.getPrototypeOf(report.checks), Object.prototype);
  assert.equal({}.status, undefined);
  assert.ok(JSON.stringify(report).includes('"__proto__":{"status":"up"'));
});
