#!/usr/bin/env node
"use strict";
/* =====================================================================
   CURAVIA Demo Portal — structural + logic check suite (no deps).
   Mirrors the demo check pattern used for the MEDEXEC and InSnap
   portals: public pages carry zero /demo references, the provisioning
   store parses, the gate / activation / app logic behaves, and the
   notify + provision endpoints enforce their guards — including the
   IEC Office activity forward (secret-gated, fail-silent, seed
   flagged). Run: node scripts/demo-portal-check.mjs
   ===================================================================== */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let pass = 0, fail = 0;
const failures = [];
function check(name, cond) {
  if (cond) { pass++; }
  else { fail++; failures.push(name); console.log("FAIL: " + name); }
}
function section(name) { console.log("— " + name); }

const read = rel => fs.readFileSync(path.join(ROOT, rel), "utf8");

/* Fetch stub: records calls, answers per-URL. */
let fetchCalls = [];
let fetchBehavior = () => ({ ok: true, status: 200, json: async () => ({ id: "stub-id" }), text: async () => "" });
global.fetch = async (url, opts) => { fetchCalls.push({ url: String(url), opts }); return fetchBehavior(String(url), opts); };

/* Extract the core (module.exports) script block from a demo page and
   load it as a CommonJS module with the provisioning global set. */
function loadCore(htmlRel, provisioned) {
  const html = read(htmlRel);
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
  const core = blocks.find(b => b.includes("module.exports"));
  if (!core) throw new Error("core script not found in " + htmlRel);
  global.DEMO_PROVISIONED_ACCOUNTS = provisioned;
  const tmp = path.join(os.tmpdir(), "curavia-demo-core-" + Math.random().toString(36).slice(2) + ".cjs");
  fs.writeFileSync(tmp, core);
  delete require.cache[tmp];
  const mod = require(tmp);
  fs.unlinkSync(tmp);
  return mod;
}

function parseProvisioning(source) {
  const sandbox = {};
  vm.createContext(sandbox);
  const list = vm.runInContext(String(source) + "\n;DEMO_PROVISIONED_ACCOUNTS;", sandbox, { timeout: 1000 });
  if (!Array.isArray(list)) throw new Error("parse failed");
  return list;
}

/* ------------------------------------------------------------------ */
section("structure: public pages stay clean");
for (const page of ["index.html", "portal.html", "privacy.html"]) {
  const src = read(page);
  check(page + " has no /demo path reference", !src.includes("/demo"));
  check(page + " has no demo/ href", !/href="demo/.test(src));
}

section("structure: demo pages");
const gateHtml = read("demo/index.html");
const actHtml = read("demo/activate/index.html");
const appHtml = read("demo/app/index.html");
for (const [name, html] of [["gate", gateHtml], ["activate", actHtml], ["app", appHtml]]) {
  check(name + " is noindex/nofollow", html.includes('content="noindex, nofollow"'));
  check(name + " carries Developed by IEC, Inc.", html.includes("Developed by IEC, Inc."));
  check(name + " marks synthetic data", /synthetic/i.test(html));
}
check("gate loads provisioning absolutely", gateHtml.includes('<script src="/demo/provisioning.js"></script>'));
check("activate loads provisioning absolutely", actHtml.includes('<script src="/demo/provisioning.js"></script>'));
check("app loads provisioning absolutely", appHtml.includes('<script src="/demo/provisioning.js"></script>'));
check("gate handoff URL is absolute /demo/app/", gateHtml.includes('const DEMO_APP_URL = "/demo/app/";'));
check("gate seed is the CURAVIA seed", gateHtml.includes("demo@curavia.example") && gateHtml.includes("CuraviaDemo#2026"));
check("activate seed matches the gate seed", actHtml.includes("demo@curavia.example") && actHtml.includes("CuraviaDemo#2026"));
check("public pages do not link the portal", !read("index.html").includes("demo/index") && !read("portal.html").includes("demo/index"));

/* ------------------------------------------------------------------ */
section("provisioning store");
const provSource = read("demo/provisioning.js");
const prov = parseProvisioning(provSource);
check("store parses to an array", Array.isArray(prov));
check("store has exactly 2 entries", prov.length === 2);
const drm = prov.find(a => a.email === "drmohdmorgan@gmail.com");
check("DrMorgan is provisioned", !!drm);
check("DrMorgan status is invited", drm && drm.status === "invited");
check("DrMorgan name is exact", drm && drm.name === "Mohammed M. Morgan, M.D.");
check("DrMorgan token is 48-hex", !!drm && /^[0-9a-f]{48}$/.test(drm.token || ""));
check("DrMorgan issuedAt is Eastern ISO", !!drm && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}-0[45]:00$/.test(drm.issuedAt || ""));
const seed = prov.find(a => a.email === "demo@curavia.example");
check("seed is active without a token", !!seed && seed.status === "active" && !seed.token);
check("all statuses are valid", prov.every(a => ["invited", "active", "paused", "revoked"].includes(a.status)));

