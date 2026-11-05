"use strict";
/* =====================================================================
   CURAVIA Demo Portal — access notification + activity endpoint.

   POST /api/demo-notify  { event, email, name?, detail? }

   Called by the demo portal (demo/index.html), the activation page
   (demo/activate/) and the demo app (demo/app/) to report demo user
   activity. Events:

     login            a successful sign-in            → email + forward
     activated        a successful activation         → email + forward
     login_failed     a failed sign-in (detail=reason)→ forward only
     paused_attempt   a sign-in/activation attempt on a paused
                      account                         → forward only
     revoked_attempt  a sign-in/activation attempt on a revoked
                      account                         → forward only
     step_view        a walkthrough step was viewed
                      (detail = step id)              → forward only
     action           a key demo action (detail = action id, e.g.
                      sign-summary, approve-code)     → forward only

   ("activation" is accepted as a legacy alias of "activated".)

   (a) SUCCESS EMAIL — unchanged from the MEDEXEC/InSnap pattern: on a
   successful login or activation the endpoint emails DrMorgan who
   accessed the demo, what they did, and when. The recipient, the
   name, and the account status are derived HERE from
   demo/provisioning.js — client-supplied name/status ignored. The
   internal seed account (demo@curavia.example) NEVER triggers the
   email. No token or password is ever included (none is ever
   received). Sending is via Resend and FAIL-CLOSED: with no
   RESEND_API_KEY in this project's environment, nothing is sent —
   the endpoint logs a clearly-marked NO-OP line, so a missing key
   never breaks or blocks the demo sign-in flow.

   (b) CENTRAL ACTIVITY FORWARD — every accepted event is forwarded
   server-side to the IEC Office activity ingest:

     POST https://iecincglobal.com/api/demo-activity
       { asset: "curavia", email, name, event, detail, ts }
       header: x-demo-activity-secret: <DEMO_ACTIVITY_SECRET>

   Gated by DEMO_ACTIVITY_SECRET: unset → no forward is attempted.
   Unreachable/failing ingest → the failure is logged and swallowed;
   the demo NEVER breaks over monitoring. Seed events are forwarded
   too, flagged seed: true (the email stays silent for seed). ts is
   stamped here server-side (ISO), never trusted to the client.

   Anti-abuse discipline (as in the live portals): only provisioned
   emails can report activity — an event for an unknown email is
   refused 403 and neither emailed nor forwarded. `detail` is
   untrusted data: stringified and truncated, never used for identity.

   Env (this Vercel project — getcuravia-site):
     RESEND_API_KEY      the sending key (a key created for THIS
                         project — keys are not shared across projects)
     DEMO_NOTIFY_FROM    optional sender override; default is Resend's
                         onboarding sender until a getcuravia.com
                         sender is verified in Resend
     DEMO_NOTIFY_TO      optional recipient override (default below)
     DEMO_ACTIVITY_SECRET shared secret for the IEC Office ingest
     DEMO_ACTIVITY_URL   optional ingest URL override (tests)
   ===================================================================== */

let PROVISIONED = [];
try {
  PROVISIONED = require("../demo/provisioning.js").DEMO_PROVISIONED_ACCOUNTS || [];
} catch (e) {
  PROVISIONED = [];
}

/* ORG email signature incl. the logo (DrMorgan's rules, 2026-11-04:
   system mail carries the org variant — no personal name) — shared
   with /api/demo-provision. */
const { SIGNATURE_TEXT, SIGNATURE_HTML } = require("./_signature");

const NOTIFY_TO = process.env.DEMO_NOTIFY_TO || "drmohdmorgan@gmail.com";
const NOTIFY_FROM =
  process.env.DEMO_NOTIFY_FROM || "CURAVIA Demo Portal <onboarding@resend.dev>";
const SEED_EMAIL = "demo@curavia.example";
const ASSET = "curavia";
const DEFAULT_ACTIVITY_URL = "https://iecincglobal.com/api/demo-activity";

const EVENTS = [
  "login", "activated", "activation",
  "login_failed", "paused_attempt", "revoked_attempt",
  "step_view", "action"
];

function normalizeEmail(email) {
  return String(email || "").trim().toLowerCase();
}

function findProvisioned(email) {
  const e = normalizeEmail(email);
  return PROVISIONED.find(a => normalizeEmail(a.email) === e) || null;
}

/* e.g. "November 5, 2026 at 6:21:05 AM EST" — the notification's WHEN
   is stamped here, in DrMorgan's timezone, never trusted to the client. */
function formatEastern(date) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short"
  }).format(date);
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

/* Forward one activity event to the IEC Office ingest. Best-effort by
   design: returns true only when the ingest accepted the event; every
   failure is logged and swallowed so monitoring never breaks the demo. */
