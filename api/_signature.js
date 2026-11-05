"use strict";
/* =====================================================================
   CURAVIA — ORG email signature for SYSTEM / automated email
   (DrMorgan's rules, 2026-11-04: system/automated mail uses the ORG
   variant of the full signature INCLUDING the logo — WITHOUT his
   personal name. His personal mailbox keeps the named variant.)

   Single source for this site project's serverless email senders
   (api/demo-notify.js, api/demo-provision.js). Not a route (leading
   underscore). HTML for the HTML part; the plain-text fallback keeps
   the org name, phone and email.

   LOGO: getcuravia.com carries no standalone raster logo file (the
   site's brand image is embedded in the page), so the signature
   carries the IEC logo — the platform operator's — from the IEC
   site's email assets, the same pattern InSnap's signature uses.

   SENDER NOTE: these senders' From stays Resend's onboarding address
   until the getcuravia.com domain is verified in Resend
   (info@getcuravia.com is NOT a verified sending identity — never
   fake it as the From). After verification the From flips to
   info@getcuravia.com via the DEMO_NOTIFY_FROM / DEMO_PROVISION_FROM
   env vars — no code change.
   ===================================================================== */

const SIGNATURE_TEXT = [
  "CURAVIA · IEC, Inc.",
  "857-867-1767",
  "info@getcuravia.com"
].join("\n");

const SIGNATURE_HTML = [
  '<table cellpadding="0" cellspacing="0" border="0" style="margin-top:24px">',
  '<tr><td><img src="https://iecincglobal.com/assets/iec-logo-email.png" width="140" alt="IEC, Inc." style="display:block;border:0"></td></tr>',
  '<tr><td style="padding-top:10px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.45;color:#1A1A1A">',
  "<strong>CURAVIA · IEC, Inc.</strong><br>",
  '<a href="tel:+18578671767" style="color:#1A1A1A;text-decoration:none">857-867-1767</a><br>',
  '<a href="mailto:info@getcuravia.com" style="color:#1A1A1A;text-decoration:none">info@getcuravia.com</a>',
  "</td></tr>",
  "</table>"
].join("");

module.exports = { SIGNATURE_TEXT, SIGNATURE_HTML };
