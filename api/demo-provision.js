"use strict";
/* =====================================================================
   CURAVIA Demo Portal — automatic provisioning on a website NDA
   signing, DORMANT-READY (built 2026-11-05, mirroring the armed
   MEDEXEC trigger of 2026-11-04 18:50 EST and InSnap's dormant-ready
   endpoint: every VERIFIED countersigned CURAVIA NDA gets demo access
   provisioned and the activation email sent automatically).

   POST /api/demo-provision
     Headers: x-demo-provision-secret: <DEMO_PROVISION_SECRET>
     Body:    { name, email, source, product }
              (source is informational; product gates the call —
              see below)

   STATUS: this site has no NDA signing surface wired to call this
   endpoint yet — the wiring is a later step, exactly as InSnap's
   endpoint was built dormant-ready before its keys step. When a
   CURAVIA signing surface lands, it must call this endpoint ONLY
   AFTER the signing has been recorded — that signing record is the
   verification for this path. It is never called by a browser.

   CURAVIA SIGNINGS ONLY: a call carrying a `product` field that is
   not "curavia" is refused (403 wrong_product). A caller for another
   IEC product must never be able to provision CURAVIA demo accounts
   with this endpoint — the same discipline the MEDEXEC app applies
   when it gates its trigger to MEDEXEC signings only.

   WHAT IT DOES (once called)
   1. Reads the CURRENT demo/provisioning.js from the getcuravia-site
      repo (GitHub Contents API) — provisioning.js stays the single
      source of truth and the demo's client-side auth design is
      untouched.
   2. Idempotency by signer email (the stated rule):
        no entry            → create one (status "invited", fresh
                              one-time token), commit to the repo,
                              Vercel redeploys provisioning.js;
        entry "invited"     → NO duplicate: resend the SAME activation
                              link, but only because this call follows
                              a fresh completed signing;
        entry "active"      → no email (they already have access);
        entry paused/revoked → no email (administrative control wins).
      The seed account has status "active", so it follows that rule.
      Existing entries are preserved byte-for-byte: a new entry is
      INSERTED before the array's closing bracket; nothing is rewritten.
   3. Waits (bounded poll) until the new token is visible on the live
      https://getcuravia.com/demo/provisioning.js, so the activation
      link works when the email lands, then sends the activation email
      via THIS project's Resend route (RESEND_API_KEY) — the approved
      template, subject "Your CURAVIA demo account is ready — activate
      your access", signed with the ORG signature (api/_signature.js —
      logo + CURAVIA · IEC, Inc., no personal name). Sender is Resend's
      onboarding address until getcuravia.com is verified in Resend
      (info@getcuravia.com is NOT a verified sending identity — never
      fake it); DEMO_PROVISION_FROM then flips the From with no code
      change.

   FAIL-CLOSED, like /api/demo-notify: with DEMO_PROVISION_SECRET or
   DEMO_PROVISION_GITHUB_TOKEN unset, nothing is provisioned and
   nothing is sent — the endpoint answers 503 { error:
   "not_configured" } and logs a clearly-marked NO-OP line. It never
   fails the NDA signing itself (the caller treats every outcome as
   non-blocking; the signing is already recorded before this runs).

   Env (this Vercel project — getcuravia-site):
     DEMO_PROVISION_SECRET        shared secret the signing surface sends
     DEMO_PROVISION_GITHUB_TOKEN  fine-grained GitHub token (DrMorgan73,
                                  THIS repo only, Contents read/write)
     RESEND_API_KEY               the sending key (to be configured)
     DEMO_PROVISION_FROM          optional sender override
     DEMO_PROVISION_REPO          optional, default DrMorgan73/getcuravia-site
     DEMO_PROVISION_LIVE_URL      optional live provisioning.js URL
                                  (poll target; tests override it)
   ===================================================================== */

const crypto = require("crypto");
const vm = require("vm");
const { SIGNATURE_TEXT, SIGNATURE_HTML } = require("./_signature");

const REPO = process.env.DEMO_PROVISION_REPO || "DrMorgan73/getcuravia-site";
const FILE_PATH = "demo/provisioning.js";
const LIVE_URL =
  process.env.DEMO_PROVISION_LIVE_URL || "https://getcuravia.com/demo/provisioning.js";
