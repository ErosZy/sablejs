"use strict";

// Small platform adapters shared by compiler-only code. The browser build
// intentionally does not ship Node polyfills, so these helpers must stay on
// standard globals with guarded Node fast paths.

function monotonicNow() {
  if (typeof performance !== "undefined" && performance && typeof performance.now === "function") {
    return performance.now();
  }
  if (
    typeof process !== "undefined" &&
    process &&
    process.hrtime &&
    typeof process.hrtime.bigint === "function"
  ) {
    return Number(process.hrtime.bigint()) / 1e6;
  }
  return Date.now();
}

// Base64-encodes a UTF-8 string. Node fast path via Buffer; browsers and
// workers go through TextEncoder + btoa; a chunked byte fallback covers
// embedded hosts with neither. Used for inline source-map data URLs.
function base64EncodeUtf8(value) {
  const text = String(value);
  if (typeof Buffer !== "undefined" && Buffer && typeof Buffer.from === "function") {
    return Buffer.from(text, "utf8").toString("base64");
  }
  if (typeof btoa === "function") {
    const bytes =
      typeof TextEncoder !== "undefined" ? new TextEncoder().encode(text) : encodeUtf8(text);
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode.apply(null, bytes.subarray(index, index + 0x8000));
    }
    return btoa(binary);
  }
  return base64FromBytes(encodeUtf8(text));
}

const BASE64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

// Base64 over a raw byte array, with standard trailing padding.
function base64FromBytes(bytes) {
  let output = "";
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes[index];
    const second = index + 1 < bytes.length ? bytes[index + 1] : 0;
    const third = index + 2 < bytes.length ? bytes[index + 2] : 0;
    const triple = (first << 16) | (second << 8) | third;
    output += BASE64_ALPHABET[(triple >> 18) & 63];
    output += BASE64_ALPHABET[(triple >> 12) & 63];
    output += index + 1 < bytes.length ? BASE64_ALPHABET[(triple >> 6) & 63] : "=";
    output += index + 2 < bytes.length ? BASE64_ALPHABET[triple & 63] : "=";
  }
  return output;
}

// Dependency-free UTF-8 byte encoding (same semantics as TextEncoder:
// lone surrogates encode as U+FFFD). Returns a Uint8Array so every caller —
// the btoa chunking loop (which uses subarray) and the manual base64
// fallback — can treat it like TextEncoder output.
function encodeUtf8(text) {
  const bytes = [];
  for (let index = 0; index < text.length; index += 1) {
    let unit = text.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff && index + 1 < text.length) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        unit = 0x10000 + ((unit - 0xd800) << 10) + (next - 0xdc00);
        index += 1;
      } else {
        unit = 0xfffd;
      }
    } else if (unit >= 0xd800 && unit <= 0xdfff) {
      unit = 0xfffd;
    }
    if (unit <= 0x7f) {
      bytes.push(unit);
    } else if (unit <= 0x7ff) {
      bytes.push(0xc0 | (unit >> 6), 0x80 | (unit & 0x3f));
    } else if (unit <= 0xffff) {
      bytes.push(0xe0 | (unit >> 12), 0x80 | ((unit >> 6) & 0x3f), 0x80 | (unit & 0x3f));
    } else {
      bytes.push(
        0xf0 | (unit >> 18),
        0x80 | ((unit >> 12) & 0x3f),
        0x80 | ((unit >> 6) & 0x3f),
        0x80 | (unit & 0x3f)
      );
    }
  }
  return new Uint8Array(bytes);
}

function utf8ByteLength(value) {
  const text = String(value);
  if (typeof Buffer !== "undefined" && Buffer && typeof Buffer.byteLength === "function") {
    return Buffer.byteLength(text);
  }
  if (typeof TextEncoder !== "undefined") {
    return new TextEncoder().encode(text).byteLength;
  }

  // ES2020 browser engines have TextEncoder, but keep a dependency-free
  // fallback for embedded hosts. Lone surrogates encode as U+FFFD, matching
  // TextEncoder and Buffer.byteLength.
  let bytes = 0;
  for (let index = 0; index < text.length; index += 1) {
    const unit = text.charCodeAt(index);
    if (unit <= 0x7f) {
      bytes += 1;
    } else if (unit <= 0x7ff) {
      bytes += 2;
    } else if (
      unit >= 0xd800 &&
      unit <= 0xdbff &&
      index + 1 < text.length &&
      text.charCodeAt(index + 1) >= 0xdc00 &&
      text.charCodeAt(index + 1) <= 0xdfff
    ) {
      bytes += 4;
      index += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

module.exports = { base64EncodeUtf8, monotonicNow, utf8ByteLength };
