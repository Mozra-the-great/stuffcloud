# ADR 0009: Zone model: per-site visibility, per-zone policy, app on a shared domain

- Status: Accepted
- Date: 2026-11-16 (owner answer to SF5; written down 2026-11-18)
- Decided in: owner question SF5 (queue, 2026-11-16), issue
  [#117](https://github.com/Mozra-the-great/stuffcloud/issues/117),
  [SPEC 5](../SPEC.md#5-network-zones-domains-and-addressing)
- Supersedes: decisions 3, 4 and 7 of [ADR 0002](0002-static-hosting-and-origin-isolation.md)
  and the zone wording of decisions 1 and 6 of [ADR 0005](0005-auth-model.md)

## Context

ADR 0002 gave every zone one visibility (`internal` or `public`), let a site inherit it, kept
the app on a LAN-only app zone and required that hosted sites live on a registrable domain
different from the app's. In practice an operator has a handful of own domains and wants to
use each of them both on the LAN and from the internet; the visibility is a property of the
individual site, not of the domain. The operator also wants the app on one of those domains
(for example the app at `example.org` and sites at `*.example.org`) instead of buying a
separate domain for it. Some of those domains already carry other services with their own
logins (an identity provider at `auth.example.net` with a cookie for `.example.net`, another
web app), so who may host on a zone and which names are taken differ per zone.

A shared registrable domain removes the boundary ADR 0002 relied on: the app and the sites
become *same-site*, so `SameSite` cookies no longer separate them and a hosted site can set
cookies for the parent domain (cookie tossing). The isolation therefore has to come from the
app itself. A Public Suffix List (PSL) entry would restore a boundary between sites, but it
takes weeks, is an action towards a third party, and must not be a precondition for running
stuffcloud.

stuffcloud is open source and must work for any operator (CLAUDE.md, "Instance-neutral"):
no domain, service name or deployment detail may be hard-coded.

## Decision

1. **Zones are admin data, any number, nothing hard-coded.** A zone is a DNS zone the operator
   controls (Admin > Zones). Its sites are named `<name>.<zone>`, or `<name>.<sub-level>.<zone>`
   when the zone has an optional **sub-level** (one label, for example `web`, so sites are
   `*.web.example.com` while the rest of `example.com` stays untouched). The site base
   (`<zone>` or `<sub-level>.<zone>`) is never a site itself.
2. **Visibility is per site, not per zone.** Every zone can carry both kinds of site:
   - `internal`: served only to the LAN.
   - `public`: served to the LAN and through the tunnel.
   The owner picks the visibility when creating a site and can change it later, as far as the
   zone's policy allows.
3. **Per-zone policy, set by the admin** (each with a default; none is a code special case):
   - who may host: the roles allowed to create sites (default `user` and above) and an
     optional allow-list of accounts that replaces the role rule (the "trusted accounts only"
     setting);
   - anonymous hosting allowed: yes/no (default no);
   - public sites allowed: yes/no (default no, because public sites need DNS and a tunnel the
     operator has to set up first);
   - extra reserved names for the zone (for example the names of services that already run on
     the domain), on top of the built-in list in `core` and the instance-wide list;
   - optional sub-level (decision 1);
   - the interstitial warning for public sites (on by default, SPEC 16.7), so the setting
     asked for in H-03 is per zone;
   - an enabled flag and the reference to the DNS-01 provider credentials (the secret itself
     stays in deployment configuration).
   The documentation recommends that zones which already carry other logged-in services allow
   only trusted accounts, no anonymous hosting and reserve the names of those services, but
   this is a recommendation and a setting, not a rule in code.
4. **Anonymous sites are always `internal`.** A zone that allows anonymous hosting allows it
   for internal sites only; anonymous clients can never create a public site. This keeps the
   restriction of ADR 0002 decision 7 at the site level (temporary only, no JavaScript,
   smallest quota stay as they were). Whether this should ever become a per-zone setting is
   owner question SF10; until it is answered, this rule applies.
5. **Origin is decided by the listener, never by a header.** Caddy has two listeners:
   - the **LAN listener** answers the app address and every enabled site of every zone;
   - the **tunnel listener** is a separate port that only the tunnel connector can reach (an
     internal network, not published on the host). It answers only `public` sites and the
     `edge` routes of those sites. The app address is not configured on it at all.
   A request is treated as coming from the internet because it arrived on the tunnel
   listener, never because of `Host`, `X-Forwarded-*`, `Forwarded` or tunnel-specific headers.
   An `internal` site or the app address requested on the tunnel listener gets the same
   response as a name that does not exist, so the tunnel is no oracle for internal names.
6. **Split-horizon DNS is the deployment pattern** (documented, not implemented by
   stuffcloud): LAN DNS resolves the app address and the wildcard of every site base to the
   LAN listener; public DNS resolves the wildcard of a site base to the tunnel, and only for
   zones that allow public sites. The app address never has a public record that points to
   the tunnel, and the tunnel ingress never routes it; with decision 5 the app stays
   unreachable from the internet even if one of these is misconfigured.
7. **The app has its own address on any domain, also one shared with zones.** The app address
   stays deployment configuration (the proxy needs it at boot). It may be the apex or any name
   of a zone. It can never be a site: if it lies inside a site base, its label is reserved in
   that zone automatically (derived at runtime from the configuration, not written into code).
8. **Isolation by app hardening instead of a domain boundary.** Because hosted sites can be
   same-site with the app:
   - every cookie stuffcloud sets (app sessions, CSRF, OIDC state, the `edge` site-password
     cookie) uses the `__Host-` prefix (so `Secure`, `Path=/` and host-only);
   - no cookie anywhere carries a `Domain=` attribute; a CI check enforces it (planned with the
     first cookie code in A-02, [#32](https://github.com/Mozra-the-great/stuffcloud/issues/32),
     and extended to `edge` in H-19, [#104](https://github.com/Mozra-the-great/stuffcloud/issues/104));
   - the app reads only its own `__Host-` cookie names and ignores every other cookie, so a
     cookie tossed by a hosted site for the parent domain has no effect;
   - every state-changing request (any method other than `GET`, `HEAD`, `OPTIONS`) with cookie
     authentication must carry an `Origin` header equal to the app origin and a valid CSRF
     token; a missing or different `Origin` is refused, and a `Sec-Fetch-Site` value other
     than `same-origin` is refused when the header is present. `SameSite=Lax` stays on the
     session cookie but is not counted as a defence against hosted sites;
   - the app sends no CORS headers that allow a site origin; user HTML is never rendered in
     the app origin (unchanged from ADR 0002).
9. **A PSL entry is optional.** An operator may request one for a zone that serves only sites;
   nothing in stuffcloud depends on it, and the project does not file one. The threat model
   (H-01, [#45](https://github.com/Mozra-the-great/stuffcloud/issues/45)) documents what it
   would change.
10. **Certificates:** wildcard certificates per site base via DNS-01 (a sub-level needs its own
    wildcard, `*.<sub-level>.<zone>`), plus a certificate for the app address; the DNS provider
    is a Caddy plugin configured per zone (Cloudflare first).

Decisions 1, 2, 5, 6 and 8 of ADR 0002 (static only, Caddy from disk, `core` validation,
site headers, `edge`) are unchanged. Each site is still its own origin.

## Consequences

- Positive: one domain serves internal and public sites; an operator needs no second
  registrable domain for the app and can mix domains with existing services.
- Positive: the internet/LAN split is a property of the network path (which listener) and can
  be tested without trusting any header.
- Positive: every zone-specific behaviour is data, so the same code serves any instance; tests
  and examples use only RFC 2606 names.
- Negative: the app and sites can be same-site, so cookie and CSRF hardening is
  security-critical and needs its own tests: the `Domain=` CI check, per-route `Set-Cookie`
  assertions, CSRF and `Origin` tests for every state-changing route, and cookie-tossing tests
  (A-02, H-17).
- Negative: a hosted site with JavaScript can still fill the browser's cookie jar for the
  parent domain ("cookie bombing") so that requests to the app exceed header limits for that
  visitor until the cookies are cleared. This is a denial of service, not a data leak. It is
  accepted and documented; operators who host untrusted scripts on the app's domain can limit
  hosting there to trusted accounts, use a sub-level or another zone, or request a PSL entry.
- Negative: cookies that other services on a zone set with `Domain=.<zone>` are sent to every
  hosted site on that zone and, if not `HttpOnly`, readable by its scripts; a sub-level does
  not change that. This is why the recommendation in decision 3 exists; the threat model
  lists it.
- Negative: two listeners, split-horizon DNS and per-zone certificates are more deployment
  work. The infrastructure itself (DNS records, tunnel ingress, DNS-01 tokens) belongs to the
  operator's infrastructure, not to this repository.
- The data model grows: zone policy fields, per-zone reserved names and allowed accounts
  (SPEC 9).

## Open points

- SF10: anonymous public sites as a per-zone option, or always internal (decision 4 holds
  until answered).
- Transport between the tunnel connector and the tunnel listener (plain HTTP on an internal
  network or TLS with an origin certificate) is decided in H-03
  ([#47](https://github.com/Mozra-the-great/stuffcloud/issues/47)).
- The exact policy defaults and the admin UI are built in H-02
  ([#46](https://github.com/Mozra-the-great/stuffcloud/issues/46)); the mockup `AO` in
  `docs/design/` still shows one visibility per zone and is updated there.

## Alternatives considered

- **Visibility per zone (ADR 0002):** rejected by the owner (SF5); it forces one domain per
  visibility and does not match how operators use their domains.
- **App on its own registrable domain only (ADR 0002 decision 3):** no longer required. It is
  still the strongest isolation and stays possible; stuffcloud just does not depend on it.
- **PSL entry as a precondition (SF5 options a and b):** rejected; weeks of lead time, an
  external action, and useless for zones that also carry other services.
- **Detecting tunnel traffic by header (`CF-Connecting-IP`, `X-Forwarded-For`):** rejected;
  headers can be forged by any LAN client and by misconfigured proxies, a listener cannot.
- **Hard-coded handling of known services on a domain:** rejected; reserved names and the
  allow-list are per-zone settings.

## Links

- [SPEC 4](../SPEC.md#4-architecture-overview), [5](../SPEC.md#5-network-zones-domains-and-addressing), [6](../SPEC.md#6-users-roles-and-authentication), [8.3](../SPEC.md#83-access-options-per-site), [8.5](../SPEC.md#85-sandbox-and-isolation-static-only), [9](../SPEC.md#9-data-model-sketch), [14](../SPEC.md#14-quality-ci-and-testing), [16](../SPEC.md#16-decisions-on-the-former-open-questions)
- Issues [#117](https://github.com/Mozra-the-great/stuffcloud/issues/117), [#45](https://github.com/Mozra-the-great/stuffcloud/issues/45) (H-01), [#46](https://github.com/Mozra-the-great/stuffcloud/issues/46) (H-02), [#47](https://github.com/Mozra-the-great/stuffcloud/issues/47) (H-03), [#54](https://github.com/Mozra-the-great/stuffcloud/issues/54) (H-10), [#104](https://github.com/Mozra-the-great/stuffcloud/issues/104) (H-19), [#32](https://github.com/Mozra-the-great/stuffcloud/issues/32) (A-02)
- [ADR 0002](0002-static-hosting-and-origin-isolation.md), [ADR 0005](0005-auth-model.md), [ADR 0006](0006-edge-and-core.md)

## Addendum: visibility of anonymous and signed-in sites (2026-11-19, SF10)

Owner question SF10 (open point 1 above) is answered, so decision 4 is no longer provisional.
Nothing in decisions 2 to 4 changes; the answer fixes the rule and says how decision 2 and
decision 3 combine:

- **Anonymous sites are always `internal`.** An anonymous client can never create or switch to a
  `public` site, in any zone, whatever the zone settings say. There is no per-zone or
  instance-wide setting for anonymous public sites; that variant (SF10 b/c) was not chosen. The
  zone setting "anonymous hosting" only decides whether anonymous clients may host (internal,
  temporary, no JavaScript) at all.
- **Signed-in users choose per site.** An account that may host in a zone (decision 3, "who may
  host") picks `internal` or `public` for each of its sites, at creation and later, on the same
  zone.
- **The zone limits the choice.** The choice exists only if the zone's setting "public sites
  allowed" (decision 3, default off) is on. With it off, every site in the zone is `internal`
  and the form offers no choice; the API refuses `public` (rule `public_not_allowed`).
  Switching the setting off while public sites exist is refused with the list of those sites
  (ADR 0010 decision 9).
- **One function decides.** `stuffcloud_core::hosting::may_host` already implements exactly this
  (A-07): anonymous plus `public` is refused (`anonymous_public`), a signed-in account plus
  `public` needs `public_sites` (`public_not_allowed`), `internal` needs nothing beyond the
  hosting rule. The UI, the API and the CLI all go through it; tests cover both sides of each
  rule (`crates/core/src/hosting.rs`, `crates/core/tests/policy_properties.rs`).

SF10 as asked offered "anonymous public sites per zone" as an option; the owner chose a variant of
the default: no anonymous public sites at all, signed-in users choose per site within what the zone
allows. This keeps the largest abuse vector (anonymous content reachable from the internet) out of
the product and leaves the zone policy as the only operator lever.
