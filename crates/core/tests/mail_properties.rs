//! Property tests of the optional mailer's building blocks (A-10): the `smtp` settings group,
//! secret references, host names, the texts of the mails and the retry schedule.

use proptest::prelude::*;
use stuffcloud_core::account::Email;
use stuffcloud_core::body::{Writable, canonical, parse_writable};
use stuffcloud_core::mail::{Language, MAX_ATTEMPTS, ResetMail, retry_delay};
use stuffcloud_core::smtp::{
    MAX_HOST_LEN, SECRET_PREFIX, SecretRef, Smtp, SmtpSecurity, valid_from_name, valid_host,
};

fn security() -> impl Strategy<Value = SmtpSecurity> {
    prop_oneof![
        Just(SmtpSecurity::Starttls),
        Just(SmtpSecurity::Tls),
        Just(SmtpSecurity::None),
    ]
}

fn language() -> impl Strategy<Value = Language> {
    prop_oneof![Just(Language::En), Just(Language::De)]
}

/// Text with line breaks, NUL, non-ASCII and the characters that blur a header, which no header
/// may carry.
fn nasty() -> BoxedStrategy<String> {
    prop::collection::vec(
        prop_oneof![
            Just('\r'),
            Just('\n'),
            Just('\0'),
            Just('\u{85}'),
            Just('\u{2028}'),
            Just('<'),
            Just('>'),
            Just('"'),
            Just('@'),
            Just(' '),
            any::<char>(),
        ],
        0..40,
    )
    .prop_map(|chars| chars.into_iter().collect())
    .boxed()
}

/// Mostly well-formed text of a shape, sometimes a nasty one, so that valid documents are common.
fn either(valid: &'static str) -> BoxedStrategy<String> {
    prop_oneof![3 => valid.boxed(), 1 => nasty()].boxed()
}

fn smtp(
    host: String,
    port: u16,
    security: SmtpSecurity,
    login: Option<(String, String)>,
    from: String,
    from_name: Option<String>,
) -> Smtp {
    Smtp {
        host,
        port,
        security,
        username: login.as_ref().map(|(username, _)| username.clone()),
        password: login.map(|(_, reference)| SecretRef { name: reference }),
        from,
        from_name,
    }
}