/* ------------------------------------------------------------------ */
section("gate logic");
fetchCalls = [];
const gate = loadCore("demo/index.html", prov);
let r = gate.demoLogin("demo@curavia.example", "CuraviaDemo#2026");
check("seed login succeeds", r.ok === true && r.session.email === "demo@curavia.example");
check("seed login emits a login activity event", fetchCalls.some(c => c.url === "/api/demo-notify" && JSON.parse(c.opts.body).event === "login"));
check("session is stored", gate.demoSession() && gate.demoSession().email === "demo@curavia.example");
gate.demoSignOut();
check("sign-out clears the session", gate.demoSession() === null);

fetchCalls = [];
r = gate.demoLogin("demo@curavia.example", "wrong-password");
check("seed bad password is refused", r.ok === false);
check("bad password emits login_failed/bad_password", fetchCalls.some(c => { const b = JSON.parse(c.opts.body); return b.event === "login_failed" && b.detail === "bad_password"; }));

fetchCalls = [];
r = gate.demoLogin("drmohdmorgan@gmail.com", "anything-123");
check("invited-but-not-activated login is refused", r.ok === false && /not activated/.test(r.error));
check("not-activated emits login_failed/not_activated", fetchCalls.some(c => { const b = JSON.parse(c.opts.body); return b.event === "login_failed" && b.detail === "not_activated"; }));

fetchCalls = [];
r = gate.demoLogin("nobody@example.com", "whatever-123");
check("unknown email is refused", r.ok === false && /No demo account/.test(r.error));
check("unknown email emits login_failed/no_account", fetchCalls.some(c => { const b = JSON.parse(c.opts.body); return b.event === "login_failed" && b.detail === "no_account"; }));

const pausedList = prov.map(a => a.email === "drmohdmorgan@gmail.com" ? { ...a, status: "paused" } : a);
fetchCalls = [];
const gatePaused = loadCore("demo/index.html", pausedList);
r = gatePaused.demoLogin("drmohdmorgan@gmail.com", "anything-123");
check("paused account login is refused as paused", r.ok === false && /paused/.test(r.error));
check("paused login emits paused_attempt", fetchCalls.some(c => { const b = JSON.parse(c.opts.body); return b.event === "paused_attempt" && b.email === "drmohdmorgan@gmail.com"; }));

const revokedList = prov.map(a => a.email === "drmohdmorgan@gmail.com" ? { ...a, status: "revoked" } : a);
fetchCalls = [];
const gateRevoked = loadCore("demo/index.html", revokedList);
r = gateRevoked.demoLogin("drmohdmorgan@gmail.com", "anything-123");
check("revoked account login is refused as revoked", r.ok === false && /revoked/.test(r.error));
check("revoked login emits revoked_attempt", fetchCalls.some(c => { const b = JSON.parse(c.opts.body); return b.event === "revoked_attempt"; }));
const gateFresh = loadCore("demo/index.html", prov);
check("effectiveStatus reads provisioning", gateFresh.effectiveStatus("drmohdmorgan@gmail.com") === "invited" && gateFresh.effectiveStatus("nobody@example.com") === null);

