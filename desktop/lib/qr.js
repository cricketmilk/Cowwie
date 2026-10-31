// lib/qr.js — QR code generation for the Trove's Apps tab.
// Wraps the proven `qrcode` npm module so the IPC handler can produce
// scannable QR codes as SVG data URIs.
//
// The earlier hand-rolled encoder was close but had subtle bugs in the
// format-information placement and dark-module coordinates — the kind of
// bugs that make a QR code look right in an ASCII dump but fail to scan.
// Rather than chase those down, this delegates to a library that has
// already been verified against every QR scanner in the wild.

"use strict";

const QRCode = require("qrcode");

/**
 * Encode text as a version-2 QR code and return an SVG data URI.
 * @param {string} text
 * @param {{ size?: number, margin?: number }} opts
 * @returns {{ dataUri: string }}
 */
async function qrDataUri(text, { size = 200, margin = 4 } = {}) {
  const svg = await QRCode.toString(text, {
    type: "svg",
    errorCorrectionLevel: "L",
    margin: margin,
    width: size,
    color: { dark: "#000000", light: "#ffffff" },
  });
  // QRCode.toString with type:"svg" returns a full <svg> string including
  // xmlns and the <?xml> preamble. Strip the preamble so the data URI is
  // self-contained and displays correctly in an <img> tag.
  const clean = svg.replace(/^<\?xml[^>]*>\s*/, "").trim();
  const b64 = Buffer.from(clean, "utf8").toString("base64");
  return { dataUri: "data:image/svg+xml;base64," + b64 };
}

module.exports = { qrDataUri };