'use strict';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/**
 * Validates that the input is a TikTok link and returns a normalized URL string.
 * Returns null when the input is not acceptable.
 */
function parseTikTokUrl(input) {
  if (typeof input !== 'string') return null;
  let value = input.trim();
  if (!value || value.length > 500) return null;
  if (!/^https?:\/\//i.test(value)) value = 'https://' + value;

  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  const host = url.hostname.toLowerCase();
  if (host !== 'tiktok.com' && !host.endsWith('.tiktok.com')) return null;
  return url.toString();
}

/**
 * Basic SSRF guard for media URLs we are about to fetch on the server:
 * HTTPS only, a real public hostname, no IP literals, no internal suffixes.
 */
function isSafeMediaUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  if (!host.includes('.')) return false;
  if (host.includes(':') || host.startsWith('[')) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  if (/\.(local|localhost|internal|lan|home|corp)$/.test(host)) return false;
  return true;
}

function absoluteUrl(base, value) {
  if (!value || typeof value !== 'string') return null;
  try {
    return new URL(value, base).toString();
  } catch {
    return null;
  }
}

/** ASCII-only file name fragment, safe for headers and file systems. */
function safeFilename(value, fallback = 'tiktok') {
  const cleaned = String(value || '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return cleaned || fallback;
}

function contentDisposition(filename) {
  const name = String(filename).replace(/["\\\r\n]/g, '');
  return `attachment; filename="${name}"`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Runs `fn` over `items` with at most `limit` tasks in flight; keeps order. */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

module.exports = {
  HttpError,
  parseTikTokUrl,
  isSafeMediaUrl,
  absoluteUrl,
  safeFilename,
  contentDisposition,
  sleep,
  mapLimit,
};
