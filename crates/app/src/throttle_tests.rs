//! Tests of [`crate::throttle`].

use std::net::IpAddr;

use super::*;

fn client(text: &str) -> Bucket {
    Bucket::of(text.parse::<IpAddr>().unwrap())
}

fn entry(table: &Table<Bucket>, key: Bucket) -> Option<Entry> {
    table.lock().get(&key).copied()
}

fn account_entry(throttles: &Throttles, key: AccountKey) -> Option<Entry> {
    throttles.accounts.lock().get(&key).copied()
}

/// A failed login attempt, the way the handlers make one.
fn fail_login(throttles: &Throttles, from: Bucket, key: AccountKey, now: i64) -> Result<(), i64> {
    throttles.reserve_login(from, key, true, now)?.failed(now);
    Ok(())
}

#[test]
fn the_rules_have_their_documented_values() {
    assert_eq!(
        CLIENT_RULE,
        Rule {
            free: 20,
            base_ms: 1000,
            max_ms: 900_000,
            window_ms: 3_600_000,
        }
    );
    assert_eq!(
        ACCOUNT_RULE,
        Rule {
            free: 10,
            base_ms: 1000,
            max_ms: 900_000,
            window_ms: 3_600_000,
        }
    );
    assert_eq!(
        REGISTER_RULE,
        Rule {
            free: 5,
            base_ms: 60_000,
            max_ms: 3_600_000,
            window_ms: 21_600_000,
        }
    );
    assert_eq!(KNOWN_FOR_MS, 2_592_000_000);
    assert_eq!(CAPACITY, 50_000);
    assert_eq!(KNOWN_PER_ACCOUNT, 16);
    assert_eq!(EVICTION_SHARE, 16);
}

#[test]
fn account_keys_ignore_case_and_whitespace_and_ids_are_their_own() {
    assert_eq!(account_key(" Alice "), account_key("alice"));
    assert_ne!(account_key("alice"), account_key("bob"));
    assert_eq!(id_key(7), AccountKey::Id(7));
    assert_ne!(id_key(7), id_key(8));
    assert!(matches!(account_key("7"), AccountKey::Typed(_)));
}

#[test]
fn parallel_attempts_of_one_account_get_exactly_its_free_failures_plus_one() {
    let throttles = Throttles::default();
    let key = account_key("alice");
    let mut running = Vec::new();
    let mut refused = Vec::new();
    for n in 0..40 {
        match throttles.reserve_login(client(&format!("198.51.100.{n}")), key, true, 0) {
            Ok(reservation) => running.push(reservation),
            Err(wait) => refused.push(wait),
        }
    }
    assert_eq!(running.len(), 11);
    // The refused ones were told to wait the delay of the running ones, and nothing of theirs
    // is counted: their addresses are not even in the table.
    assert_eq!(refused.first(), Some(&1000));
    assert!(refused.iter().all(|wait| *wait >= 1000));
    assert_eq!(throttles.sizes()[0], 11);
    for reservation in running {
        reservation.failed(0);
    }
    assert_eq!(
        account_entry(&throttles, key),
        Some(Entry {
            failures: Failures {
                count: 11,
                last_at: 0
            },
            in_flight: 0
        })
    );
    // Now the plain wait applies, and after it one attempt at a time.
    assert_eq!(
        throttles
            .reserve_login(client("203.0.113.1"), key, true, 999)
            .err(),
        Some(1)
    );
    let one = throttles
        .reserve_login(client("203.0.113.1"), key, true, 1000)
        .unwrap();
    assert_eq!(
        throttles
            .reserve_login(client("203.0.113.2"), key, true, 1000)
            .err(),
        Some(2000)
    );
    one.failed(1000);
    assert_eq!(
        throttles
            .reserve_login(client("203.0.113.2"), key, true, 1000)
            .err(),
        Some(2000)
    );
}