/* ------------------------------------------------------------------ */
section("activation logic");
fetchCalls = [];
const act = loadCore("demo/activate/index.html", prov);
check("unknown token state is unknown", act.activationState("deadbeef").state === "unknown");
check("DrMorgan token state is ready", act.activationState(drm.token).state === "ready");
let ar = act.demoActivate(drm.token, "short", "short");
check("short password refused", ar.ok === false && /at least 8/.test(ar.error));
ar = act.demoActivate(drm.token, "long-enough-1", "long-enough-2");
check("mismatched passwords refused", ar.ok === false && /do not match/.test(ar.error));
ar = act.demoActivate(drm.token, "long-enough-1", "long-enough-1");
check("activation succeeds", ar.ok === true && ar.account.email === "drmohdmorgan@gmail.com");
check("activation emits the activated event", fetchCalls.some(c => { const b = JSON.parse(c.opts.body); return b.event === "activated" && b.email === "drmohdmorgan@gmail.com"; }));
check("used token state becomes used", act.activationState(drm.token).state === "used");
ar = act.demoActivate(drm.token, "another-pass-1", "another-pass-1");
check("second activation is refused", ar.ok === false && /already been used/.test(ar.error));
check("account can be found after activation", !!act.findAccount("drmohdmorgan@gmail.com"));

const actPaused = loadCore("demo/activate/index.html", pausedList);
check("paused token state is paused", actPaused.activationState(drm.token).state === "paused");
fetchCalls = [];
ar = actPaused.demoActivate(drm.token, "long-enough-1", "long-enough-1");
check("paused activation is refused", ar.ok === false && /paused/.test(ar.error));
check("paused activation emits paused_attempt", fetchCalls.some(c => { const b = JSON.parse(c.opts.body); return b.event === "paused_attempt" && b.detail === "activation"; }));

/* ------------------------------------------------------------------ */
section("app logic");
const app = loadCore("demo/app/index.html", prov);
check("no session is not allowed", app.sessionAllowed(null) === false);
check("seed session is allowed", app.sessionAllowed({ email: "demo@curavia.example", name: "Demo Reviewer" }) === true);
check("unprovisioned session is not allowed", app.sessionAllowed({ email: "nobody@example.com" }) === false);
global.DEMO_PROVISIONED_ACCOUNTS = pausedList;
check("paused session is not allowed", app.sessionAllowed({ email: "drmohdmorgan@gmail.com" }) === false);
global.DEMO_PROVISIONED_ACCOUNTS = prov;
check("walkthrough has 9 steps", app.STEPS.length === 9);
check("flow has 8 beats", app.FLOW_BEATS.length === 8);
for (let i = 0; i < app.STEPS.length; i++) {
  const html = app.renderStep(i);
  check("step " + (i + 1) + " (" + app.STEPS[i].id + ") renders and marks synthetic data", typeof html === "string" && html.length > 200 && html.includes("SYNTHETIC"));
}
check("case id is the CURAVIA synthetic case", app.CASE.id === "CURAVIA-TEST-2026-001");
check("flow zoom steps up and clamps", app.flowZoomStep(app.flowDefaultView(), "suite", 1) === 125 && app.flowZoomStep({ zoom: { suite: 200 } }, "suite", 1) === 200);
check("flow mini pane zoom is 62", app.flowEffectiveZoom({ focus: "phone", zoom: { suite: 100, phone: 100 } }, "suite") === 62);
check("scribe step carries the sign action", app.scribeHTML().includes('data-action="sign-summary"'));
app.demoState.signed = true;
check("signed scribe shows the signed state", app.scribeHTML().includes("Signed · Published to patient"));
check("billing step carries the approve action", app.billingHTML().includes('data-action="approve-code"'));
app.demoState.codeApproved = true;
check("approved billing shows the Ready claim", app.billingHTML().includes("CURAVIA-CLM-001") && app.billingHTML().includes("Ready"));
check("audit step carries the export action", app.auditHTML().includes('data-action="export-audit"'));
check("patient app shows the signed summary", app.patientHTML("summary").includes("Your visit summary is ready"));
fetchCalls = [];
app.DemoStore.set("curavia_demo_session", { email: "demo@curavia.example", name: "Demo Reviewer" });
app.demoActivity("step_view", "scribe");
check("app emits step_view with the step id", fetchCalls.some(c => { const b = JSON.parse(c.opts.body); return b.event === "step_view" && b.detail === "scribe" && b.email === "demo@curavia.example"; }));

