import { describe, test, expect } from 'vitest';
import {
  classifyAddress, classifyIPv4, classifyIPv6, isBlockedAddress, assertSafeResolvedAddresses,
} from '../../src/security/ip-classifier.js';
import { checkFetchableUrl } from '../../src/security/url-guard.js';

/**
 * The SSRF corpus from the brief (section 8.6), plus the encodings that make a short blocklist
 * insufficient. Each entry is an ADDRESS or URL that MUST be refused.
 *
 * WHY a corpus as data rather than as individual expects: the list is the security policy. Keeping
 * it in one array makes it reviewable in one screen, and makes it obvious when an entry is added.
 */
const BLOCKED_ADDRESSES = [
  // Loopback, in every spelling that resolves to it.
  '127.0.0.1', '127.1', '127.0.0.53', '2130706433', '0x7f000001', '017700000001', '127.0.1',
  // IPv6 loopback and its mapped form.
  '::1', '[::1]', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::ffff:7f00:1',
  // Cloud metadata. The single highest-value SSRF target.
  '169.254.169.254', '169.254.170.2', '100.100.100.200', 'fd00:ec2::254',
  // Link-local.
  '169.254.0.1', 'fe80::1',
  // RFC1918 private ranges, plus their boundary neighbours.
  '10.0.0.1', '10.255.255.255', '172.16.0.1', '172.31.255.255', '192.168.0.1', '192.168.1.1',
  // CGNAT: not RFC1918, but not routable on the internet either.
  '100.64.0.1', '100.127.255.255',
  // Multicast, reserved, unspecified, broadcast.
  '224.0.0.1', '239.255.255.255', '240.0.0.1', '255.255.255.255', '0.0.0.0', '::',
  // IPv6 unique local.
  'fc00::1', 'fd12:3456:789a::1',
  // Malformed input must be refused rather than treated as public.
  '999.999.999.999', '1.2.3', 'not-an-ip', '', '   ',
];

const PUBLIC_ADDRESSES = [
  '8.8.8.8', '1.1.1.1', '93.184.216.34', '172.32.0.1', '172.15.255.255', '192.169.0.1',
  '100.63.255.255', '100.128.0.1', '2606:4700:4700::1111',
];

describe('SSRF: every blocked address in the corpus is refused', () => {
  // WHY one test over the whole corpus rather than one test per entry: a failure message naming
  // the offending address is more useful than 40 passing tests.
  for (const ip of BLOCKED_ADDRESSES) {
    test(`refuses ${JSON.stringify(ip)}`, () => {
      expect(isBlockedAddress(ip)).toBe(true);
    });
  }
});

describe('SSRF: public addresses are allowed', () => {
  for (const ip of PUBLIC_ADDRESSES) {
    test(`allows ${ip}`, () => {
      // WHY assert the exact null and not just falsy: a wrong-but-truthy label would still pass a
      // loose check, and "invalid" vs "private" changes the operator-facing message.
      expect(classifyAddress(ip)).toBeNull();
    });
  }
});

describe('SSRF: the label is accurate', () => {
  test.each([
    ['127.0.0.1', 'loopback'],
    ['10.1.2.3', 'private'],
    ['172.16.0.1', 'private'],
    ['192.168.1.1', 'private'],
    ['169.254.1.1', 'link_local'],
    ['100.64.0.1', 'cgnat'],
    ['224.0.0.1', 'multicast'],
    ['0.0.0.0', 'unspecified'],
    ['255.255.255.255', 'reserved'],
    ['999.1.1.1', 'invalid'],
  ])('%s -> %s', (ip, label) => {
    expect(classifyIPv4(ip)).toBe(label);
  });

  test.each([
    ['::1', 'loopback'],
    ['::', 'unspecified'],
    ['fc00::1', 'unique_local'],
    ['fe80::1', 'link_local'],
    ['ff02::1', 'multicast'],
    // The mapped forms must produce the INNER IPv4's label, not "ok".
    ['::ffff:127.0.0.1', 'loopback'],
    ['::ffff:10.0.0.1', 'private'],
    ['::ffff:7f00:1', 'loopback'],
  ])('%s -> %s', (ip, label) => {
    expect(classifyIPv6(ip)).toBe(label);
  });

  test('a public IPv4-mapped address is allowed', () => {
    expect(classifyIPv6('::ffff:8.8.8.8')).toBeNull();
  });

  test('cloud metadata endpoints are labelled metadata', () => {
    // WHY: link-local already covers 169.254.169.254, but naming it explicitly means the log line
    // says "metadata endpoint" rather than "link local", which is the actionable message.
    expect(classifyIPv4('169.254.169.254')).toBe('metadata');
    expect(classifyIPv6('fd00:ec2::254')).toBe('metadata');
  });
});