#[test]
fn parallel_attempts_of_one_address_get_exactly_its_free_failures_plus_one() {
    let throttles = Throttles::default();
    let a = client("192.0.2.1");
    let mut running = Vec::new();
    for n in 0..40 {
        if let Ok(reservation) = throttles.reserve_login(a, account_key(&format!("u{n}")), true, 0)
        {
            running.push(reservation);
        }
    }
    assert_eq!(running.len(), 21);
    assert_eq!(throttles.sizes()[1], 21);
    drop(running);
    // Dropped unsettled: every one counts as a failure.
    assert_eq!(entry(&throttles.clients, a).unwrap().failures.count, 21);
    assert_eq!(
        throttles.reserve_client(a, 0).err(),
        Some(1000),
        "the address rule now refuses"
    );
    // Another address and the same /64 behave as before.
    assert!(throttles.reserve_client(client("192.0.2.2"), 0).is_ok());
    let first = throttles.reserve_client(client("2001:db8::1"), 0).unwrap();
    first.failed(0);
    assert_eq!(
        entry(&throttles.clients, client("2001:db8::2")).map(|e| e.failures.count),
        Some(1)
    );
}

#[test]
fn a_refused_account_gives_the_address_its_place_back() {
    let throttles = Throttles::default();
    let key = account_key("alice");
    for n in 0..11 {
        fail_login(&throttles, client(&format!("198.51.100.{n}")), key, 0).unwrap();
    }
    let a = client("192.0.2.9");
    assert_eq!(throttles.reserve_login(a, key, true, 0).err(), Some(1000));
    assert_eq!(entry(&throttles.clients, a), None);
}

#[test]
fn a_refund_counts_nothing_and_a_success_forgets_the_account_only() {
    let throttles = Throttles::default();
    let key = account_key("alice");
    let a = client("192.0.2.1");
    throttles.reserve_login(a, key, true, 0).unwrap().refund();
    assert_eq!(throttles.sizes(), [0, 0, 0, 0]);
    for _ in 0..5 {
        fail_login(&throttles, a, key, 0).unwrap();
    }
    throttles.reserve_login(a, key, true, 0).unwrap().refund();
    assert_eq!(entry(&throttles.clients, a).unwrap().failures.count, 5);
    throttles
        .reserve_login(a, key, true, 10)
        .unwrap()
        .succeeded(10);
    assert_eq!(account_entry(&throttles, key), None);
    assert_eq!(
        entry(&throttles.clients, a),
        Some(Entry {
            failures: Failures {
                count: 5,
                last_at: 0
            },
            in_flight: 0
        })
    );
    assert_eq!(throttles.sizes(), [1, 0, 0, 1]);
}

#[test]
fn a_success_keeps_the_places_of_other_running_attempts() {
    let throttles = Throttles::default();
    let key = account_key("alice");
    let other = throttles
        .reserve_login(client("198.51.100.1"), key, true, 0)
        .unwrap();
    throttles
        .reserve_login(client("198.51.100.2"), key, true, 0)
        .unwrap()
        .succeeded(0);
    assert_eq!(
        account_entry(&throttles, key),
        Some(Entry {
            failures: Failures::default(),
            in_flight: 1
        })
    );
    other.failed(5);
    assert_eq!(
        account_entry(&throttles, key),
        Some(Entry {
            failures: Failures {
                count: 1,
                last_at: 5
            },
            in_flight: 0
        })
    );
}

