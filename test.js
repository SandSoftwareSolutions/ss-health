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
