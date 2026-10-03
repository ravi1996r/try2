/**
 * SSRF address classification.
 *
 * WHY this file exists and why it is standalone: it is the most security-critical piece of pure
 * logic in the project, and the piece most worth testing exhaustively. A Drop-Zone URL fetch that
 * can be pointed at 169.254.169.254 reads cloud credentials; one pointed at 127.0.0.1 reaches this
 * project's own loopback services. Everything here is a deny decision.
 *
 * ALTERNATIVES considered:
 *  - Rely on a library or a WAF (rejected as the primary control: it hides the policy, and I need to
 *    state exactly which ranges are refused and prove it with a corpus).
 *  - Blocklist a few well-known addresses (rejected: 0x7f000001, 2130706433 and 127.1 are all
 *    127.0.0.1, and 169.254.169.254 is only one of several metadata endpoints).
 *  - Resolve-and-check only (rejected: DNS rebinding. This classifies the RESOLVED address; the
 *    fetcher must ALSO pin that address for the connection. Classification alone is not enough.)
 *
 * TRADE-OFF: this is necessarily a blocklist, because SSRF protection reduces to "is this address
 * reachable that I did not intend?" and a default-deny allowlist is impossible for a general URL
 * fetcher. The list covers every reserved range plus the cloud metadata endpoints, and
 * tests/security/ proves each entry.
 */

/** Cloud metadata endpoints. Blocked explicitly, in addition to being covered by link-local. */
export const CLOUD_METADATA_ADDRESSES = new Set([
  '169.254.169.254', // AWS / Azure / GCP / DigitalOcean
  '169.254.170.2', // AWS ECS task metadata
  '100.100.100.200', // Alibaba Cloud
  'fd00:ec2::254', // AWS IMDSv6
]);

/**
 * Classify an IPv4 dotted-quad into a block label, or null when it is a normal public address.
 * @param {string} ip
 * @returns {string|null}
 */
export function classifyIPv4(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return 'invalid';
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return 'invalid';
  const [a, b] = nums;

  // WHY the metadata check comes FIRST: every metadata address is already inside a reserved range
  // (169.254.169.254 is link_local, 100.100.100.200 is CGNAT, fd00:ec2::254 is unique-local), so if
  // the range checks ran first this one would be dead code and the label would always be the
  // generic one. The DENY is correct either way; only the message quality differs, and "metadata
  // endpoint" tells an operator what actually happened where "link local" does not.
  if (CLOUD_METADATA_ADDRESSES.has(ip)) return 'metadata';

  if (a === 0) return 'unspecified'; // 0.0.0.0/8 "this network"
  if (a === 10) return 'private'; // 10.0.0.0/8
  if (a === 127) return 'loopback'; // 127.0.0.0/8
  if (a === 100 && b >= 64 && b <= 127) return 'cgnat'; // 100.64.0.0/10
  if (a === 169 && b === 254) return 'link_local'; // 169.254.0.0/16
  if (a === 172 && b >= 16 && b <= 31) return 'private'; // 172.16.0.0/12
  if (a === 192 && b === 0) return 'reserved'; // 192.0.0.0/24 IETF protocol assignments
  if (a === 192 && b === 168) return 'private'; // 192.168.0.0/16
  if (a === 198 && (b === 18 || b === 19)) return 'reserved'; // 198.18.0.0/15 benchmarking
  if (a === 198 && b === 51) return 'reserved'; // 198.51.100.0/24 TEST-NET-2
  if (a === 203 && b === 0) return 'reserved'; // 203.0.113.0/24 TEST-NET-3
  if (a >= 224 && a <= 239) return 'multicast'; // 224.0.0.0/4
  if (a >= 240) return 'reserved'; // 240.0.0.0/4, includes 255.255.255.255

  return null;
}

/**
 * Classify an IPv6 address (already normalised by the caller: no zone id, no brackets).
 * @param {string} ip
 * @returns {string|null}
 */
