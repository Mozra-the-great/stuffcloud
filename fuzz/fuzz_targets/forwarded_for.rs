//! Feeds a trusted-proxy list (first line) and `X-Forwarded-For` values (one field per further
//! line) to `stuffcloud_core::client_ip`. Fails on a panic and when the client address breaks a
//! rule: an untrusted peer is always the client whatever the header says; behind a trusted peer
//! the client is the peer or one of the header's entries; every listed block contains its own
//! address.
#![no_main]

use std::net::IpAddr;

use libfuzzer_sys::fuzz_target;
use stuffcloud_core::client_ip::{Block, Bucket, ProxyList, canonical, client_address};

fuzz_target!(|data: &[u8]| {
    let mut lines = data.split(|byte| *byte == b'\n');
    let Some(first) = lines.next() else {
        return;
    };
    let fields: Vec<&[u8]> = lines.collect();
    let Ok(list_text) = std::str::from_utf8(first) else {
        return;
    };
    let Ok(proxies) = ProxyList::parse(list_text) else {
        return;
    };
    for entry in list_text
        .split(',')
        .map(str::trim)
        .filter(|e| !e.is_empty())
    {
        let block = Block::parse(entry).expect("an entry of a parsed list parses");
        let address: IpAddr = entry.split('/').next().unwrap().parse().unwrap();
        assert!(block.contains(address));
    }
    let entries: Vec<IpAddr> = fields
        .iter()
        .flat_map(|field| field.split(|byte| *byte == b','))
        .filter_map(|entry| std::str::from_utf8(entry).ok())
        .filter_map(|entry| entry.trim_matches([' ', '\t']).parse::<IpAddr>().ok())
        .map(canonical)
        .collect();
    let peers: [IpAddr; 3] = [
        "203.0.113.5".parse().unwrap(),
        "2001:db8::5".parse().unwrap(),
        entries.first().copied().unwrap_or([192, 0, 2, 1].into()),
    ];
    for peer in peers {
        let client = canonical(client_address(peer, &fields, &proxies));
        if !proxies.contains(peer) {
            assert_eq!(client, canonical(peer));
            continue;
        }
        assert!(client == canonical(peer) || entries.contains(&client));
        assert_eq!(Bucket::of(client), Bucket::of(canonical(client)));
    }
});