#[test]
fn an_added_account_key_counts_with_the_others() {
    let throttles = Throttles::default();
    let a = client("192.0.2.1");
    let mut reservation = throttles
        .reserve_login(a, account_key("alice"), true, 0)
        .unwrap();
    reservation.add_account(id_key(1), 0).unwrap();
    reservation.failed(0);
    assert_eq!(
        account_entry(&throttles, id_key(1)).unwrap().failures.count,
        1
    );
    // Ten failures by name and address together throttle the account under any name.
    for n in 0..10 {
        let typed = if n % 2 == 0 {
            "alice"
        } else {
            "alice@example.com"
        };
        let mut reservation = throttles
            .reserve_login(
                client(&format!("198.51.100.{n}")),
                account_key(typed),
                true,
                0,
            )
            .unwrap();
        reservation.add_account(id_key(1), 0).unwrap();
        reservation.failed(0);
    }
    let mut fresh = throttles
        .reserve_login(
            client("203.0.113.1"),
            account_key("ALICE@example.org"),
            true,
            0,
        )
        .unwrap();
    assert_eq!(fresh.add_account(id_key(1), 0), Err(1000));
    fresh.failed(0);
    // The refused key took no place and got no failure.
    assert_eq!(
        account_entry(&throttles, id_key(1)).unwrap().failures.count,
        11
    );
    assert_eq!(
        account_entry(&throttles, account_key("ALICE@example.org"))
            .unwrap()
            .failures
            .count,
        1
    );
}

#[test]
fn a_known_address_skips_the_account_rule_but_its_failures_count() {
    let throttles = Throttles::default();
    let key = account_key("alice");
    let home = client("192.0.2.7");
    throttles
        .reserve_login(home, key, true, 0)
        .unwrap()
        .succeeded(0);
    for n in 0..12 {
        let _ = fail_login(&throttles, client(&format!("198.51.100.{n}")), key, 100);
    }
    assert!(
        throttles
            .reserve_login(client("203.0.113.9"), key, true, 100)
            .is_err()
    );
    // Exempt: no place taken, but the failure is booked on the account too.
    fail_login(&throttles, home, key, 100).unwrap();
    assert_eq!(
        account_entry(&throttles, key).unwrap(),
        Entry {
            failures: Failures {
                count: 12,
                last_at: 100
            },
            in_flight: 0
        }
    );
    // Not when exemptions are off for the attempt (an unlisted proxy).
    assert!(throttles.reserve_login(home, key, false, 100).is_err());
    // The exemption ends after 30 days.
    assert!(throttles.is_known(key, home, KNOWN_FOR_MS - 1));
    assert!(!throttles.is_known(key, home, KNOWN_FOR_MS));
    assert!(
        throttles
            .reserve_login(home, key, true, KNOWN_FOR_MS - 1)
            .is_ok()
    );
}

#[test]
fn without_exemptions_a_login_makes_nothing_known() {
    let throttles = Throttles::default();
    let mut reservation = throttles
        .reserve_login(client("172.18.0.3"), account_key("alice"), false, 0)
        .unwrap();
    reservation.add_account(id_key(1), 0).unwrap();
    reservation.succeeded(0);
    assert_eq!(throttles.sizes()[3], 0);
    let mut reservation = throttles
        .reserve_login(client("192.0.2.1"), account_key("alice"), true, 0)
        .unwrap();
    reservation.add_account(id_key(1), 0).unwrap();
    reservation.succeeded(0);
    assert_eq!(throttles.sizes()[3], 2);
    assert!(throttles.is_known(id_key(1), client("192.0.2.1"), 0));
    assert!(!throttles.is_known(id_key(2), client("192.0.2.1"), 0));
}

