//! The address of the client behind trusted reverse proxies (A-03 login throttling).
//!
//! The app sees the address of the TCP peer. Behind a reverse proxy (Caddy) that is the proxy,
//! so the login throttle per client address would become one global throttle. The operator
//! names the proxies (`STUFFCLOUD_TRUSTED_PROXIES`, addresses or CIDR blocks); then, and only
//! then, the `X-Forwarded-For` header is read:
//!
//! - the peer is not a trusted proxy: the peer is the client, every header is ignored (a
//!   client cannot choose its own address by sending the header);
//! - otherwise the entries of all `X-Forwarded-For` fields are read from the right (the hop
//!   closest to the app) to the left; the first entry that is not a trusted proxy is the
//!   client. An entry that is not an IP address stops the walk: the last trusted hop before it
//!   counts as the client (a proxy that wrote garbage is not believed further left).
//!
//! The address is only used as a throttle key in memory ([`Bucket`]: an IPv6 client is keyed
//! by its /64, which one subscriber usually holds entirely); it is never stored or logged.

use std::fmt;
use std::net::IpAddr;

/// An address block: an address and a prefix length.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Block {
    address: IpAddr,
    prefix: u8,
}

/// The value of `STUFFCLOUD_TRUSTED_PROXIES` is not a list of addresses and blocks.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProxyListError(pub String);

impl fmt::Display for ProxyListError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            f,
            "{:?} is not an IP address or a CIDR block (such as 192.0.2.10 or 198.51.100.0/24)",
            self.0
        )
    }
}

impl std::error::Error for ProxyListError {}

/// The number of leading bits two addresses of the same family share, as 128-bit values.
fn bits(address: IpAddr) -> (u128, u8) {
    match address {
        IpAddr::V4(v4) => (u128::from(u32::from(v4)), 32),
        IpAddr::V6(v6) => (u128::from(v6), 128),
    }
}

/// Maps an IPv4-mapped IPv6 address (`::ffff:a.b.c.d`) to IPv4, so a dual-stack listener
/// treats it like the IPv4 address it is.
#[must_use]
pub fn canonical(address: IpAddr) -> IpAddr {
    match address {
        IpAddr::V6(v6) => v6.to_ipv4_mapped().map_or(address, IpAddr::V4),
        IpAddr::V4(_) => address,
    }
}

impl Block {
    /// Parses `address` or `address/prefix`.
    ///
    /// # Errors
    ///
    /// When the text is neither, or the prefix is longer than the address.
    pub fn parse(text: &str) -> Result<Self, ProxyListError> {
        let invalid = || ProxyListError(text.to_owned());
        let (address, prefix) = match text.split_once('/') {
            Some((address, prefix)) => (address, Some(prefix)),
            None => (text, None),
        };
        let address = canonical(address.parse::<IpAddr>().map_err(|_bad| invalid())?);
        let (_, width) = bits(address);
        let prefix = match prefix {
            None => width,
            Some(digits) if !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit()) => {
                digits.parse::<u8>().map_err(|_bad| invalid())?
            }
            Some(_) => return Err(invalid()),
        };
        if prefix > width {
            return Err(invalid());
        }
        Ok(Self { address, prefix })
    }

    /// Whether the block contains `address`.
    #[must_use]
    pub fn contains(&self, address: IpAddr) -> bool {
        let (mine, width) = bits(self.address);
        let (theirs, their_width) = bits(canonical(address));
        if width != their_width {
            return false;
        }
        // Both values are right-aligned in the same width; a shift by the whole width (a /0
        // block) leaves nothing to compare, so every address of the family matches.
        let host_bits = u32::from(width.saturating_sub(self.prefix));
        let network = |value: u128| value.checked_shr(host_bits).unwrap_or(0);
        network(mine) == network(theirs)
    }
}

/// The trusted reverse proxies.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProxyList(Vec<Block>);

impl ProxyList {
    /// Parses a comma-separated list of addresses and blocks; spaces around entries are
    /// ignored, an empty text is the empty list.
    ///
    /// # Errors
    ///
    /// The first entry that is not an address or a block.
    pub fn parse(text: &str) -> Result<Self, ProxyListError> {
        text.split(',')
            .map(str::trim)
            .filter(|entry| !entry.is_empty())
            .map(Block::parse)
            .collect::<Result<Vec<_>, _>>()
            .map(Self)
    }

