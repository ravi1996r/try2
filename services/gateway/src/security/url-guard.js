/**
 * URL validation for the Drop-Zone fetcher. Runs BEFORE any DNS lookup.
 *
 * WHY this is separate from ip-classifier.js: this module answers "is this URL even well-formed and
 * permitted as a shape?", and the classifier answers "is the address it resolves to safe?". Both
 * are needed: a shape check alone misses `http://evil.test` resolving to 127.0.0.1, and an address
 * check alone misses `file:///etc/passwd`.
 */
import { classifyAddress } from './ip-classifier.js';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
/** Only 80/443. A fetcher that honours :22 or :6379 is an SSRF primitive. */
export const ALLOWED_PORTS = new Set([80, 443]);

/** Hostnames that always mean "this machine" regardless of DNS. */
const LOCAL_HOSTNAMES = new Set([
  'localhost', 'localhost.localdomain', 'ip6-localhost', 'ip6-loopback',
  '0.0.0.0', '::', '[::]', '0',
]);

/**
 * @typedef {object} UrlCheck
 * @property {boolean} ok
 * @property {string} [reason] machine-readable reason code
 * @property {string} [message] safe message for the UI (never echoes the full URL)
 * @property {URL} [url] the parsed URL when ok
 */

/**
 * Validate a user-supplied URL for the Drop-Zone fetcher.
 *
 * @param {string} raw
 * @param {{allowLoopback?: boolean}} [opts]
 *   allowLoopback exists ONLY so the local test server can be reached in integration tests. It is
 *   never enabled in production, and the flag is honoured here so a caller cannot accidentally
 *   combine a production config with a loopback-permitting option.
 * @returns {UrlCheck}
 */
export function checkFetchableUrl(raw, { allowLoopback = false } = {}) {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return { ok: false, reason: 'empty', message: 'Enter a URL.' };
  }
  // WHY trim and cap length: an unbounded string is a cheap DoS, and leading whitespace is used to
  // smuggle " file://..." past naive parsers.
  const value = raw.trim();
  if (value.length > 2048) {
    return { ok: false, reason: 'too_long', message: 'That URL is too long.' };
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    return { ok: false, reason: 'unparseable', message: 'That does not look like a valid URL.' };
  }

  if (!ALLOWED_PROTOCOLS.has(url.protocol)) {
    return {
      ok: false,
      reason: 'protocol_not_allowed',
      message: 'Only http and https URLs can be fetched.',
    };
  }

  // WHY reject credentials: http://user@host is a phishing trick AND a way to make a log line or an
  // error message look like a trusted URL when it is not.
  if (url.username || url.password) {
    return {
      ok: false,
      reason: 'credentials_in_url',
      message: 'URLs containing a username or password are not accepted.',
    };
  }

  const port = url.port === '' ? (url.protocol === 'https:' ? 443 : 80) : Number(url.port);
  if (!ALLOWED_PORTS.has(port)) {
    return {
      ok: false,
      reason: 'port_not_allowed',
      message: 'Only standard web ports (80 and 443) can be fetched.',
    };
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === '') {
    return { ok: false, reason: 'no_host', message: 'That URL has no host.' };
  }

  // WHY the hostname check happens here AND the address check after resolution: this catches the
  // literal spellings, and classification catches a public name that resolves privately.
  if (!allowLoopback && LOCAL_HOSTNAMES.has(host)) {
    return {
      ok: false,
      reason: 'loopback_hostname',
      message: 'Local addresses cannot be fetched.',
    };
  }

  // A hostname that is itself a literal IP still goes through classification, so a URL containing
  // 127.0.0.1 is refused without a DNS round trip at all.
  if (!allowLoopback && looksLikeIpLiteral(host)) {
    const label = classifyAddress(host);
    if (label) {
      return {
        ok: false,
        reason: `blocked_address_${label}`,
        message: 'That address is not reachable from this service.',
      };
    }
  }

  return { ok: true, url };
}

/** @returns {boolean} true when the host is a literal IPv4/IPv6 address rather than a name. */
function looksLikeIpLiteral(host) {
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return true;
  // WHY the leading colons are allowed here: a bare IPv6 loopback host arrives as '::1' once the
  // brackets are stripped from '[::1]'. A pattern requiring a hex digit before the first colon
  // misses it, which is a real bypass -- the guard would fall through and treat it as a hostname.
  if (/^[0-9a-f]*:[0-9a-f:]*$/i.test(host) && host.includes(':')) return true;
  // Hex / decimal integer forms of an IPv4 address. NOTE: the WHATWG URL parser already normalises
  // 2130706433 and 0x7f000001 to 127.0.0.1, so these are defence in depth rather than the main line.
  if (/^0x[0-9a-f]+$/i.test(host)) return true;
  if (/^\d{8,10}$/.test(host)) return true;
  return false;
}