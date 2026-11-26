//! The optional mailer (A-10, SPEC 6, ADR 0015): a bounded queue in memory, a worker that turns a
//! request for a reset link into a mail and delivers it, with retries and back-off.
//!
//! - **Optional.** The mailer works only while the settings group `smtp` exists
//!   ([`smtp_settings`]); it is read for every job and every attempt, so an admin who sets
//!   mail up (or fixes it) changes what happens to mail already waiting. Without it nothing in
//!   the app depends on mail: the handlers say so ([`crate::mail_api`]) and the admin path stays.
//! - **In memory, on purpose.** A reset mail carries a one-time token that the database stores
//!   only as a hash. A durable queue would have to keep the token (or the whole message) in
//!   clear text, so the queue holds only what the person typed: the login name or address and the
//!   language. The token is made when the job runs and lives in memory until the mail is
//!   delivered or given up; a restart drops what is waiting and the person asks again.
//! - **The request does the least.** A handler only checks that mail is set up, throttles the
//!   client and puts the job in the queue ([`Mailer::submit`]); the answer is the same for every
//!   account. Looking the account up, issuing the token and talking to the server happen here,
//!   after the answer.
//! - **Retries.** A delivery that fails in a way that may pass ([`stuffcloud_mail::SendError::is_transient`]) is
//!   tried again after 15 seconds, 1 minute, 5 minutes and 15 minutes ([`Delivery::delay`]),
//!   with the settings read again each time; a refusal for good, a message that cannot be built
//!   and the end of the schedule give the mail up. At most [`WORKERS`] mails are in flight; the
//!   queue holds [`QUEUE_CAPACITY`] more, and a full queue refuses new requests.
//! - **Nothing personal in the logs.** A line says what became of a mail (`sent`, `retry`,
//!   `failed`) with the kind of failure and the SMTP status code; never an address, a name, a
//!   token or what the server said. The counter `stuffcloud_mail_deliveries_total{result}` has
//!   the same words.
//! - **The SMTP password is a reference** to the deployment configuration
//!   ([`resolve_secret`]); #152 adds write-only values.

use std::fmt;
use std::sync::Arc;
use std::time::Duration;

use stuffcloud_core::account::{Email, Identifier};
use stuffcloud_core::mail::{Language, ResetMail, retry_delay};
use stuffcloud_core::session::MINUTE_MS;
use stuffcloud_core::smtp::{SecretRef, Smtp};
use stuffcloud_core::token::Token;
use stuffcloud_db::{MailedReset, token_hash};
use stuffcloud_mail::{Login, Outgoing, Password, Server, Transport};
use tokio::sync::{Semaphore, mpsc};
use tokio::task::JoinHandle;

use crate::accounts::RESET_TTL_MS;
use crate::config::Environment;
use crate::invitations::reset_link;
use crate::problem::Problem;
use crate::settings::KIND as SETTINGS_KIND;
use crate::state::AppState;

/// Metric label and log word: the mail was delivered to the server.
pub const RESULT_SENT: &str = "sent";
/// Metric label and log word: an attempt failed and another one is scheduled.
pub const RESULT_RETRY: &str = "retry";
/// Metric label and log word: the mail was given up.
pub const RESULT_FAILED: &str = "failed";
/// Metric label and log word: the settings group `smtp` is gone, so the mail was dropped.
pub const RESULT_NOT_CONFIGURED: &str = "not_configured";

/// How many requests may wait for a worker.
pub const QUEUE_CAPACITY: usize = 64;

/// How many mails are handled at the same time.
pub const WORKERS: usize = 4;

/// An account that got a reset token less than this ago gets no second one (5 minutes).
pub const RESET_COOLDOWN_MS: i64 = 5 * MINUTE_MS;

/// What a client is told to wait when the queue is full (one minute).
pub const QUEUE_FULL_WAIT_MS: i64 = MINUTE_MS;

/// A request for a reset link, as the queue holds it: what the person typed, nothing secret.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResetJob {
    /// The login name or address they named.
    pub identifier: Identifier,
    /// The language of the mail.
    pub language: Language,
}

/// Why a job was not queued.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Rejected {
    /// The queue is full.
    Full,
    /// There is no worker (the mailer is disabled or has stopped).
    Unavailable,
}

/// The sending side of the queue. Cheap to clone.
#[derive(Debug, Clone)]
pub struct Mailer {
    queue: Option<mpsc::Sender<ResetJob>>,
}