    /// Whether `address` is a trusted proxy.
    #[must_use]
    pub fn contains(&self, address: IpAddr) -> bool {
        self.0.iter().any(|block| block.contains(address))
    }

    /// Whether the list is empty.
    #[must_use]
    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }
}

/// The client address of a request from `peer` with these `X-Forwarded-For` field values; see
/// the module documentation.
#[must_use]
pub fn client_address(peer: IpAddr, forwarded_for: &[&[u8]], trusted: &ProxyList) -> IpAddr {
    let mut client = canonical(peer);
    if !trusted.contains(client) {
        return client;
    }
    let entries: Vec<&[u8]> = forwarded_for
        .iter()
        .flat_map(|field| field.split(|byte| *byte == b','))
        .collect();
    for entry in entries.iter().rev() {
        let Some(address) = std::str::from_utf8(entry)
            .ok()
            .map(|text| text.trim_matches(|c: char| c == ' ' || c == '\t'))
            .and_then(|text| text.parse::<IpAddr>().ok())
            .map(canonical)
        else {
            return client;
        };
        client = address;
        if !trusted.contains(address) {
            return address;
        }
    }
    client
}

/// The throttle key of a client address: IPv4 as it is, IPv6 by its /64.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Bucket {
    /// An IPv4 address.
    V4([u8; 4]),
    /// The first 64 bits of an IPv6 address.
    V6([u8; 8]),
}

