//! Feeds arbitrary bytes to the CSRF check as a request: the first byte picks the method, the
//! rest is split at line feeds into `Origin`, `Sec-Fetch-Site`, `X-CSRF-Token` and a `Cookie`
//! header (an empty part is a missing header). Fails on a panic and when a request passes
//! without exactly one `Origin` equal to the app origin, with a `Sec-Fetch-Site` other than
//! `same-origin`, or with a header token that differs from the cookie token. Also checks the
//! token parser: an accepted token text is exactly its lowercase hex form.
#![no_main]

use libfuzzer_sys::fuzz_target;
use stuffcloud_core::cookie::lookup;
use stuffcloud_core::csrf::{CsrfPass, CsrfRequest, Origin, check, is_safe_method};
use stuffcloud_core::token::Token;

const METHODS: [&str; 6] = ["GET", "PUT", "POST", "DELETE", "PATCH", "get"];

fuzz_target!(|data: &[u8]| {
    let Some((&selector, rest)) = data.split_first() else {
        return;
    };
    let method = METHODS[usize::from(selector) % METHODS.len()];
    let parts: Vec<&[u8]> = rest.split(|byte| *byte == b'\n').collect();
    let header = |index: usize| -> Vec<&[u8]> {
        parts
            .get(index)
            .filter(|value| !value.is_empty())
            .map(|value| vec![*value])
            .unwrap_or_default()
    };
    let origins = header(0);
    let fetch_sites = header(1);
    let tokens = header(2);
    let cookie_header = parts.get(3).copied().unwrap_or_default();
    let app = Origin::parse(b"https://app.example.com").unwrap();
    let request = CsrfRequest {
        method,
        origins: &origins,
        fetch_sites: &fetch_sites,
        tokens: &tokens,
        cookie: lookup([cookie_header], "__Host-c"),
    };
    match check(&request, &app) {
        Ok(CsrfPass::SafeMethod) => assert!(is_safe_method(method)),
        Ok(CsrfPass::Verified(token)) => {
            assert!(!is_safe_method(method));
            assert_eq!(origins.len(), 1);
            assert_eq!(Origin::parse(origins[0]).unwrap(), app);
            assert!(fetch_sites.is_empty() || fetch_sites == [b"same-origin"]);
            assert_eq!(tokens.len(), 1);
            assert_eq!(token.to_hex().as_bytes(), tokens[0]);
            let cookie = lookup([cookie_header], "__Host-c").value().unwrap();
            assert_eq!(cookie, tokens[0]);
        }
        Err(_refused) => assert!(!is_safe_method(method)),
    }
    for candidate in &parts {
        if let Ok(token) = Token::parse(candidate) {
            assert_eq!(token.to_hex().as_bytes(), *candidate);
        }
    }
});