async function forwardActivity(payload) {
  const secret = process.env.DEMO_ACTIVITY_SECRET || "";
  if (!secret) return false;
  const url = process.env.DEMO_ACTIVITY_URL || DEFAULT_ACTIVITY_URL;
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-demo-activity-secret": secret
      },
      body: JSON.stringify(payload)
    });
    if (!r.ok) {
      console.error(`[demo-notify] activity forward FAILED: ingest answered HTTP ${r.status} for ${payload.event} by ${payload.email}.`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`[demo-notify] activity forward ERRORED for ${payload.event} by ${payload.email}: ${e && e.message}`);
    return false;
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return reply(res, 405, { ok: false, error: "method_not_allowed" });

  const body = await readBody(req);
  const rawEvent = String(body.event || "");
  const email = normalizeEmail(body.email);
  const detail = String(body.detail || "").slice(0, 300);

  if (!EVENTS.includes(rawEvent)) {
    return reply(res, 400, { ok: false, error: "unknown_event" });
  }
  const event = rawEvent === "activation" ? "activated" : rawEvent;

  const seed = email === SEED_EMAIL;
  const prov = findProvisioned(email);
  if (!prov) return reply(res, 403, { ok: false, error: "not_provisioned" });

  const name = prov.name || email;
  const status = String(prov.status || "invited").toLowerCase();
  const now = new Date();

  /* (b) Central activity forward — every accepted event, seed flagged. */
  const forwarded = await forwardActivity({
    asset: ASSET,
    email,
    name,
    event,
    detail,
    ts: now.toISOString(),
    ...(seed ? { seed: true } : {})
  });

  /* Seed: forwarded centrally above, but the email stays silent. */
  if (seed) {
    console.log(`[demo-notify] seed account ${event} — email suppressed by design; forwarded=${forwarded}.`);
    return reply(res, 200, { ok: true, sent: false, reason: "seed_silent", forwarded });
  }

  /* Forward-only events: no email by design. */
  if (event !== "login" && event !== "activated") {
    return reply(res, 200, { ok: true, sent: false, forwarded });
  }

  /* (a) Success email — successful login / activation only. */
  const when = formatEastern(now);
  const what =
    event === "activated"
      ? "Activated their CURAVIA demo account (set their password from the activation link)"
      : "Signed in to the CURAVIA demo portal";

  const key = process.env.RESEND_API_KEY || "";
  if (!key) {
    console.log(
      `[demo-notify] NO-OP — RESEND_API_KEY is not configured for this project; ` +
      `would have emailed ${NOTIFY_TO}: ${event} by ${name} (${email}) at ${when}.`
    );
    return reply(res, 200, { ok: true, sent: false, reason: "not_configured", forwarded });
  }

  const subject = `CURAVIA demo ${event} — ${name} (${email})`;
  const text = [
    "CURAVIA Demo Portal — access notification",
    "",
    `Who: ${name} (${email})`,
    `What: ${what}`,
    `When: ${when} (America/New_York)`,
    `Account status (provisioning): ${status}`,
    "",
    "Access is controlled in demo/provisioning.js (invited / active / paused / revoked).",
    "Full demo activity is monitored centrally in the IEC Office.",
    "",
    SIGNATURE_TEXT
  ].join("\n");
  const esc = s =>
    String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const html = [
    "<p><strong>CURAVIA Demo Portal — access notification</strong></p>",
    `<p>Who: ${esc(name)} (${esc(email)})<br>`,
    `What: ${esc(what)}<br>`,
    `When: ${esc(when)} (America/New_York)<br>`,
    `Account status (provisioning): ${esc(status)}</p>`,
    "<p>Access is controlled in demo/provisioning.js (invited / active / paused / revoked). Full demo activity is monitored centrally in the IEC Office.</p>",
    SIGNATURE_HTML
  ].join("\n");

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ from: NOTIFY_FROM, to: [NOTIFY_TO], subject, text, html })
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      console.error(`[demo-notify] Resend send FAILED for ${event} by ${email}: HTTP ${r.status} ${JSON.stringify(data).slice(0, 300)}`);
      return reply(res, 502, { ok: false, error: "send_failed", forwarded });
    }
    console.log(`[demo-notify] sent ${event} notification for ${email} (Resend id ${data.id || "?"}).`);
    return reply(res, 200, { ok: true, sent: true, id: data.id || null, forwarded });
  } catch (e) {
    console.error(`[demo-notify] Resend send ERRORED for ${event} by ${email}: ${e && e.message}`);
    return reply(res, 502, { ok: false, error: "send_failed", forwarded });
  }
};

/* Exported for the node test suite; harmless in production. */
module.exports._internals = { forwardActivity, EVENTS, SEED_EMAIL, ASSET };