describe('SSRF: boundary conditions on private ranges', () => {
  // WHY these specific pairs: an off-by-one in 172.16/12 or 100.64/10 turns a private range into a
  // public one, which is the whole ballgame.
  test.each([
    ['172.15.255.255', null], ['172.16.0.0', 'private'], ['172.31.255.255', 'private'],
    ['172.32.0.0', null],
    ['100.63.255.255', null], ['100.64.0.0', 'cgnat'], ['100.127.255.255', 'cgnat'],
    ['100.128.0.0', null],
    ['192.167.255.255', null], ['192.168.0.0', 'private'], ['192.169.0.0', null],
  ])('%s -> %s', (ip, label) => {
    expect(classifyIPv4(ip)).toBe(label);
  });
});

describe('SSRF: URL-level guard rejects the payload list', () => {
  // WHY these are URL strings rather than addresses: the guard is what runs FIRST, before any DNS,
  // so it must refuse the dangerous SHAPES. The IP classifier covers what DNS reveals.
  // WHY some expectations below are about Node's WHATWG URL parser rather than my own rules: the
  // parser normalises integer-literal IPv4 BEFORE the guard ever sees it. Measured behaviour
  // (node 24): 2130706433, 0x7f000001 and 017700000001 all arrive as hostname '127.0.0.1'. That is
  // better than relying on my own integer decoding, so the expectations below assert the real
  // outcome instead of the outcome I originally assumed.
  const BLOCKED_URLS = [
    ['http://127.0.0.1/', 'blocked_address_loopback'],
    ['https://localhost/', 'loopback_hostname'],
    ['http://localhost:8080/admin', 'port_not_allowed'], // port rule fires before the hostname rule
    ['http://[::1]/', 'blocked_address_loopback'],
    ['http://169.254.169.254/latest/meta-data/', 'blocked_address_metadata'],
    ['http://10.0.0.5/', 'blocked_address_private'],
    ['http://192.168.1.1/', 'blocked_address_private'],
    ['http://172.16.0.1/', 'blocked_address_private'],
    ['http://2130706433/', 'blocked_address_loopback'],
    ['http://0x7f000001/', 'blocked_address_loopback'],
    ['http://017700000001/', 'blocked_address_loopback'],
    ['file:///etc/passwd', 'protocol_not_allowed'],
    ['gopher://127.0.0.1:6379/_INFO', 'protocol_not_allowed'],
    ['ftp://example.com/x', 'protocol_not_allowed'],
    ['javascript:alert(1)', 'protocol_not_allowed'],
    ['data:text/html,<script>alert(1)</script>', 'protocol_not_allowed'],
    ['http://user@127.0.0.1/', 'credentials_in_url'],
    ['http://user:pass@example.com/', 'credentials_in_url'],
    ['http://example.com:22/', 'port_not_allowed'],
    ['http://example.com:6379/', 'port_not_allowed'],
    ['http://example.com:8080/', 'port_not_allowed'],
    ['', 'empty'],
    ['   ', 'empty'],
    ['not a url', 'unparseable'],
    ['ht!tp://weird', 'unparseable'],
  ];

  for (const [url, reason] of BLOCKED_URLS) {
    test(`refuses ${JSON.stringify(url)} (${reason})`, () => {
      const r = checkFetchableUrl(url);
      expect(r.ok).toBe(false);
      expect(r.reason).toBe(reason);
    });
  }

  test('an over-long URL is refused before parsing', () => {
    const r = checkFetchableUrl(`https://example.com/${'a'.repeat(2100)}`);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('too_long');
  });

  test('a rejection message never echoes the full URL', () => {
    // WHY: the message goes into the UI and potentially a log. Echoing a hostile URL back is a
    // reflected-content problem and can leak embedded credentials into a log line.
    const r = checkFetchableUrl('http://user:hunter2@127.0.0.1/');
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toContain('hunter2');
  });
});