/* ------------------------------------------------------------------ */
section("org signature");
const sig = require(path.join(ROOT, "api/_signature.js"));
check("signature names CURAVIA · IEC, Inc.", sig.SIGNATURE_TEXT.includes("CURAVIA · IEC, Inc."));
check("signature carries the phone", sig.SIGNATURE_TEXT.includes("857-867-1767"));
check("signature carries info@getcuravia.com", sig.SIGNATURE_TEXT.includes("info@getcuravia.com"));
check("signature has no personal name", !sig.SIGNATURE_TEXT.includes("Mohammed") && !sig.SIGNATURE_HTML.includes("Mohammed"));

/* ------------------------------------------------------------------ */
section("notify endpoint");
const notify = require(path.join(ROOT, "api/demo-notify.js"));
function mockRes() {
  return { statusCode: 0, body: null, setHeader() {}, end(s) { this.body = s; } };
}
async function callNotify(body, method = "POST") {
  const res = mockRes();
  await notify({ method, headers: {}, body }, res);
  return { code: res.statusCode, json: JSON.parse(res.body || "{}") };
}
const INGEST = "https://ingest.invalid/api/demo-activity";
process.env.DEMO_ACTIVITY_URL = INGEST;
delete process.env.RESEND_API_KEY;

let n = await callNotify({}, "GET");
check("notify GET is 405", n.code === 405 && n.json.error === "method_not_allowed");
n = await callNotify({ event: "explode", email: "drmohdmorgan@gmail.com" });
check("notify unknown event is 400", n.code === 400 && n.json.error === "unknown_event");
n = await callNotify({ event: "login", email: "nobody@example.com" });
check("notify unprovisioned email is 403", n.code === 403 && n.json.error === "not_provisioned");

delete process.env.DEMO_ACTIVITY_SECRET;
fetchCalls = [];
n = await callNotify({ event: "login", email: "demo@curavia.example" });
check("seed login is 200 seed_silent", n.code === 200 && n.json.sent === false && n.json.reason === "seed_silent");
check("no forward is attempted without DEMO_ACTIVITY_SECRET", n.json.forwarded === false && !fetchCalls.some(c => c.url === INGEST));

process.env.DEMO_ACTIVITY_SECRET = "test-secret";
fetchCalls = [];
n = await callNotify({ event: "login", email: "demo@curavia.example" });
check("seed login forwards with the secret set", n.code === 200 && n.json.forwarded === true);
const seedFwd = fetchCalls.find(c => c.url === INGEST);
check("seed forward is flagged seed:true", !!seedFwd && JSON.parse(seedFwd.opts.body).seed === true);
check("forward payload carries asset/email/event/ts", !!seedFwd && (() => { const b = JSON.parse(seedFwd.opts.body); return b.asset === "curavia" && b.email === "demo@curavia.example" && b.event === "login" && typeof b.ts === "string"; })());
check("forward sends the activity secret header", !!seedFwd && seedFwd.opts.headers["x-demo-activity-secret"] === "test-secret");
check("seed still sends no email", n.json.sent === false && n.json.reason === "seed_silent");

fetchCalls = [];
n = await callNotify({ event: "login", email: "drmohdmorgan@gmail.com" });
check("provisioned login without Resend key is a NO-OP 200", n.code === 200 && n.json.sent === false && n.json.reason === "not_configured");
check("provisioned login is forwarded", n.json.forwarded === true && fetchCalls.some(c => c.url === INGEST));

fetchCalls = [];
n = await callNotify({ event: "step_view", email: "drmohdmorgan@gmail.com", detail: "scribe" });
check("step_view is forward-only (no email)", n.code === 200 && n.json.sent === false && n.json.forwarded === true);
const svFwd = fetchCalls.find(c => c.url === INGEST);
check("step_view detail reaches the ingest", !!svFwd && JSON.parse(svFwd.opts.body).detail === "scribe");

fetchCalls = [];
n = await callNotify({ event: "paused_attempt", email: "drmohdmorgan@gmail.com", detail: "login" });
check("paused_attempt is forwarded", n.code === 200 && n.json.forwarded === true);

