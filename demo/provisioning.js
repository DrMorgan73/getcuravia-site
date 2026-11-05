"use strict";
/* =====================================================================
   CURAVIA Demo Portal — provisioned accounts (single source of truth).

   Loaded by demo/index.html (the portal gate) and demo/activate/
   (the activation page). There is NO public self-signup and passwords
   are never sent by email: IEC provisions each account here, the
   signer receives a one-time activation link carrying the token, and
   sets their own password on the activation page. The token is
   single-use — it dies the moment the password is set. Links do NOT
   expire; control is administrative, through the status field:

     invited  — account created, activation link live, not yet used
     active   — account live (set by us once activation is confirmed,
                or for accounts whose password we manage directly)
     paused   — login blocked, account preserved (flip + redeploy)
     revoked  — activation link dead AND login dead (flip + redeploy)

   To provision a signer: add one entry with a fresh random token and
   status "invited", redeploy, and email them the link
   https://getcuravia.com/demo/activate/?token=<their token>.

   AUTOMATIC PATH (dormant-ready, 2026-11-05): /api/demo-provision
   (api/demo-provision.js) mirrors the armed MEDEXEC/InSnap website
   triggers — once a CURAVIA NDA signing surface on this site is wired
   to call it AFTER the signing has been recorded, it adds the entry
   here by committing this file (entries preserved byte-for-byte),
   waits for it to deploy, and sends the activation email. Until that
   wiring lands, provisioning is manual, exactly as above. The
   endpoint refuses any signing that is not a CURAVIA signing.

   Static-stack note: this is the client-side simulation's data layer.
   Statuses are enforced by the portal/activation logic in the browser;
   real per-user auth remains the named next step before scale-out.

   Activity monitoring (2026-11-05): the gate, activation page and
   demo app report activity to /api/demo-notify (api/demo-notify.js) —
   activated, login, login_failed (with reason), paused_attempt,
   revoked_attempt, step_view and key demo actions. A successful
   activation or login also emails DrMorgan who accessed the demo and
   when (never for the seed account; the email needs RESEND_API_KEY in
   THIS project's Vercel env and logs a NO-OP without it). EVERY
   accepted event — seed included, flagged — is forwarded server-side
   to the IEC Office central activity ingest, gated by
   DEMO_ACTIVITY_SECRET and fail-silent, so monitoring never breaks
   the demo flow.
   ===================================================================== */
const DEMO_PROVISIONED_ACCOUNTS = [
  {
    email: "drmohdmorgan@gmail.com",
    name: "Mohammed M. Morgan, M.D.",
    token: "b8849cecb687b8dd7db86b54dd66dd09b331794c87047ad5",
    status: "invited",
    issuedAt: "2026-11-05T06:06:15-05:00"
  },
  {
    /* Internal seed for end-to-end review; password lives in the
       DEMO_SEED_ACCOUNTS list on the portal page. No token: it is
       already active and cannot be (re)activated. */
    email: "demo@curavia.example",
    name: "Demo Reviewer",
    status: "active"
  },
  {
    email: "mohdology@gmail.com",
    name: "Mohamed Ismael",
    token: "129ffe80d2611eecd5f26eb9542a59553d3379904f64682d",
    status: "paused",
    issuedAt: "2026-11-05T07:44:34-05:00"
  },
  {
    email: "esteadysteps@gmail.com",
    name: "Mohamed Ismail",
    token: "98be1c733c34c5e595d6f9f94dc2fa566c8939ceb6dccb4f",
    status: "invited",
    issuedAt: "2026-11-05T07:50:05-05:00"
  }
];

if (typeof module !== "undefined" && module.exports) {
  module.exports = { DEMO_PROVISIONED_ACCOUNTS };
}