#[test]
fn known_addresses_are_capped_per_account_and_never_pushed_out_by_others() {
    let mut known = KnownTable::default();
    let alice = account_key("alice");
    for n in 0..16_i64 {
        known.record(alice, client(&format!("192.0.2.{n}")), n, 100);
    }
    assert_eq!(known.pairs, 16);
    // A repeated login refreshes its own entry.
    known.record(alice, client("192.0.2.0"), 50, 100);
    assert_eq!(known.pairs, 16);
    // The 17th address replaces the account's own oldest (192.0.2.1 at 1).
    known.record(alice, client("192.0.2.200"), 60, 100);
    assert_eq!(known.pairs, 16);
    assert!(known.is_known(alice, client("192.0.2.200"), 60));
    assert!(!known.is_known(alice, client("192.0.2.1"), 60));
    assert!(known.is_known(alice, client("192.0.2.0"), 60));
    assert!(known.is_known(alice, client("192.0.2.2"), 60));
    // A full table takes no new pair, and drops nothing for it.
    let mut full = KnownTable::default();
    full.record(alice, client("192.0.2.1"), 0, 2);
    full.record(account_key("bob"), client("192.0.2.2"), 0, 2);
    full.record(account_key("eve"), client("192.0.2.3"), 1, 2);
    full.record(alice, client("192.0.2.4"), 1, 2);
    assert_eq!(full.pairs, 2);
    assert!(full.is_known(alice, client("192.0.2.1"), 1));
    assert!(full.is_known(account_key("bob"), client("192.0.2.2"), 1));
    assert!(!full.is_known(account_key("eve"), client("192.0.2.3"), 1));
    // The sweep frees room: exactly 30 days old is gone.
    full.record(alice, client("192.0.2.1"), 10, 2);
    assert_eq!(full.sweep(KNOWN_FOR_MS), 1);
    assert_eq!(full.pairs, 1);
    assert!(!full.accounts.contains_key(&account_key("bob")));
    assert_eq!(full.sweep(KNOWN_FOR_MS + 9), 0);
    assert_eq!(full.sweep(KNOWN_FOR_MS + 10), 1);
    assert!(full.accounts.is_empty());
}

#[test]
fn a_full_table_drops_the_fewest_failures_first_and_never_a_running_attempt() {
    let throttles = Throttles::with_capacity(3);
    let (victim, a, b) = (
        client("192.0.2.1"),
        client("192.0.2.2"),
        client("192.0.2.3"),
    );
    for _ in 0..5 {
        throttles.reserve_client(victim, 0).unwrap().failed(0);
    }
    throttles.reserve_client(a, 10).unwrap().failed(10);
    throttles.reserve_client(b, 5).unwrap().failed(5);
    // New keys push out the ones with one failure, oldest first, never the counter of five.
    throttles
        .reserve_client(client("192.0.2.4"), 20)
        .unwrap()
        .failed(20);
    assert_eq!(entry(&throttles.clients, b), None);
    assert!(entry(&throttles.clients, a).is_some());
    throttles
        .reserve_client(client("192.0.2.5"), 30)
        .unwrap()
        .failed(30);
    assert_eq!(entry(&throttles.clients, a), None);
    assert_eq!(entry(&throttles.clients, victim).unwrap().failures.count, 5);
    // An existing key is updated without dropping anything.
    throttles.reserve_client(victim, 40).unwrap().failed(40);
    assert_eq!(throttles.sizes()[0], 3);
    // Stale keys go before anything recent, whatever their count.
    let throttles = Throttles::with_capacity(2);
    for _ in 0..5 {
        throttles.reserve_client(victim, 0).unwrap().failed(0);
    }
    throttles
        .reserve_client(a, HOUR_MS)
        .unwrap()
        .failed(HOUR_MS);
    throttles
        .reserve_client(b, HOUR_MS)
        .unwrap()
        .failed(HOUR_MS);
    assert_eq!(entry(&throttles.clients, victim), None);
    assert!(entry(&throttles.clients, a).is_some());
    // Keys with a running attempt stay; with nothing else to drop a new key waits.
    let throttles = Throttles::with_capacity(2);
    let first = throttles.reserve_client(a, 0).unwrap();
    let second = throttles.reserve_client(b, 0).unwrap();
    assert_eq!(throttles.reserve_client(victim, 0).err(), Some(1000));
    assert_eq!(throttles.register_attempt(victim, 0), None);
    first.refund();
    assert!(throttles.reserve_client(victim, 0).is_ok());
    assert!(entry(&throttles.clients, b).is_some());
    second.refund();
}