impl Bucket {
    /// The bucket of an address.
    #[must_use]
    pub fn of(address: IpAddr) -> Self {
        match canonical(address) {
            IpAddr::V4(v4) => Self::V4(v4.octets()),
            IpAddr::V6(v6) => {
                let [a, b, c, d, ..] = v6.segments();
                let mut prefix = [0_u8; 8];
                for (slot, segment) in prefix.chunks_exact_mut(2).zip([a, b, c, d]) {
                    slot.copy_from_slice(&segment.to_be_bytes());
                }
                Self::V6(prefix)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use std::net::{Ipv4Addr, Ipv6Addr};

    use super::*;

    fn ip(text: &str) -> IpAddr {
        text.parse().unwrap()
    }

    fn list(text: &str) -> ProxyList {
        ProxyList::parse(text).unwrap()
    }

    #[test]
    fn blocks() {
        let block = Block::parse("198.51.100.0/24").unwrap();
        assert!(block.contains(ip("198.51.100.0")));
        assert!(block.contains(ip("198.51.100.255")));
        assert!(!block.contains(ip("198.51.101.0")));
        assert!(!block.contains(ip("198.51.99.255")));
        assert!(block.contains(ip("::ffff:198.51.100.7")));
        assert!(!block.contains(ip("2001:db8::1")));
        let single = Block::parse("192.0.2.10").unwrap();
        assert!(single.contains(ip("192.0.2.10")));
        assert!(!single.contains(ip("192.0.2.11")));
        let all = Block::parse("0.0.0.0/0").unwrap();
        assert!(all.contains(ip("203.0.113.9")));
        assert!(!all.contains(ip("2001:db8::1")));
        let v6 = Block::parse("2001:db8::/32").unwrap();
        assert!(v6.contains(ip("2001:db8:ffff::1")));
        assert!(!v6.contains(ip("2001:db9::1")));
        assert!(!v6.contains(ip("192.0.2.1")));
        let host = Block::parse("2001:db8::1/128").unwrap();
        assert!(host.contains(ip("2001:db8::1")));
        assert!(!host.contains(ip("2001:db8::2")));
        assert!(Block::parse("::/0").unwrap().contains(ip("2001:db8::5")));
        // An IPv4-mapped address is IPv4, prefix included.
        assert!(
            Block::parse("::ffff:192.0.2.0/24")
                .unwrap()
                .contains(ip("192.0.2.5"))
        );
        assert!(Block::parse("::ffff:192.0.2.0/120").is_err());
        assert!(
            Block::parse("::ffff:192.0.2.1")
                .unwrap()
                .contains(ip("192.0.2.1"))
        );
        let odd = Block::parse("192.0.2.128/25").unwrap();
        assert!(odd.contains(ip("192.0.2.200")));
        assert!(!odd.contains(ip("192.0.2.127")));
    }

    #[test]
    fn invalid_blocks() {
        for bad in [
            "",
            "x",
            "192.0.2.1/33",
            "2001:db8::/129",
            "192.0.2.1/",
            "192.0.2.1/+8",
            "192.0.2.1/ 8",
            "192.0.2.1/300",
            "192.0.2.1/8/8",
            "192.0.2.256",
        ] {
            assert_eq!(
                Block::parse(bad),
                Err(ProxyListError(bad.to_owned())),
                "{bad}"
            );
        }
        assert_eq!(
            ProxyListError("x".to_owned()).to_string(),
            "\"x\" is not an IP address or a CIDR block (such as 192.0.2.10 or 198.51.100.0/24)"
        );
    }

    #[test]
    fn lists() {
        assert!(ProxyList::parse("").unwrap().is_empty());
        assert!(ProxyList::parse(" , ").unwrap().is_empty());
        let two = list(" 192.0.2.10 , 2001:db8::/32");
        assert!(!two.is_empty());
        assert!(two.contains(ip("192.0.2.10")));
        assert!(two.contains(ip("2001:db8::7")));
        assert!(!two.contains(ip("192.0.2.11")));
        assert_eq!(
            ProxyList::parse("192.0.2.10,nope"),
            Err(ProxyListError("nope".to_owned()))
        );
    }

    #[test]
    fn an_untrusted_peer_is_the_client() {
        let proxies = list("192.0.2.10");
        let peer = ip("203.0.113.5");
        assert_eq!(client_address(peer, &[b"198.51.100.1"], &proxies), peer);
        assert_eq!(client_address(peer, &[], &ProxyList::default()), peer);
        assert_eq!(
            client_address(ip("::ffff:203.0.113.5"), &[b"198.51.100.1"], &proxies),
            peer
        );
    }

    #[test]
    fn behind_a_trusted_proxy_the_rightmost_untrusted_entry_is_the_client() {
        let proxies = list("192.0.2.10, 192.0.2.11");
        let proxy = ip("192.0.2.10");
        assert_eq!(
            client_address(proxy, &[b"198.51.100.1, 203.0.113.7"], &proxies),
            ip("203.0.113.7")
        );
        assert_eq!(
            client_address(
                proxy,
                &[b"198.51.100.1", b"203.0.113.7, 192.0.2.11"],
                &proxies
            ),
            ip("203.0.113.7")
        );
        assert_eq!(
            client_address(proxy, &[b" 2001:db8::9 "], &proxies),
            ip("2001:db8::9")
        );
        // No header: the proxy itself.
        assert_eq!(client_address(proxy, &[], &proxies), proxy);
        // Only trusted hops: the leftmost of them.
        assert_eq!(
            client_address(proxy, &[b"192.0.2.11"], &proxies),
            ip("192.0.2.11")
        );
        // Garbage stops the walk at the last trusted hop.
        assert_eq!(
            client_address(proxy, &[b"203.0.113.7, unknown"], &proxies),
            proxy
        );
        assert_eq!(
            client_address(proxy, &[b"203.0.113.7, 192.0.2.11, \xff"], &proxies),
            ip("192.0.2.11")
        );
        assert_eq!(client_address(proxy, &[b""], &proxies), proxy);
        assert_eq!(
            client_address(proxy, &[b"::ffff:203.0.113.8"], &proxies),
            ip("203.0.113.8")
        );
    }

    #[test]
    fn buckets() {
        assert_eq!(
            Bucket::of(ip("192.0.2.1")),
            Bucket::V4(Ipv4Addr::new(192, 0, 2, 1).octets())
        );
        assert_eq!(
            Bucket::of(ip("::ffff:192.0.2.1")),
            Bucket::of(ip("192.0.2.1"))
        );
        assert_eq!(
            Bucket::of(ip("2001:db8:1:2:aaaa::1")),
            Bucket::of(ip("2001:db8:1:2:bbbb::2"))
        );
        assert_ne!(
            Bucket::of(ip("2001:db8:1:2::1")),
            Bucket::of(ip("2001:db8:1:3::1"))
        );
        assert_eq!(
            Bucket::of(IpAddr::V6(Ipv6Addr::new(
                0x2001, 0xdb8, 0x1234, 0x5678, 9, 9, 9, 9
            ))),
            Bucket::V6([0x20, 0x01, 0x0d, 0xb8, 0x12, 0x34, 0x56, 0x78])
        );
    }
}