const FROM =
  process.env.DEMO_PROVISION_FROM ||
  process.env.DEMO_NOTIFY_FROM ||
  "CURAVIA Demo Portal <onboarding@resend.dev>";
const ACTIVATION_BASE = "https://getcuravia.com/demo/activate/?token=";
const SEED_EMAIL = "demo@curavia.example";

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function plausibleEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 254;
}

function timingSafeEqual(a, b) {
  const ba = Buffer.from(String(a || ""));
  const bb = Buffer.from(String(b || ""));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string" && req.body) {
    try { return JSON.parse(req.body); } catch (e) { return {}; }
  }
  return new Promise(resolve => {
    let data = "";
    if (typeof req.on !== "function") return resolve({});
    req.on("data", c => { data += c; });
    req.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); } catch (e) { resolve({}); }
    });
    req.on("error", () => resolve({}));
  });
}

function reply(res, code, obj) {
  if (typeof res.status === "function" && typeof res.json === "function") {
    return res.status(code).json(obj);
  }
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
}

function escapeHtml(s) {
  return String(s || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/* "2026-11-05T06:14:05-05:00" — America/New_York wall time with its UTC
   offset, matching the format of the hand-provisioned entries. */
function easternIso(date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  let offMin = Math.round((asUTC - date.getTime()) / 60000);
  const sign = offMin < 0 ? "-" : "+";
  offMin = Math.abs(offMin);
  const oh = String(Math.floor(offMin / 60)).padStart(2, "0");
  const om = String(offMin % 60).padStart(2, "0");
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}${sign}${oh}:${om}`;
}

/* Parse the entries out of a provisioning.js source text. The file is
   our own controlled artifact (the notify endpoint require()s it), so
   evaluating it in an empty vm sandbox to read the one constant is
   safe and robust to comments/formatting inside the array. */
function parseProvisioning(source) {
  const sandbox = {};
  vm.createContext(sandbox);
  /* A top-level `const` never lands on the sandbox object — read it
     back as the script's completion value instead. */
  const list = vm.runInContext(
    String(source || "") + "\n;DEMO_PROVISIONED_ACCOUNTS;",
    sandbox,
    { timeout: 1000 }
  );
  if (!Array.isArray(list)) throw new Error("provisioning_parse_failed");
  return list;
}

/* Insert a new entry just before the array's closing bracket, leaving
   every existing byte in place (entries survive byte-for-byte). */
function insertEntry(source, entry) {
  const text = String(source);
  const close = text.lastIndexOf("\n];");
  if (close < 0) throw new Error("provisioning_shape_unexpected");
  const entryText =
    ",\n  {\n" +
    `    email: ${JSON.stringify(entry.email)},\n` +
    `    name: ${JSON.stringify(entry.name)},\n` +
    `    token: ${JSON.stringify(entry.token)},\n` +
    `    status: ${JSON.stringify(entry.status)},\n` +
    `    issuedAt: ${JSON.stringify(entry.issuedAt)}\n` +
    "  }";
  return text.slice(0, close) + entryText + text.slice(close);
}

/* ------------------------------------------------------------------ */
/* GitHub Contents API (repo is the provisioning store)                */
/* ------------------------------------------------------------------ */

function ghHeaders(token) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
    "User-Agent": "curavia-demo-provision"
  };
}

async function ghGetFile(token) {
  const r = await fetch(
    `https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`,
    { headers: ghHeaders(token) }
  );
  if (!r.ok) throw new Error(`github_get_${r.status}`);
  const data = await r.json();
  const source = Buffer.from(String(data.content || ""), "base64").toString("utf8");
  return { source, sha: data.sha };
}

async function ghPutFile(token, sha, source, message) {
  const r = await fetch(
    `https://api.github.com/repos/${REPO}/contents/${FILE_PATH}`,
    {
      method: "PUT",
      headers: ghHeaders(token),
      body: JSON.stringify({
        message,
        sha,
        content: Buffer.from(source, "utf8").toString("base64"),
        committer: { name: "DrMorgan73", email: "DrMorgan73@users.noreply.github.com" },
        author: { name: "DrMorgan73", email: "DrMorgan73@users.noreply.github.com" }
      })
    }
  );
  if (!r.ok) {
    const err = new Error(`github_put_${r.status}`);
    err.status = r.status;
    throw err;
  }
  return r.json().catch(() => ({}));
}