#[test]
fn a_full_table_drops_a_sixteenth_at_once() {
    let throttles = Throttles::with_capacity(32);
    for n in 0..32_i64 {
        throttles
            .reserve_client(client(&format!("192.0.2.{n}")), n)
            .unwrap()
            .failed(n);
    }
    assert_eq!(throttles.sizes()[0], 32);
    throttles
        .reserve_client(client("198.51.100.1"), 40)
        .unwrap()
        .failed(40);
    // Two of 32 went (the two oldest); the next new key needs no scan.
    assert_eq!(throttles.sizes()[0], 31);
    assert_eq!(entry(&throttles.clients, client("192.0.2.0")), None);
    assert_eq!(entry(&throttles.clients, client("192.0.2.1")), None);
    assert!(entry(&throttles.clients, client("192.0.2.2")).is_some());
    throttles
        .reserve_client(client("198.51.100.2"), 41)
        .unwrap()
        .failed(41);
    assert_eq!(throttles.sizes()[0], 32);
}

#[test]
fn a_settled_failure_without_room_is_dropped() {
    let table = Table::new(CLIENT_RULE, 1);
    let (a, b) = (client("192.0.2.1"), client("192.0.2.2"));
    table.reserve(a, 0).unwrap();
    // `b` never took a place: booking it needs room, and `a` is running.
    table.settle(b, false, Outcome::Failed, 0);
    assert_eq!(table.len(), 1);
    assert_eq!(table.lock().get(&b), None);
    table.settle(a, true, Outcome::Failed, 0);
    table.settle(b, false, Outcome::Failed, 0);
    assert_eq!(table.lock().get(&b).unwrap().failures.count, 1);
    assert_eq!(table.lock().get(&a), None);
}

#[test]
fn registrations_are_counted_per_address() {
    let throttles = Throttles::default();
    let a = client("192.0.2.1");
    for _ in 0..5 {
        assert_eq!(throttles.register_attempt(a, 0), None);
    }
    assert_eq!(throttles.register_attempt(a, 0), None);
    assert_eq!(throttles.register_attempt(a, 0), Some(MINUTE_MS));
    // A refused attempt does not count.
    assert_eq!(throttles.register_attempt(a, MINUTE_MS - 1), Some(1));
    assert_eq!(throttles.register_attempt(a, MINUTE_MS), None);
    assert_eq!(
        throttles.register_attempt(a, MINUTE_MS),
        Some(2 * MINUTE_MS)
    );
    assert_eq!(throttles.register_attempt(client("192.0.2.2"), 0), None);
    assert_eq!(throttles.sizes(), [0, 0, 2, 0]);
}

#[test]
fn the_sweep_drops_forgotten_keys_only() {
    let throttles = Throttles::default();
    let (a, b) = (client("192.0.2.1"), client("192.0.2.2"));
    fail_login(&throttles, a, account_key("x"), 0).unwrap();
    fail_login(&throttles, b, account_key("y"), 10).unwrap();
    assert_eq!(throttles.register_attempt(a, 0), None);
    let running = throttles.reserve_client(client("192.0.2.3"), 0).unwrap();
    throttles
        .reserve_login(b, account_key("z"), true, 0)
        .unwrap()
        .succeeded(0);
    assert_eq!(throttles.sizes(), [3, 2, 1, 1]);
    assert_eq!(throttles.sweep(HOUR_MS - 1), 0);
    // An hour after their failure the address and account keys go (the running one stays),
    // the registration needs six hours, the known address 30 days.
    assert_eq!(throttles.sweep(HOUR_MS), 2);
    assert_eq!(throttles.sizes(), [2, 1, 1, 1]);
    assert_eq!(throttles.sweep(HOUR_MS + 10), 2);
    assert_eq!(throttles.sizes(), [1, 0, 1, 1]);
    assert_eq!(throttles.sweep(6 * HOUR_MS), 1);
    assert_eq!(throttles.sweep(KNOWN_FOR_MS), 1);
    assert_eq!(throttles.sizes(), [1, 0, 0, 0]);
    running.refund();
    assert_eq!(throttles.sizes(), [0, 0, 0, 0]);
}