export function classifyIPv6(ip) {
  const lower = ip.toLowerCase();

  // WHY the IPv4-mapped checks come BEFORE the character-class guard: a mapped address embeds
  // DOTTED DECIMAL (::ffff:127.0.0.1), so a guard that allows only [0-9a-f:] would reject the very
  // syntax it is meant to catch, and the request would be refused as "invalid" instead of being
  // recognised as loopback. Both outcomes deny the request, but only the correct label tells an
  // operator what an attacker actually tried.
  //
  // ::ffff:127.0.0.1 is a valid IPv6 literal that reaches 127.0.0.1. Treating "it's IPv6, therefore
  // fine" is the classic bypass.
  const dotted = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
  if (dotted) return classifyIPv4(dotted[1]);

  // Also catch the hex form, e.g. ::ffff:7f00:1, which is the same address.
  const hex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hex) {
    const hi = parseInt(hex[1], 16);
    const lo = parseInt(hex[2], 16);
    return classifyIPv4(`${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`);
  }

  // Only now reject characters that cannot appear in an IPv6 literal.
  if (!/^[0-9a-f:]+$/.test(lower)) return 'invalid';

  // Same ordering reason as classifyIPv4: fd00:ec2::254 is also inside fc00::/7, so the metadata
  // check must precede the unique-local check to produce the specific label.
  if (CLOUD_METADATA_ADDRESSES.has(lower)) return 'metadata';

  // WHY compare against a NORMALISED form: ::1 and 0:0:0:0:0:0:0:1 are the SAME address written two
  // ways, and an equality test against the literal '::1' only catches the first. Stripping leading
  // zero groups collapses the expanded form. Full RFC 4291 textual normalisation is overkill here:
  // this only needs to make equivalent spellings of the two addresses we care about compare equal.
  const groups = lower.split(':');
  const allZero = groups.every((g) => g === '0' || g === '');
  if (allZero) return 'unspecified';

  const trailing = groups[groups.length - 1];
  const leadingAllZero = groups.slice(0, -1).every((g) => g === '0' || g === '');
  if (leadingAllZero && (trailing === '1' || trailing === '')) {
    // Covers ::1, 0:0:0:0:0:0:0:1 and 0000:...:0001.
    return trailing === '1' ? 'loopback' : 'unspecified';
  }

  const first = lower.split(':')[0] ?? '';
  if (/^f[cd]/.test(first)) return 'unique_local'; // fc00::/7
  if (/^fe[89ab]/.test(first)) return 'link_local'; // fe80::/10
  if (/^ff/.test(first)) return 'multicast'; // ff00::/8

  return null;
}

/**
 * The full classifier. Returns a label when the address MUST be refused, or null when it is an
 * ordinary routable public address.
 *
 * WHY it takes an already-resolved address rather than a hostname: the fetcher resolves first and
 * then calls this on every resolved address, so a public-looking hostname that resolves to
 * 127.0.0.1 is caught. See `assertSafeResolvedAddresses` for the "refuse if ANY resolved address
 * is bad" rule.
 *
 * @param {string} ip
 * @returns {string|null} block label, or null if safe
 */
export function classifyAddress(ip) {
  if (typeof ip !== 'string' || ip.length === 0) return 'invalid';
  const trimmed = ip.trim().replace(/^\[/, '').replace(/\]$/, '');
  if (trimmed.includes(':')) return classifyIPv6(trimmed);
  return classifyIPv4(trimmed);
}

/** @returns {boolean} true when the address must NOT be connected to. */
export function isBlockedAddress(ip) {
  return classifyAddress(ip) !== null;
}

/**
 * Refuse the request unless EVERY resolved address is safe.
 *
 * WHY "every" and not "the first": a hostname with several A records could resolve to one public
 * and one private address. Checking only the first would let an attacker win by ordering. This is
 * why a partially-failing lookup is a refusal rather than a retry.
 *
 * @param {string[]} addresses
 * @returns {{ok: boolean, blocked?: string, ip?: string}}
 */
export function assertSafeResolvedAddresses(addresses) {
  if (!addresses || addresses.length === 0) return { ok: false, blocked: 'no_address' };
  for (const ip of addresses) {
    const label = classifyAddress(ip);
    if (label) return { ok: false, blocked: label, ip };
  }
  return { ok: true };
}