/* ------------------------------------------------------------------ */
/* Activation email — the approved template, full signature            */
/* ------------------------------------------------------------------ */

function buildActivationEmail(name, email, token) {
  const first = String(name || "").trim().split(/\s+/)[0] || "there";
  const link = ACTIVATION_BASE + token;
  const subject = "Your CURAVIA demo account is ready — activate your access";
  const text = [
    `Dear ${first},`,
    "",
    "Your CURAVIA demo account has been created. The demo is the CURAVIA Suite and the patient app as live HTML, showing one clinic day end to end — booking, intake, the visit, the scribe's summary, billing review — on a synthetic case only. No real patient data is used.",
    "",
    "Activate your account here:",
    link,
    "",
    "Three steps:",
    "1. Open the link.",
    "2. Set your own password — we never send passwords by email.",
    "3. Sign in at https://getcuravia.com/demo/ with this email address and your new password.",
    "",
    "The activation link is one-time: it stops working once you have set your password. If you need it reissued, or your access changed at any time, contact us at info@getcuravia.com.",
    "",
    SIGNATURE_TEXT
  ].join("\n");
  const html = [
    `<p>Dear ${escapeHtml(first)},</p>`,
    "<p>Your CURAVIA demo account has been created. The demo is the CURAVIA Suite and the patient app as live HTML, showing one clinic day end to end — booking, intake, the visit, the scribe's summary, billing review — on a synthetic case only. No real patient data is used.</p>",
    `<p>Activate your account here:<br><a href="${link}">${link}</a></p>`,
    "<p>Three steps:</p>",
    "<ol>",
    "<li>Open the link.</li>",
    "<li>Set your own password — we never send passwords by email.</li>",
    "<li>Sign in at https://getcuravia.com/demo/ with this email address and your new password.</li>",
    "</ol>",
    "<p>The activation link is one-time: it stops working once you have set your password. If you need it reissued, or your access changed at any time, contact us at info@getcuravia.com.</p>",
    SIGNATURE_HTML
  ].join("\n");
  return { subject, text, html, link };
}

async function sendActivationEmail(key, name, email, token) {
  const mail = buildActivationEmail(name, email, token);
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: FROM, to: [email], subject: mail.subject, text: mail.text, html: mail.html })
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(`resend_${r.status}`);
    err.data = data;
    throw err;
  }
  return data.id || null;
}

/* Bounded wait for the committed token to be live, so the activation
   link works when the email lands. Best-effort: the email is sent
   regardless; the result is reported in the response and the logs. */
async function waitForLiveToken(token, attempts = 10, delayMs = 2500) {
  for (let i = 0; i < attempts; i++) {
    try {
      const r = await fetch(`${LIVE_URL}?dp=${Date.now()}`, { headers: { "Cache-Control": "no-cache" } });
      if (r.ok) {
        const body = await r.text();
        if (body.includes(token)) return true;
      }
    } catch (e) { /* keep polling */ }
    if (i < attempts - 1) await new Promise(res => setTimeout(res, delayMs));
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Provisioning decision                                               */
/* ------------------------------------------------------------------ */

/* Returns { entry, created } — commits a new entry when needed. One
   retry on a sha conflict (a concurrent commit), re-checking
   idempotency from the fresh file before inserting again. */
async function ensureEntry(token, name, email) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const { source, sha } = await ghGetFile(token);
    const list = parseProvisioning(source);
    const existing = list.find(a => normalizeEmail(a.email) === email) || null;
    if (existing) return { entry: existing, created: false };
    const entry = {
      email,
      name,
      token: crypto.randomBytes(24).toString("hex"),
      status: "invited",
      issuedAt: easternIso(new Date())
    };
    const next = insertEntry(source, entry);
    try {
      await ghPutFile(token, sha, next, `Demo: provision ${name} (${email}) — website NDA signing`);
      return { entry, created: true };
    } catch (e) {
      if ((e.status === 409 || e.status === 422) && attempt === 0) continue;
      throw e;
    }
  }
  throw new Error("github_conflict");
}