impl Mailer {
    /// A mailer without a worker: every job is refused as [`Rejected::Unavailable`]. For the
    /// command line and for tests that have nothing to do with mail.
    #[must_use]
    pub const fn disabled() -> Self {
        Self { queue: None }
    }

    /// A queue of `capacity` jobs and the worker that empties it.
    #[must_use]
    pub fn queue(capacity: usize) -> (Self, Worker) {
        let (sender, receiver) = mpsc::channel(capacity.max(1));
        (
            Self {
                queue: Some(sender),
            },
            Worker { receiver },
        )
    }

    /// Puts a job in the queue without waiting.
    ///
    /// # Errors
    ///
    /// [`Rejected::Full`] when the queue is full, [`Rejected::Unavailable`] without a worker.
    pub fn submit(&self, job: ResetJob) -> Result<(), Rejected> {
        match self.queue.as_ref().map(|queue| queue.try_send(job)) {
            Some(Ok(())) => Ok(()),
            Some(Err(mpsc::error::TrySendError::Full(_job))) => Err(Rejected::Full),
            Some(Err(mpsc::error::TrySendError::Closed(_))) | None => Err(Rejected::Unavailable),
        }
    }
}

/// How a delivery is made: the transport, where secret references are looked up, and the
/// schedule of retries.
#[derive(Clone)]
pub struct Delivery {
    transport: Arc<dyn Transport>,
    env: Arc<dyn Environment + Send + Sync>,
    delays: Arc<[Duration]>,
}

impl fmt::Debug for Delivery {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Delivery")
            .field("transport", &self.transport)
            .field("delays", &self.delays)
            .finish_non_exhaustive()
    }
}

impl Delivery {
    /// A delivery with the schedule of `stuffcloud_core::mail::retry_delay`.
    #[must_use]
    pub fn new(transport: Arc<dyn Transport>, env: Arc<dyn Environment + Send + Sync>) -> Self {
        let delays: Vec<Duration> = (1..).map_while(retry_delay).collect();
        Self::with_delays(transport, env, delays)
    }

    /// A delivery with the waits `delays` between its attempts (one more attempt than waits).
    #[must_use]
    pub fn with_delays(
        transport: Arc<dyn Transport>,
        env: Arc<dyn Environment + Send + Sync>,
        delays: Vec<Duration>,
    ) -> Self {
        Self {
            transport,
            env,
            delays: delays.into(),
        }
    }

    /// The wait after `failed` failed attempts; `None` when the mail has had its last one.
    #[must_use]
    pub fn delay(&self, failed: usize) -> Option<Duration> {
        failed
            .checked_sub(1)
            .and_then(|index| self.delays.get(index))
            .copied()
    }
}

/// The receiving side of the queue.
#[derive(Debug)]
pub struct Worker {
    receiver: mpsc::Receiver<ResetJob>,
}

impl Worker {
    /// Handles the jobs of the queue until every [`Mailer`] is gone, [`WORKERS`] at a time.
    #[must_use]
    pub fn spawn(self, state: AppState, delivery: Delivery) -> JoinHandle<()> {
        tokio::spawn(async move {
            let mut receiver = self.receiver;
            let slots = Arc::new(Semaphore::new(WORKERS));
            while let Some(job) = receiver.recv().await {
                let Ok(slot) = Arc::clone(&slots).acquire_owned().await else {
                    return;
                };
                let state = state.clone();
                let delivery = delivery.clone();
                let _task = tokio::spawn(async move {
                    handle(&state, &delivery, job).await;
                    drop(slot);
                });
            }
        })
    }
}

/// The settings group `smtp`, `None` when it was never written (or was deleted).
///
/// # Errors
///
/// An internal problem when the database fails or holds a broken document.
pub async fn smtp_settings(state: &AppState) -> Result<Option<Smtp>, Problem> {
    let stored = state.db(|db| db.get(SETTINGS_KIND, Smtp::GROUP)).await?;
    stored
        .map(|stored| serde_json::from_str::<Smtp>(&stored.body))
        .transpose()
        .map_err(|error| Problem::internal(&error))
}

/// Why a secret reference gives no secret. The text names the variable, never a value.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SecretError {
    /// Neither the variable nor its `_FILE` form is set.
    NotSet(String),
    /// Both are set.
    Both(String),
    /// The `_FILE` variable names a file that cannot be read.
    Unreadable(String),
    /// The variable or the file is empty.
    Empty(String),
}