proptest! {
    /// Whatever the settings say, a valid document never lets a control character into a place
    /// that ends up in a protocol command or a header, never has credentials on a plain
    /// connection and always has a usable sender.
    #[test]
    fn a_valid_group_cannot_carry_an_injection(
        host in either("[a-z]{1,8}(\\.[a-z]{2,5}){0,2}"),
        port in any::<u16>(),
        security in security(),
        username in prop::option::of(either("[a-z]{1,8}")),
        reference in prop::option::of(either("STUFFCLOUD_SECRET_[A-Z]{1,8}")),
        from in either("[a-z]{1,8}@[a-z]{1,8}\\.[a-z]{2,3}"),
        from_name in prop::option::of(either("[A-Za-z]{1,10}")),
    ) {
        let login = username.zip(reference);
        let candidate = smtp(host, port, security, login, from, from_name);
        if candidate.validate().is_empty() {
            let controls = |text: &str| text.chars().any(char::is_control);
            prop_assert!(!controls(&candidate.host));
            prop_assert!(valid_host(&candidate.host));
            prop_assert!(candidate.port >= 1);
            if let Some(username) = &candidate.username {
                prop_assert!(!controls(username));
                prop_assert!(candidate.password.is_some());
            }
            if let Some(name) = &candidate.from_name {
                prop_assert!(!controls(name));
                prop_assert!(!name.contains(['<', '>', '"', '\\']));
                prop_assert!(valid_from_name(name));
            }
            if candidate.security == SmtpSecurity::None {
                prop_assert!(candidate.username.is_none() && candidate.password.is_none());
            }
            prop_assert!(candidate.from_address().is_some());
            prop_assert!(candidate.from.is_ascii() && !controls(&candidate.from));
            if let Some(reference) = &candidate.password {
                prop_assert!(reference.name.starts_with(SECRET_PREFIX));
                prop_assert!(reference.check().is_ok());
            }
        }
    }

    /// A document that validates survives its canonical form (what the store keeps).
    #[test]
    fn a_valid_group_round_trips_through_its_canonical_form(
        host in "[a-z][a-z0-9]{0,10}(\\.[a-z]{2,6}){0,2}",
        port in 1_u16..,
        security in security(),
        name in prop::option::of("[A-Za-z0-9 ]{1,20}"),
    ) {
        let candidate = Smtp {
            host,
            port,
            security,
            username: None,
            password: None,
            from: "noreply@example.com".to_owned(),
            from_name: name.filter(|n| n.trim() == n),
        };
        prop_assume!(candidate.validate().is_empty());
        let again: Smtp = parse_writable(canonical(&candidate).as_bytes()).unwrap();
        prop_assert_eq!(again, candidate);
    }

    #[test]
    fn an_accepted_reference_is_a_prefixed_upper_case_name(text in "[A-Za-z0-9_ ]{0,80}") {
        let reference = SecretRef { name: text.clone() };
        if reference.check().is_ok() {
            prop_assert!(text.starts_with(SECRET_PREFIX));
            prop_assert!(text.len() <= 64);
            prop_assert!(!text.ends_with("_FILE"));
            let name = text.strip_prefix(SECRET_PREFIX).unwrap();
            prop_assert!(!name.is_empty());
            prop_assert!(name
                .bytes()
                .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_'));
            prop_assert_eq!(reference.file_variable(), format!("{text}_FILE"));
        }
    }

    #[test]
    fn a_host_name_has_no_character_outside_the_dns_alphabet(text in "[a-zA-Z0-9.:\\[\\]_ /@-]{0,80}") {
        if valid_host(&text) {
            prop_assert!(!text.is_empty() && text.len() <= MAX_HOST_LEN);
            prop_assert!(
                text.parse::<std::net::IpAddr>().is_ok()
                    || text
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'.')
            );
            prop_assert!(!text.contains(['@', '/', '[', ']', ' ', '_']));
        }
    }

    /// The mail names the account, the app and the link, once each in the place the template
    /// gives them, has no line break in its subject, no carriage return and no angle bracket in
    /// its text, and says nothing else that looks like a link.
    #[test]
    fn a_reset_mail_has_one_link_and_a_one_line_subject(
        language in language(),
        login in "[a-z0-9._-]{3,32}",
        token in "[0-9a-f]{64}",
        minutes in 1_i64..=720,
    ) {
        let app = "https://app.example.com";
        let link = format!("{app}/password-reset#token={token}");
        let rendered = ResetMail {
            language,
            app,
            login: &login,
            link: &link,
            valid_minutes: minutes,
        }
        .render();
        prop_assert!(!rendered.subject.contains(['\r', '\n']));
        prop_assert!(rendered.subject.chars().count() <= 60);
        prop_assert!(!rendered.text.contains(['\r', '<', '>']));
        prop_assert_eq!(rendered.text.matches(token.as_str()).count(), 1);
        let own_line = format!("\n{link}\n");
        prop_assert!(rendered.text.contains(&own_line));
        let greeting = match language {
            Language::En => "Hello ",
            Language::De => "Hallo ",
        };
        prop_assert!(rendered.text.starts_with(greeting));
        prop_assert!(rendered.text.contains(&minutes.to_string()));
        prop_assert!(rendered.text.ends_with('\n'));
        prop_assert!(!rendered.text.contains("http://"));
        // A line of the prose stays short even with the longest login name (32 characters);
        // only the link line may be longer.
        for line in rendered.text.lines().filter(|line| *line != link) {
            prop_assert!(line.chars().count() <= 90, "{line}");
        }
    }

    /// The schedule waits longer after every failure and ends after `MAX_ATTEMPTS` attempts.
    #[test]
    fn the_retry_schedule_never_shortens_and_ends(failed in 0_usize..40) {
        match (retry_delay(failed), retry_delay(failed.saturating_add(1))) {
            (Some(now), Some(next)) => prop_assert!(next > now),
            (None, Some(_)) => prop_assert_eq!(failed, 0),
            (Some(_), None) => prop_assert_eq!(failed, MAX_ATTEMPTS - 1),
            (None, None) => prop_assert!(failed == 0 || failed >= MAX_ATTEMPTS),
        }
        prop_assert_eq!(retry_delay(failed).is_some(), (1..MAX_ATTEMPTS).contains(&failed));
    }

    /// A recipient the settings or an account could name cannot add a recipient or a header.
    #[test]
    fn an_accepted_address_has_no_room_for_a_second_recipient(text in nasty()) {
        if let Ok(email) = Email::parse(&text) {
            prop_assert!(email.as_str().bytes().all(|b| b.is_ascii_graphic()));
            prop_assert!(!email.as_str().contains([',', ';', '<', '>', ' ', '\r', '\n']));
            prop_assert_eq!(email.as_str().matches('@').count(), 1);
        }
    }
}