/* ------------------------------------------------------------------ */
/* Handler                                                             */
/* ------------------------------------------------------------------ */

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return reply(res, 405, { ok: false, error: "method_not_allowed" });

  const secret = process.env.DEMO_PROVISION_SECRET;
  if (!secret) {
    console.log("[demo-provision] NO-OP — DEMO_PROVISION_SECRET is not configured for this project; no account provisioned, no email sent.");
    return reply(res, 503, { ok: false, error: "not_configured" });
  }
  const given = req.headers && (req.headers["x-demo-provision-secret"] || req.headers["X-Demo-Provision-Secret"]);
  if (!timingSafeEqual(given || "", secret)) {
    return reply(res, 401, { ok: false, error: "unauthorized" });
  }

  const body = await readBody(req);

  /* CURAVIA signings only: a caller identifying itself as another
     product is refused before anything else happens. */
  const product = String(body.product || "").trim().toLowerCase();
  if (product && product !== "curavia") {
    console.log(`[demo-provision] refused a non-CURAVIA signing (product="${product}"); no account provisioned.`);
    return reply(res, 403, { ok: false, error: "wrong_product" });
  }

  const name = String(body.name || "").trim().slice(0, 200);
  const email = normalizeEmail(body.email);
  if (!name || !plausibleEmail(email)) {
    return reply(res, 400, { ok: false, error: "invalid_signer" });
  }

  const ghToken = process.env.DEMO_PROVISION_GITHUB_TOKEN || "";
  if (!ghToken) {
    console.log(`[demo-provision] NO-OP — DEMO_PROVISION_GITHUB_TOKEN is not configured for this project; no account provisioned for a website NDA signer.`);
    return reply(res, 503, { ok: false, error: "not_configured" });
  }

  let outcome;
  try {
    outcome = await ensureEntry(ghToken, name, email);
  } catch (e) {
    console.error(`[demo-provision] provisioning FAILED for a website NDA signer: ${e && e.message}`);
    return reply(res, 502, { ok: false, error: "provision_failed" });
  }

  const entry = outcome.entry;
  const status = String(entry.status || "invited").toLowerCase();

  if (!outcome.created && status !== "invited") {
    /* Idempotent no-email outcomes: already has access, or an
       administrative status (paused / revoked) controls the account. */
    const reason = status === "active" ? "already_active" : `status_${status}`;
    console.log(`[demo-provision] no email for a website NDA signer: existing account (${reason}).`);
    return reply(res, 200, { ok: true, created: false, emailed: false, reason });
  }

  if (!entry.token) {
    console.error("[demo-provision] provisioned entry carries no token; cannot email an activation link.");
    return reply(res, 500, { ok: false, error: "entry_token_missing" });
  }

  const deployConfirmed = outcome.created ? await waitForLiveToken(entry.token) : true;
  if (outcome.created && !deployConfirmed) {
    console.error("[demo-provision] token not yet visible on the live provisioning.js after the poll window; sending the activation email anyway (links do not expire).");
  }

  const key = process.env.RESEND_API_KEY || "";
  if (!key) {
    console.log(`[demo-provision] NO-OP SEND — RESEND_API_KEY is not configured for this project; account ${outcome.created ? "created" : "already invited"} but the activation email was NOT sent.`);
    return reply(res, 200, { ok: true, created: outcome.created, emailed: false, reason: "not_configured", deployConfirmed });
  }

  try {
    const id = await sendActivationEmail(key, entry.name || name, email, entry.token);
    console.log(`[demo-provision] activation email sent for a website NDA signer (created=${outcome.created}, Resend id ${id || "?"}).`);
    return reply(res, 200, {
      ok: true,
      created: outcome.created,
      resent: !outcome.created,
      emailed: true,
      deployConfirmed,
      id
    });
  } catch (e) {
    console.error(`[demo-provision] activation email FAILED for a website NDA signer: ${e && e.message}`);
    return reply(res, 200, { ok: true, created: outcome.created, emailed: false, reason: "send_failed", deployConfirmed });
  }
};

/* Exported for the node test suite; harmless in production. */
module.exports._internals = {
  parseProvisioning,
  insertEntry,
  buildActivationEmail,
  easternIso,
  normalizeEmail,
  SEED_EMAIL
};