impl fmt::Display for SecretError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotSet(name) => {
                write!(f, "the secret {name} is not set (nor {name}_FILE)")
            }
            Self::Both(name) => write!(f, "set either {name} or {name}_FILE, not both"),
            Self::Unreadable(name) => write!(f, "the file named by {name}_FILE cannot be read"),
            Self::Empty(name) => write!(f, "the secret {name} is empty"),
        }
    }
}

impl std::error::Error for SecretError {}

/// The secret a reference names: the variable, or the contents of the file the `_FILE` variable
/// names (one trailing line break removed). The reference was checked when the settings were
/// written (`SecretRef::check`), so it names no other variable than a `STUFFCLOUD_SECRET_` one.
///
/// # Errors
///
/// [`SecretError`] when nothing, both or an unreadable or empty source is found.
pub fn resolve_secret(
    env: &dyn Environment,
    reference: &SecretRef,
) -> Result<Password, SecretError> {
    let name = &reference.name;
    let value = env.var(name).filter(|value| !value.is_empty());
    let path = env
        .var(&reference.file_variable())
        .filter(|path| !path.is_empty());
    let text = match (value, path) {
        (Some(_), Some(_)) => return Err(SecretError::Both(name.clone())),
        (None, None) => return Err(SecretError::NotSet(name.clone())),
        (Some(value), None) => value,
        (None, Some(path)) => {
            let contents = env
                .read_file(&path)
                .map_err(|_unreadable| SecretError::Unreadable(name.clone()))?;
            contents
                .strip_suffix("\r\n")
                .or_else(|| contents.strip_suffix('\n'))
                .unwrap_or(&contents)
                .to_owned()
        }
    };
    if text.is_empty() {
        Err(SecretError::Empty(name.clone()))
    } else {
        Ok(Password::new(text))
    }
}

/// Where and how to send, from the settings and the secret they refer to.
///
/// # Errors
///
/// [`SecretError`] when the password reference gives no secret.
pub fn server_of(smtp: &Smtp, env: &dyn Environment) -> Result<Server, SecretError> {
    let login = match (&smtp.username, &smtp.password) {
        (Some(username), Some(reference)) => Some(Login {
            username: username.clone(),
            password: resolve_secret(env, reference)?,
        }),
        _ => None,
    };
    Ok(Server {
        host: smtp.host.clone(),
        port: smtp.port,
        security: smtp.security,
        login,
    })
}

/// A mail that is ready except for the sender, which is read from the settings at every attempt.
struct Prepared {
    to: Email,
    subject: String,
    text: String,
    message_id: String,
}

/// How an attempt ended.
#[derive(Debug, PartialEq, Eq)]
enum Attempt {
    Sent,
    NotConfigured,
    Failed { transient: bool, reason: String },
}

fn failed(transient: bool, reason: impl fmt::Display) -> Attempt {
    Attempt::Failed {
        transient,
        reason: reason.to_string(),
    }
}

async fn attempt(state: &AppState, delivery: &Delivery, prepared: &Prepared) -> Attempt {
    let smtp = match smtp_settings(state).await {
        Ok(Some(smtp)) => smtp,
        Ok(None) => return Attempt::NotConfigured,
        Err(_problem) => return failed(true, "the SMTP settings could not be read"),
    };
    let server = match server_of(&smtp, &*delivery.env) {
        Ok(server) => server,
        Err(error) => return failed(true, error),
    };
    let Some(from) = smtp.from_address() else {
        return failed(false, "the stored sender address is not valid");
    };
    let outgoing = Outgoing {
        from_name: smtp.from_name.clone(),
        from,
        to: prepared.to.clone(),
        subject: prepared.subject.clone(),
        text: prepared.text.clone(),
        message_id: prepared.message_id.clone(),
    };
    match delivery.transport.send(&server, &outgoing).await {
        Ok(()) => Attempt::Sent,
        Err(error) => failed(error.is_transient(), error),
    }
}