describe('SSRF: URL-level guard allows ordinary public URLs', () => {
  test.each([
    'https://example.com/',
    'http://example.com/page?a=1',
    'https://sub.domain.example.org:443/x',
    'https://8.8.8.8/',
  ])('allows %s', (url) => {
    const r = checkFetchableUrl(url);
    expect(r.ok).toBe(true);
    expect(r.url.hostname).toBeTruthy();
  });

  test('default ports are accepted when omitted', () => {
    expect(checkFetchableUrl('http://example.com').ok).toBe(true);
    expect(checkFetchableUrl('https://example.com').ok).toBe(true);
  });

  test('allowLoopback is required before a loopback URL is permitted', () => {
    // WHY the flag is an explicit option and not inferred: it exists ONLY so integration tests can
    // reach a local test server. Making it opt-in at the call site means a production caller cannot
    // get loopback access by accident.
    expect(checkFetchableUrl('http://127.0.0.1:8080/x').ok).toBe(false);
});
});

describe('SSRF: the guard returns a usable URL object', () => {
  test('an allowed URL parses to a populated URL', () => {
    // WHY assert host presence: a guard returning ok:true with an empty hostname would pass a
    // boolean check while handing the fetcher something it cannot connect to.
    // NOTE: URL.port is '' for an explicit default port, because the WHATWG parser normalises
    // ':443' on an https URL away. Asserting '443' here would be asserting a parser quirk.
    const r = checkFetchableUrl('https://sub.domain.example.org:443/x');
    expect(r.url.hostname).toBe('sub.domain.example.org');
    expect(r.url.protocol).toBe('https:');
    expect(r.ok).toBe(true);
  });

  test('default ports are accepted when omitted', () => {
    expect(checkFetchableUrl('http://example.com').ok).toBe(true);
    expect(checkFetchableUrl('https://example.com').ok).toBe(true);
  });

  test('allowLoopback is required before a loopback URL is permitted', () => {
    // WHY the flag is an explicit option and not inferred: it exists ONLY so integration tests can
    // reach a local test server. Opt-in at the call site means a production caller cannot get
    // loopback access by accident.
    // NOTE: the default-port URL is used because the port rule is checked BEFORE the loopback rule,
    // so a URL like http://127.0.0.1:8080/ would be refused for its PORT even with the flag on. That
    // ordering is deliberate: it is the stricter of the two rules.
    expect(checkFetchableUrl('http://127.0.0.1/x').ok).toBe(false);
    expect(checkFetchableUrl('http://127.0.0.1/x', { allowLoopback: true }).ok).toBe(true);
  });

  test('a non-standard port is refused even when loopback is allowed', () => {
    // WHY: allowLoopback must not become a blanket bypass. It relaxes the ADDRESS rule for the local
    // test server, not the port rule, so it cannot be used to reach :6379 or :22.
    expect(checkFetchableUrl('http://127.0.0.1:6379/x', { allowLoopback: true }).reason)
      .toBe('port_not_allowed');
  });
});

describe('SSRF: every resolved address must be safe', () => {
  test('a mixed public/private resolution is refused', () => {
    // WHY: DNS returns a LIST. Checking only the first would let an attacker win by ordering, so a
    // hostname resolving to one public and one private address must be refused outright.
    const r = assertSafeResolvedAddresses(['93.184.216.34', '127.0.0.1']);
    expect(r.ok).toBe(false);
    expect(r.blocked).toBe('loopback');
    expect(r.ip).toBe('127.0.0.1');
  });

  test('all-public resolution is allowed', () => {
    expect(assertSafeResolvedAddresses(['93.184.216.34', '8.8.8.8']).ok).toBe(true);
  });

  test('an empty resolution is refused, not treated as safe', () => {
    // WHY: "no addresses" must fail closed. An empty result that passed would be a silent allow.
    expect(assertSafeResolvedAddresses([]).ok).toBe(false);
    expect(assertSafeResolvedAddresses(undefined).ok).toBe(false);
  });

  test('a public name with a private answer is refused (DNS rebinding defence)', () => {
    // WHY: this is the rebinding case. The HOSTNAME is innocuous, so only a post-resolution check
    // catches it. The fetcher must additionally PIN this address for the connection.
    const r = assertSafeResolvedAddresses(['169.254.169.254']);
    expect(r.ok).toBe(false);
    expect(r.blocked).toBe('metadata');
  });
});