fetchBehavior = () => { throw new Error("ingest down"); };
n = await callNotify({ event: "action", email: "drmohdmorgan@gmail.com", detail: "sign-summary" });
check("a dead ingest never breaks the endpoint", n.code === 200 && n.json.forwarded === false);
fetchBehavior = url => url.includes("resend")
  ? { ok: true, status: 200, json: async () => ({ id: "resend-stub" }), text: async () => "" }
  : { ok: true, status: 200, json: async () => ({}), text: async () => "" };

process.env.RESEND_API_KEY = "test-resend-key";
fetchCalls = [];
n = await callNotify({ event: "login", email: "drmohdmorgan@gmail.com" });
check("provisioned login with a Resend key sends", n.code === 200 && n.json.sent === true && n.json.id === "resend-stub");
const mailCall = fetchCalls.find(c => c.url.includes("api.resend.com"));
check("notification email goes to DrMorgan's Gmail", !!mailCall && JSON.parse(mailCall.opts.body).to[0] === "drmohdmorgan@gmail.com");
check("notification From is the Resend onboarding sender", !!mailCall && JSON.parse(mailCall.opts.body).from.includes("onboarding@resend.dev"));
delete process.env.RESEND_API_KEY;
delete process.env.DEMO_ACTIVITY_SECRET;

/* ------------------------------------------------------------------ */
section("provision endpoint");
const provision = require(path.join(ROOT, "api/demo-provision.js"));
async function callProvision(body, headers = {}, method = "POST") {
  const res = mockRes();
  await provision({ method, headers, body }, res);
  return { code: res.statusCode, json: JSON.parse(res.body || "{}") };
}
let p = await callProvision({}, {}, "GET");
check("provision GET is 405", p.code === 405);
delete process.env.DEMO_PROVISION_SECRET;
p = await callProvision({ name: "Test Signer", email: "signer@example.com" });
check("provision without the secret env is 503 not_configured", p.code === 503 && p.json.error === "not_configured");
process.env.DEMO_PROVISION_SECRET = "test-provision-secret";
p = await callProvision({ name: "Test Signer", email: "signer@example.com" }, { "x-demo-provision-secret": "wrong" });
check("provision with a wrong secret is 401", p.code === 401 && p.json.error === "unauthorized");
p = await callProvision({ name: "Test Signer", email: "signer@example.com", product: "medexec" }, { "x-demo-provision-secret": "test-provision-secret" });
check("provision refuses a non-CURAVIA signing", p.code === 403 && p.json.error === "wrong_product");
p = await callProvision({ name: "Test Signer", email: "not-an-email", product: "curavia" }, { "x-demo-provision-secret": "test-provision-secret" });
check("provision refuses an implausible signer", p.code === 400 && p.json.error === "invalid_signer");
delete process.env.DEMO_PROVISION_GITHUB_TOKEN;
p = await callProvision({ name: "Test Signer", email: "signer@example.com", product: "curavia" }, { "x-demo-provision-secret": "test-provision-secret" });
check("provision without the GitHub token is 503 not_configured", p.code === 503 && p.json.error === "not_configured");
delete process.env.DEMO_PROVISION_SECRET;

const internals = provision._internals;
const inserted = internals.insertEntry(provSource, { email: "signer@example.com", name: "Test Signer", token: "a".repeat(48), status: "invited", issuedAt: "2026-11-05T06:30:00-05:00" });
const prov2 = internals.parseProvisioning(inserted);
check("insertEntry adds exactly one entry", prov2.length === 3 && prov2[2].email === "signer@example.com");
check("insertEntry preserves existing entries byte-for-byte", inserted.startsWith(provSource.slice(0, provSource.lastIndexOf("\n];"))));
check("easternIso format", /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}-0[45]:00$/.test(internals.easternIso(new Date())));
const mail = internals.buildActivationEmail("Test Signer", "signer@example.com", "b".repeat(48));
check("activation email links the committed token", mail.link === "https://getcuravia.com/demo/activate/?token=" + "b".repeat(48));
check("activation email carries the org signature", mail.text.includes("CURAVIA · IEC, Inc.") && mail.text.includes("info@getcuravia.com"));

/* ------------------------------------------------------------------ */
console.log("\n" + pass + " passed, " + fail + " failed");
if (failures.length) { console.log("Failures:\n - " + failures.join("\n - ")); process.exit(1); }