/// Delivers a prepared mail, with the schedule of `delivery`.
async fn deliver(state: &AppState, delivery: &Delivery, prepared: &Prepared) {
    let mut failures = 0_usize;
    loop {
        match attempt(state, delivery, prepared).await {
            Attempt::Sent => {
                state.metrics().record_mail(RESULT_SENT);
                tracing::info!(target: "stuffcloud::mail", result = RESULT_SENT, "mail delivered to the SMTP server");
                return;
            }
            Attempt::NotConfigured => {
                state.metrics().record_mail(RESULT_NOT_CONFIGURED);
                tracing::warn!(target: "stuffcloud::mail", result = RESULT_NOT_CONFIGURED, "mail dropped: the smtp settings were removed");
                return;
            }
            Attempt::Failed { transient, reason } => {
                failures = failures.saturating_add(1);
                if let Some(wait) = delivery.delay(failures).filter(|_wait| transient) {
                    state.metrics().record_mail(RESULT_RETRY);
                    tracing::warn!(
                        target: "stuffcloud::mail",
                        result = RESULT_RETRY,
                        attempt = failures,
                        wait_secs = wait.as_secs(),
                        %reason,
                        "mail not delivered, trying again"
                    );
                    tokio::time::sleep(wait).await;
                } else {
                    state.metrics().record_mail(RESULT_FAILED);
                    tracing::error!(
                        target: "stuffcloud::mail",
                        result = RESULT_FAILED,
                        attempt = failures,
                        %reason,
                        "mail given up"
                    );
                    return;
                }
            }
        }
    }
}

/// Everything that happens to one request for a reset link after the answer: the lookup, the
/// token, the text and the delivery. Anything but a mail to send ends quietly (the request was
/// answered like every other one).
async fn handle(state: &AppState, delivery: &Delivery, job: ResetJob) {
    let smtp = match smtp_settings(state).await {
        Ok(Some(smtp)) => smtp,
        Ok(None) => {
            state.metrics().record_mail(RESULT_NOT_CONFIGURED);
            return;
        }
        Err(_problem) => return,
    };
    let mut bytes = [0_u8; stuffcloud_core::token::TOKEN_BYTES];
    let mut id = [0_u8; stuffcloud_core::token::TOKEN_BYTES];
    if let Err(error) = getrandom::fill(&mut bytes).and_then(|()| getrandom::fill(&mut id)) {
        tracing::error!(target: "stuffcloud::mail", %error, "no random bytes for a reset token");
        return;
    }
    let token = Token::from_bytes(bytes);
    let hash = token_hash(&token);
    let now = state.now_millis();
    let expires_at = now.saturating_add(RESET_TTL_MS);
    let issued = state
        .db(move |db| {
            db.issue_password_reset_for_mail(
                &job.identifier,
                &hash,
                expires_at,
                now,
                RESET_COOLDOWN_MS,
            )
        })
        .await;
    let Ok(MailedReset::Issued {
        user,
        email: address,
    }) = issued
    else {
        return;
    };
    let Ok(to) = Email::parse(&address) else {
        tracing::error!(target: "stuffcloud::mail", "a stored e-mail address is not valid");
        return;
    };
    let app = state.auth().app_origin.to_string();
    let link = reset_link(&state.auth().app_origin, &token);
    let rendered = ResetMail {
        language: job.language,
        app: &app,
        login: &user.login,
        link: &link,
        valid_minutes: RESET_TTL_MS / MINUTE_MS,
    }
    .render();
    // The `Message-ID` is in the domain of the sender, never in the name of the host the app
    // runs on. (A sender that is not valid fails the delivery for good.)
    let domain = smtp
        .from_address()
        .and_then(|from| from.as_str().rsplit('@').next().map(str::to_owned))
        .unwrap_or_else(|| "localhost.invalid".to_owned());
    let prepared = Prepared {
        to,
        subject: rendered.subject,
        text: rendered.text,
        message_id: format!("<{}@{domain}>", Token::from_bytes(id).to_hex()),
    };
    deliver(state, delivery, &prepared).await;
}

#[cfg(test)]
mod tests {
    use std::io::Write as _;
    use std::sync::Mutex;

    use stuffcloud_core::account::Login;
    use stuffcloud_core::body::canonical;
    use stuffcloud_core::session::Role;
    use stuffcloud_core::smtp::SmtpSecurity;
    use stuffcloud_db::NewAccount;
    use stuffcloud_db::store::{Preconditions, WriteContext};
    use stuffcloud_mail::{FailureKind, Recording, SendError};
    use tracing_subscriber::fmt::MakeWriter;

    use super::*;
    use crate::config::MapEnvironment;
    use crate::state::tests::{accounts, state_with_mailer};

    const PASSWORD: &str = "unit-test-smtp-password";

    fn reference() -> SecretRef {
        SecretRef {
            name: "STUFFCLOUD_SECRET_SMTP".to_owned(),
        }
    }

    fn smtp() -> Smtp {
        Smtp {
            host: "smtp.example.com".to_owned(),
            port: 587,
            security: SmtpSecurity::Starttls,
            username: Some("stuffcloud".to_owned()),
            password: Some(reference()),
            from: "noreply@example.com".to_owned(),
            from_name: Some("stuffcloud".to_owned()),
        }
    }

