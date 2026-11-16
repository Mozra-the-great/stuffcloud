# ADR 0002: Static-only hosting and origin isolation

- Status: Accepted
- Date: 2026-11-05 (SPEC draft 0.2; carried into draft 0.3 on 2026-11-14)
- Decided in: [SPEC 2, 5 and 8.5](../SPEC.md#85-sandbox-and-isolation-static-only)

## Context

The hosting half of stuffcloud publishes content that strangers upload: text, files, whole
websites, optionally with JavaScript. The instance is reachable from the internet
([SPEC 2](../SPEC.md#2-goals-and-non-goals)), so a hosted site must not be able to attack the
app, other sites or their visitors, and the server must stay small. This is the
security-critical part of the product, which is why hosting ships after auth and quotas
([SPEC 15](../SPEC.md#15-phases)).

## Decision

1. **No server-side execution of user content.** Hosted sites are static files. Server-side
   execution of user code (containers, functions) is a non-goal of v1.
2. **Caddy serves sites directly from disk**, routing by `Host` header. Caddy, not
   stuffcloud, is the hot path for site traffic ([SPEC 4](../SPEC.md#4-architecture-overview)).
3. **Every site is its own origin on a registrable domain different from the app's**, so
   cookies and same-origin access cannot leak between sites or into the app (the model of
   `githubusercontent.com`). User-provided HTML is never rendered inside the app origin;
   previews use a sandboxed iframe from the site origin.
4. **Zones are operator configuration.** The operator enters any number of root domains in
   Admin > Zones, each `internal` or `public`; a site's visibility follows its zone. Only the
   app zone's address is deployment configuration. The app zone is LAN only and never routed
   through the tunnel; `cloudflared` exposes only public zones. Wildcard certificates per zone
   via DNS-01 with a per-zone Caddy DNS plugin (Cloudflare first)
   ([SPEC 5](../SPEC.md#5-network-zones-domains-and-addressing), 16.2).
5. **Names and paths are validated by `core`:** subdomains are random (10 symbols, 50 bits)
   or chosen by accounts from a reserved-name list, with no Punycode; uploaded file names
   pass `SafeRelPath` before anything touches the disk (SPEC 5, 8.1; ADR 0006).
6. **Response headers on sites** ([SPEC 8.5](../SPEC.md#85-sandbox-and-isolation-static-only)):
   a strict `Content-Security-Policy` (anonymous: no scripts; accounts: scripts allowed with
   `form-action` and `frame-ancestors` restricted), `X-Content-Type-Options: nosniff`,
   `Referrer-Policy`, `Cross-Origin-Opener-Policy`, `X-Robots-Tag: noindex` by default, and no
   platform cookie except the optional site-password cookie. Executables and dangerous types
   are refused or served as download only.
7. **Anonymous hosting is the most restricted tier:** internal zones only, temporary only, no
   JavaScript, smallest quota ([SPEC 6, 8.4](../SPEC.md#6-users-roles-and-authentication)).
8. **The few things a public site needs from a server** (site password, burn after reading,
   abuse report) are not part of the static path; they run in the separate `edge` process
   (ADR 0006).

## Consequences

- Positive: a hosted site cannot run code on the server, and a bug in a site cannot reach the
  app's cookies or API, because they never share an origin or a registrable domain. Delivery
  costs almost no application CPU or RAM.
- Positive: the public attack surface is Caddy's static serving plus `edge`; the app stays on
  the LAN.
- Negative: sites cannot have a backend, forms that post to the server or dynamic features;
  that is intended for v1.
- Negative: the operator needs a registrable domain for sites that differs from the app's
  domain, wildcard DNS and a DNS-01 capable provider per zone.
- Negative: scripts are allowed for accounts, so a malicious site can still attack its own
  visitors (phishing, stored XSS within its own origin). That is why the SPEC adds an
  interstitial on public zones, a report button, a moderator queue, blocklists and fast
  takedown (SPEC 8.5, 8.6, 16.7).
- The header sets and the isolation rules need tests per kind of content (SPEC 14, "Edge
  tests") and are covered by the hosting security review (H-17, #61).

## Open points

- The hosting threat model (STRIDE including `edge`), the exact CSP and header sets for
  anonymous and account sites and the `Content-Type` allow/deny table are written in H-01
  ([#45](https://github.com/Mozra-the-great/stuffcloud/issues/45), `docs/security/hosting.md`);
  this ADR fixes the principles, not the header strings.
- Effect and timing of a Public Suffix List entry for public site zones, and the registrable
  domain of the first public zone: open owner question SF5 (see #45). Submitting a PSL request
  happens only with the owner's explicit go.
- Real wildcard certificates for staging versus a test CA until the staged rollout (H-02,
  [#46](https://github.com/Mozra-the-great/stuffcloud/issues/46)): open owner question SF4.
- How a non-filesystem storage backend would feed Caddy: see ADR 0003, open there.

## Alternatives considered

- **Server-side execution of user code** (containers, functions): a non-goal of v1
  (SPEC 2). It would put arbitrary code on the exposed host.
- **Sites as paths or subdomains of the app's own domain:** rejected in SPEC 5, which
  requires different registrable domains so that cookies and same-origin access cannot leak.
  Path-based hosting is not named in the SPEC; it is excluded by "each site is its own origin".
- **Serving sites through the Rust application:** not chosen; SPEC 4 makes Caddy the hot
  path so site traffic costs the application nothing. The SPEC does not discuss this
  option further.

## Links

- [SPEC 2](../SPEC.md#2-goals-and-non-goals), [4](../SPEC.md#4-architecture-overview), [5](../SPEC.md#5-network-zones-domains-and-addressing), [8.5](../SPEC.md#85-sandbox-and-isolation-static-only), [8.6](../SPEC.md#86-abuse-handling), [16](../SPEC.md#16-decisions-on-the-former-open-questions)
- Issues [#45](https://github.com/Mozra-the-great/stuffcloud/issues/45) (H-01), [#46](https://github.com/Mozra-the-great/stuffcloud/issues/46) (H-02), [#47](https://github.com/Mozra-the-great/stuffcloud/issues/47) (H-03), [#61](https://github.com/Mozra-the-great/stuffcloud/issues/61) (H-17)
- [ADR 0003](0003-storage-abstraction.md), [ADR 0006](0006-edge-and-core.md)