    fn write_context(now: i64) -> WriteContext {
        WriteContext {
            now,
            actor: None,
            dry_run: false,
        }
    }

    fn store(state: &AppState, smtp: &Smtp) {
        let _written = state
            .database()
            .put(
                SETTINGS_KIND,
                Smtp::GROUP,
                &canonical(smtp),
                &Preconditions::default(),
                &write_context(0),
            )
            .unwrap();
    }

    fn env() -> Arc<MapEnvironment> {
        Arc::new(MapEnvironment::default().with("STUFFCLOUD_SECRET_SMTP", PASSWORD))
    }

    /// A state with a working mailer that delivers to `recording`, retrying after 5 ms (twice).
    fn state_with_recording(recording: &Recording) -> AppState {
        state_with_delays(recording, vec![Duration::from_millis(5); 2])
    }

    fn state_with_delays(recording: &Recording, delays: Vec<Duration>) -> AppState {
        let (mailer, worker) = Mailer::queue(8);
        let state = state_with_mailer(accounts(), mailer);
        let _worker = worker.spawn(
            state.clone(),
            Delivery::with_delays(Arc::new(recording.clone()), env(), delays),
        );
        state
    }

    fn alice(state: &AppState) {
        let login = Login::parse("alice").unwrap();
        let email = Email::parse("alice@example.org").unwrap();
        let _created = state
            .database()
            .register(
                &NewAccount {
                    login: &login,
                    email: Some(&email),
                    role: Role::User,
                    password_hash: "phc",
                },
                None,
                1,
            )
            .unwrap();
    }

    fn job(who: &str, language: Language) -> ResetJob {
        ResetJob {
            identifier: Identifier::from_input(who).unwrap(),
            language,
        }
    }

    /// Waits until `done` holds (at most two seconds).
    async fn until(mut done: impl FnMut() -> bool) {
        for _ in 0..400 {
            if done() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        panic!("the condition never held");
    }

    #[derive(Clone, Default)]
    struct Log(Arc<Mutex<Vec<u8>>>);

    impl std::io::Write for Log {
        fn write(&mut self, data: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(data);
            Ok(data.len())
        }

        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl<'w> MakeWriter<'w> for Log {
        type Writer = Self;

        fn make_writer(&'w self) -> Self::Writer {
            self.clone()
        }
    }

    impl Log {
        fn text(&self) -> String {
            String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
        }
    }

    fn capture() -> (Log, tracing::subscriber::DefaultGuard) {
        let log = Log::default();
        let guard = tracing::subscriber::set_default(crate::telemetry::subscriber(
            crate::config::LogLevel::Debug,
            crate::config::LogFormat::Text,
            log.clone(),
        ));
        (log, guard)
    }

    fn metrics_of(state: &AppState) -> String {
        state.metrics().render().unwrap()
    }

    fn counter(result: &str, count: u32) -> String {
        format!("stuffcloud_mail_deliveries_total{{result=\"{result}\"}} {count}")
    }

    #[test]
    fn secrets_come_from_the_variable_or_its_file() {
        let name = reference();
        let from_var = MapEnvironment::default().with("STUFFCLOUD_SECRET_SMTP", "s3cret");
        assert_eq!(resolve_secret(&from_var, &name).unwrap().expose(), "s3cret");
        let from_file = MapEnvironment::default()
            .with("STUFFCLOUD_SECRET_SMTP_FILE", "/run/secrets/smtp")
            .with_file("/run/secrets/smtp", "from a file\n");
        assert_eq!(
            resolve_secret(&from_file, &name).unwrap().expose(),
            "from a file"
        );
        // One line break goes (two characters of it on Windows); nothing else is trimmed.
        for (contents, expected) in [
            ("a\r\n", "a"),
            ("a\n\n", "a\n"),
            (" a b ", " a b "),
            ("a", "a"),
        ] {
            let env = MapEnvironment::default()
                .with("STUFFCLOUD_SECRET_SMTP_FILE", "/f")
                .with_file("/f", contents);
            assert_eq!(resolve_secret(&env, &name).unwrap().expose(), expected);
        }
    }

    #[test]
    fn a_secret_that_is_missing_doubled_or_empty_is_an_error_naming_the_variable() {
        let name = reference();
        let error = resolve_secret(&MapEnvironment::default(), &name).unwrap_err();
        assert_eq!(
            error,
            SecretError::NotSet("STUFFCLOUD_SECRET_SMTP".to_owned())
        );
        assert_eq!(
            error.to_string(),
            "the secret STUFFCLOUD_SECRET_SMTP is not set (nor STUFFCLOUD_SECRET_SMTP_FILE)"
        );
        let both = MapEnvironment::default()
            .with("STUFFCLOUD_SECRET_SMTP", "x")
            .with("STUFFCLOUD_SECRET_SMTP_FILE", "/f")
            .with_file("/f", "y");
        let error = resolve_secret(&both, &name).unwrap_err();
        assert_eq!(
            error.to_string(),
            "set either STUFFCLOUD_SECRET_SMTP or STUFFCLOUD_SECRET_SMTP_FILE, not both"
        );
        let missing_file = MapEnvironment::default().with("STUFFCLOUD_SECRET_SMTP_FILE", "/nope");
        let error = resolve_secret(&missing_file, &name).unwrap_err();
        assert_eq!(
            error.to_string(),
            "the file named by STUFFCLOUD_SECRET_SMTP_FILE cannot be read"
        );
        assert!(!error.to_string().contains("/nope"));
        for contents in ["", "\n"] {
            let env = MapEnvironment::default()
                .with("STUFFCLOUD_SECRET_SMTP_FILE", "/e")
                .with_file("/e", contents);
            let error = resolve_secret(&env, &name).unwrap_err();
            assert_eq!(
                error,
                SecretError::Empty("STUFFCLOUD_SECRET_SMTP".to_owned())
            );
            assert_eq!(
                error.to_string(),
                "the secret STUFFCLOUD_SECRET_SMTP is empty"
            );
        }
        // An empty variable counts as unset, like in the configuration.
        let empty = MapEnvironment::default().with("STUFFCLOUD_SECRET_SMTP", "");
        assert!(matches!(
            resolve_secret(&empty, &name),
            Err(SecretError::NotSet(_))
        ));
        let empty_file_name = MapEnvironment::default().with("STUFFCLOUD_SECRET_SMTP_FILE", "");
        assert!(matches!(
            resolve_secret(&empty_file_name, &name),
            Err(SecretError::NotSet(_))
        ));
    }

    #[test]
    fn the_server_has_a_login_only_with_a_username_and_a_password() {
        let env = MapEnvironment::default().with("STUFFCLOUD_SECRET_SMTP", PASSWORD);
        let server = server_of(&smtp(), &env).unwrap();
        assert_eq!(server.host, "smtp.example.com");
        assert_eq!(server.port, 587);
        assert_eq!(server.security, SmtpSecurity::Starttls);
        let login = server.login.unwrap();
        assert_eq!(login.username, "stuffcloud");
        assert_eq!(login.password.expose(), PASSWORD);
        let mut open = smtp();
        open.username = None;
        open.password = None;
        open.security = SmtpSecurity::None;
        assert_eq!(
            server_of(&open, &MapEnvironment::default()).unwrap().login,
            None
        );
        assert!(server_of(&smtp(), &MapEnvironment::default()).is_err());
    }

    #[test]
    fn the_schedule_is_the_one_of_the_core() {
        let delivery = Delivery::new(Arc::new(Recording::new()), env());
        let waits: Vec<Option<u64>> = (0..7)
            .map(|failed| delivery.delay(failed).map(|wait| wait.as_secs()))
            .collect();
        assert_eq!(
            waits,
            [None, Some(15), Some(60), Some(300), Some(900), None, None]
        );
        let short = Delivery::with_delays(
            Arc::new(Recording::new()),
            env(),
            vec![Duration::from_millis(7)],
        );
        assert_eq!(short.delay(1), Some(Duration::from_millis(7)));
        assert_eq!(short.delay(2), None);
        assert!(format!("{short:?}").contains("Delivery"));
    }

    #[tokio::test]
    async fn the_queue_takes_what_fits_and_says_why_it_refuses() {
        let job = || job("alice", Language::En);
        assert_eq!(Mailer::disabled().submit(job()), Err(Rejected::Unavailable));
        let (mailer, worker) = Mailer::queue(1);
        assert_eq!(mailer.submit(job()), Ok(()));
        assert_eq!(mailer.clone().submit(job()), Err(Rejected::Full));
        drop(worker);
        assert_eq!(mailer.submit(job()), Err(Rejected::Unavailable));
        // A queue never has room for zero jobs.
        let (mailer, _worker) = Mailer::queue(0);
        assert_eq!(mailer.submit(job()), Ok(()));
    }

    #[tokio::test]
    async fn the_settings_are_read_as_stored() {
        let state = state_with_mailer(accounts(), Mailer::disabled());
        assert_eq!(smtp_settings(&state).await.unwrap(), None);
        store(&state, &smtp());
        assert_eq!(smtp_settings(&state).await.unwrap(), Some(smtp()));
        let _broken = state
            .database()
            .put(
                SETTINGS_KIND,
                Smtp::GROUP,
                "{not json",
                &Preconditions::default(),
                &write_context(1),
            )
            .unwrap();
        assert_eq!(
            smtp_settings(&state).await.unwrap_err().kind(),
            crate::problem::ProblemKind::Internal
        );
    }

    #[tokio::test]
    async fn a_request_becomes_a_mail_without_a_trace_in_the_log() {
        let (log, _guard) = capture();
        let recording = Recording::new();
        let state = state_with_recording(&recording);
        store(&state, &smtp());
        alice(&state);
        assert_eq!(
            state
                .mailer()
                .submit(job("Alice@Example.org", Language::De)),
            Ok(())
        );
        until(|| recording.sent().len() == 1).await;
        let mail = recording.sent().remove(0);
        assert_eq!(mail.to.as_str(), "alice@example.org");
        assert_eq!(mail.from.as_str(), "noreply@example.com");
        assert_eq!(mail.from_name.as_deref(), Some("stuffcloud"));
        assert_eq!(mail.subject, "stuffcloud: Passwort zur\u{fc}cksetzen");
        assert!(mail.text.starts_with("Hallo alice,"), "{}", mail.text);
        assert!(mail.text.contains("https://app.example.com"));
        // 64 hex characters of random in the sender's domain, not derived from the token.
        assert!(mail.message_id.starts_with('<') && mail.message_id.ends_with("@example.com>"));
        assert_eq!(mail.message_id.len(), 1 + 64 + "@example.com>".len());
        let server = recording.servers().remove(0);
        assert_eq!(server.login.unwrap().password.expose(), PASSWORD);
        let (_, token) = mail.text.split_once("#token=").unwrap();
        let token = token.lines().next().unwrap();
        assert_eq!(token.len(), 64);
        assert!(!mail.message_id.contains(token));
        let text = log.text();
        assert!(text.contains("mail delivered"), "{text}");
        for fragment in [
            "alice",
            "example.org",
            token,
            PASSWORD,
            "password-reset",
            "noreply",
            "smtp.example.com",
        ] {
            assert!(!text.contains(fragment), "{fragment} in {text}");
        }
        assert!(metrics_of(&state).contains(&counter("sent", 1)));
    }

    #[tokio::test]
    async fn a_transient_failure_is_retried_and_the_log_names_no_one() {
        let (log, _guard) = capture();
        let recording = Recording::new();
        let state = state_with_recording(&recording);
        store(&state, &smtp());
        alice(&state);
        // Two failures, then it goes through (the schedule allows three attempts here).
        recording.fail_next(SendError::new(FailureKind::Connection));
        recording.fail_next(SendError::answered(FailureKind::Deferred, 451));
        state.mailer().submit(job("alice", Language::En)).unwrap();
        until(|| recording.sent().len() == 1).await;
        assert_eq!(recording.attempts(), 3);
        let metrics = metrics_of(&state);
        assert!(metrics.contains(&counter("retry", 2)), "{metrics}");
        assert!(metrics.contains(&counter("sent", 1)), "{metrics}");
        let text = log.text();
        assert!(text.contains("trying again"), "{text}");
        assert!(text.contains("SMTP 451"), "{text}");
        assert!(
            !text.contains("alice") && !text.contains("example.org"),
            "{text}"
        );
    }

    #[tokio::test]
    async fn a_rejection_is_final_at_once() {
        let (log, _guard) = capture();
        let recording = Recording::new();
        let state = state_with_recording(&recording);
        store(&state, &smtp());
        alice(&state);
        recording.fail_next(SendError::answered(FailureKind::Rejected, 550));
        state.mailer().submit(job("alice", Language::En)).unwrap();
        until(|| metrics_of(&state).contains(&counter("failed", 1))).await;
        assert_eq!(recording.attempts(), 1);
        assert!(recording.sent().is_empty());
        let text = log.text();
        assert!(text.contains("mail given up"), "{text}");
        assert!(text.contains("SMTP 550"), "{text}");
        assert!(!metrics_of(&state).contains("result=\"retry\""));
    }

    #[tokio::test]
    async fn a_schedule_that_runs_out_ends_the_mail() {
        let recording = Recording::new();
        let state = state_with_recording(&recording);
        store(&state, &smtp());
        alice(&state);
        // Three failures in a row exhaust a schedule of two waits.
        for _ in 0..3 {
            recording.fail_next(SendError::new(FailureKind::Timeout));
        }
        state.mailer().submit(job("alice", Language::En)).unwrap();
        until(|| metrics_of(&state).contains(&counter("failed", 1))).await;
        assert_eq!(recording.attempts(), 3);
        assert!(recording.sent().is_empty());
        assert!(metrics_of(&state).contains(&counter("retry", 2)));
    }

    #[tokio::test]
    async fn without_settings_nothing_is_sent_and_no_token_is_issued() {
        let recording = Recording::new();
        let state = state_with_recording(&recording);
        alice(&state);
        state.mailer().submit(job("alice", Language::En)).unwrap();
        until(|| metrics_of(&state).contains(&counter("not_configured", 1))).await;
        assert_eq!(recording.attempts(), 0);
        // No token was made for the account: it is not in its cool-down.
        let issued = state
            .database()
            .issue_password_reset_for_mail(
                &Identifier::from_input("alice").unwrap(),
                &token_hash(&Token::from_bytes([1; 32])),
                10,
                2,
                RESET_COOLDOWN_MS,
            )
            .unwrap();
        assert!(matches!(issued, MailedReset::Issued { .. }));
    }

    #[tokio::test]
    async fn settings_that_vanish_between_attempts_drop_the_mail() {
        let recording = Recording::new();
        let state = state_with_delays(&recording, vec![Duration::from_millis(300)]);
        store(&state, &smtp());
        alice(&state);
        // The first attempt fails; the settings are removed while the mail waits for the second.
        recording.fail_next(SendError::new(FailureKind::Connection));
        state.mailer().submit(job("alice", Language::En)).unwrap();
        until(|| recording.attempts() == 1).await;
        let _deleted = state
            .database()
            .delete(
                SETTINGS_KIND,
                Smtp::GROUP,
                &Preconditions::default(),
                &write_context(5),
            )
            .unwrap();
        until(|| metrics_of(&state).contains("result=\"not_configured\"")).await;
        assert!(recording.sent().is_empty());
    }

    #[tokio::test]
    async fn a_missing_secret_fails_the_attempt_and_the_transport_is_never_asked() {
        let recording = Recording::new();
        let (mailer, worker) = Mailer::queue(8);
        let state = state_with_mailer(accounts(), mailer);
        let _worker = worker.spawn(
            state.clone(),
            Delivery::with_delays(
                Arc::new(recording.clone()),
                Arc::new(MapEnvironment::default()),
                vec![Duration::from_millis(5)],
            ),
        );
        store(&state, &smtp());
        alice(&state);
        state.mailer().submit(job("alice", Language::En)).unwrap();
        until(|| metrics_of(&state).contains(&counter("failed", 1))).await;
        assert!(metrics_of(&state).contains(&counter("retry", 1)));
        assert_eq!(recording.attempts(), 0);
    }

    #[tokio::test]
    async fn a_stored_sender_that_is_not_valid_fails_for_good() {
        let recording = Recording::new();
        let state = state_with_recording(&recording);
        let mut broken = smtp();
        broken.from = "not an address".to_owned();
        // Stored behind the validation (a document from an older version, or a damaged one).
        store(&state, &broken);
        alice(&state);
        state.mailer().submit(job("alice", Language::En)).unwrap();
        until(|| metrics_of(&state).contains(&counter("failed", 1))).await;
        assert_eq!(recording.attempts(), 0);
        assert!(!metrics_of(&state).contains("result=\"retry\""));
    }

    #[test]
    fn the_documented_numbers_hold() {
        assert_eq!(QUEUE_CAPACITY, 64);
        assert_eq!(WORKERS, 4);
        assert_eq!(RESET_COOLDOWN_MS, 300_000);
        assert_eq!(QUEUE_FULL_WAIT_MS, 60_000);
        assert_eq!(
            [
                RESULT_SENT,
                RESULT_RETRY,
                RESULT_FAILED,
                RESULT_NOT_CONFIGURED
            ],
            ["sent", "retry", "failed", "not_configured"]
        );
        let mut sink = Log::default();
        sink.flush().unwrap();
    }
}
