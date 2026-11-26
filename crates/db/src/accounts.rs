//! Local accounts (A-03, ADR 0005 addendum "local accounts"): passwords, registration,
//! invitations and password resets.
//!
//! - A password is stored as its Argon2id PHC string in `credentials` (kind `password`, at
//!   most one per account). This crate never sees a plaintext password; `app` hashes.
//! - Invitations and reset tokens are 32 random bytes held by their recipient; the database
//!   stores their SHA-256 hash ([`crate::token_hash`]). Both are single use: the row is deleted
//!   when it is redeemed, so a token can never be redeemed twice, even by two requests at the
//!   same time (each redemption runs in one write transaction).
//! - Every change is a security event in the audit log with internal ids only (`user:<id>`
//!   as the actor, an id as the key): no login name, e-mail address, token or address.

use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use stuffcloud_core::account::{Email, Identifier, Login};
use stuffcloud_core::session::{Role, UserKind};

use crate::auth::{USER_KIND, User, actor, audit, end_all, read_user, user_from};
use crate::{Database, DbError, TokenHash};

/// Audit kind of invitation rows.
pub const INVITATION_KIND: &str = "invitation";

/// Most invitations that may be pending at once; creating more is refused, so a stolen admin
/// session cannot fill the database.
pub const MAX_PENDING_INVITATIONS: usize = 1000;

/// An account with its stored password, as the login needs it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PasswordRecord {
    /// The account.
    pub user: User,
    /// The Argon2id PHC string; `None` when the account has no password (a service account or
    /// one that only logs in through the identity provider).
    pub hash: Option<String>,
}

/// What an account shows about itself (`GET /api/v1/account`).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Profile {
    /// The account.
    pub user: User,
    /// The e-mail address.
    pub email: Option<String>,
    /// Whether the account has a password.
    pub has_password: bool,
}

/// An account to create.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct NewAccount<'a> {
    /// Login name.
    pub login: &'a Login,
    /// E-mail address.
    pub email: Option<&'a Email>,
    /// Role.
    pub role: Role,
    /// The Argon2id PHC string of the password.
    pub password_hash: &'a str,
}

/// Result of [`Database::register`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Registration {
    /// The account was created (and the invitation, if any, used up).
    Created(User),
    /// Another account has this login name.
    LoginTaken,
    /// Another account has this e-mail address.
    EmailTaken,
    /// The invitation does not exist (any more) or has expired.
    InvitationInvalid,
    /// The invitation is for another e-mail address.
    InvitationForAnotherEmail,
}

/// A pending invitation (never its token).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Invitation {
    /// Internal id (to revoke it).
    pub id: i64,
    /// The only e-mail address that may use it, if any.
    pub email: Option<String>,
    /// Unix milliseconds.
    pub created_at: i64,
    /// Unix milliseconds.
    pub expires_at: i64,
}

/// Result of [`Database::create_invitation`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum InvitationOutcome {
    /// Stored.
    Created(Invitation),
    /// [`MAX_PENDING_INVITATIONS`] are pending already.
    TooMany,
}

/// Result of [`Database::issue_password_reset`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ResetIssue {
    /// The token is stored (any older one of the account is replaced).
    Issued(User),
    /// No account has this login name.
    UnknownUser,
    /// The account is a service account, which has no password.
    ServiceAccount,
    /// The account is an admin and the link was asked for through the API: reset links for
    /// admin accounts come only from the operator's command line, so a stolen admin session
    /// cannot take over another admin account (#147).
    AdminAccount,
}

/// Result of [`Database::issue_password_reset_for_mail`]. Everything but `Issued` means that no
/// mail is sent; the caller answers all of them alike, so the answer tells nothing about which
/// accounts exist.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum MailedReset {
    /// The token is stored (any older one of the account is replaced); send it to `email`.
    Issued {
        /// The account.
        user: User,
        /// The address stored for the account, the only one a mail may go to.
        email: String,
    },
    /// No account has this login name or address.
    UnknownUser,
    /// The account is a service account, which has no password.
    ServiceAccount,
    /// The account is an admin: its links come only from the operator's command line, so a
    /// hijacked mailbox is not enough to take over an admin account.
    AdminAccount,
    /// The account has no e-mail address.
    NoAddress,
    /// The account gets no mail now, and nothing is changed: a token was issued for it less than
    /// the cool-down ago, or [`MAX_MAILED_PER_HOUR`] mails were requested for it in the last hour,
    /// or an admin's link for it is still valid (a request must not void it). Nobody can void the
    /// link in a person's inbox by asking again and again, nor flood the mailbox.
    Cooldown,
}

/// Most reset mails one account is sent in an hour (however many clients ask).
pub const MAX_MAILED_PER_HOUR: i64 = 3;

/// One hour in milliseconds.
const HOUR_MS: i64 = 3_600_000;

/// Reads an account and its password by login name or e-mail address.
fn read_record(
    conn: &Connection,
    identifier: &Identifier,
) -> Result<Option<PasswordRecord>, DbError> {
    let (column, value) = match identifier {
        Identifier::Login(login) => ("login", login.as_str()),
        Identifier::Email(email) => ("email", email.as_str()),
    };
    let sql = format!(
        "SELECT u.id, u.login, u.kind, u.role, u.created_at, c.data
         FROM users u LEFT JOIN credentials c ON c.user_id = u.id AND c.kind = 'password'
         WHERE u.{column} = ?1"
    );
    let row: Option<(i64, String, String, String, i64, Option<String>)> = conn
        .query_row(&sql, [value], |row| {
            Ok((
                row.get(0)?,
                row.get(1)?,
                row.get(2)?,
                row.get(3)?,
                row.get(4)?,
                row.get(5)?,
            ))
        })
        .optional()?;
    row.map(|(id, login, kind, role, created_at, hash)| {
        Ok(PasswordRecord {
            user: user_from(id, login, &kind, &role, created_at)?,
            hash,
        })
    })
    .transpose()
}

/// Whether a value of a `users` column is taken.
fn taken(conn: &Connection, column: &str, value: &str) -> Result<bool, DbError> {
    Ok(conn.query_row(
        &format!("SELECT EXISTS (SELECT 1 FROM users WHERE {column} = ?1)"),
        [value],
        |row| row.get(0),
    )?)
}

/// Inserts an account with its password, audited as `user.created` by `actor` (the account
/// itself when `None`).
pub(crate) fn insert_account(
    tx: &Transaction<'_>,
    account: &NewAccount<'_>,
    actor_override: Option<&str>,
    now: i64,
) -> Result<User, DbError> {
    let _rows = tx.execute(
        "INSERT INTO users (login, kind, role, email, created_at, updated_at)
         VALUES (?1, 'person', ?2, ?3, ?4, ?4)",
        params![
            account.login.as_str(),
            account.role.as_str(),
            account.email.map(Email::as_str),
            now
        ],
    )?;
    let id = tx.last_insert_rowid();
    let _rows = tx.execute(
        "INSERT INTO credentials (user_id, kind, data, created_at) VALUES (?1, 'password', ?2, ?3)",
        params![id, account.password_hash, now],
    )?;
    let own = actor(id);
    audit(
        tx,
        now,
        Some(actor_override.unwrap_or(&own)),
        "user.created",
        USER_KIND,
        &id.to_string(),
    )?;
    Ok(User {
        id,
        login: account.login.as_str().to_owned(),
        kind: UserKind::Person,
        role: account.role,
        created_at: now,
    })
}

/// The invitation of a token hash, if it is still valid at `now`.
fn valid_invitation(
    conn: &Connection,
    hash: &TokenHash,
    now: i64,
) -> Result<Option<(i64, Option<String>)>, DbError> {
    Ok(conn
        .query_row(
            "SELECT id, email FROM invitations WHERE token_hash = ?1 AND expires_at > ?2",
            params![&hash[..], now],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?)
}

/// Replaces the password of an account (or adds one).
fn store_password(conn: &Connection, user_id: i64, hash: &str, now: i64) -> Result<(), DbError> {
    let _rows = conn.execute(
        "INSERT INTO credentials (user_id, kind, data, created_at) VALUES (?1, 'password', ?2, ?3)
         ON CONFLICT (user_id) WHERE kind = 'password' DO UPDATE SET data = excluded.data,
             created_at = excluded.created_at, last_used_at = NULL",
        params![user_id, hash, now],
    )?;
    let _rows = conn.execute(
        "UPDATE users SET updated_at = ?1 WHERE id = ?2",
        params![now, user_id],
    )?;
    Ok(())
}

impl Database {
    /// The account a login form names, with its password.
    ///
    /// # Errors
    ///
    /// [`DbError::Sqlite`], [`DbError::Corrupt`] or [`DbError::Poisoned`].
    pub fn password_record(
        &self,
        identifier: &Identifier,
    ) -> Result<Option<PasswordRecord>, DbError> {
        read_record(&*self.lock()?, identifier)
    }

    /// An account by login name.
    ///
    /// # Errors
    ///
    /// [`DbError::Sqlite`], [`DbError::Corrupt`] or [`DbError::Poisoned`].
    pub fn user_by_login(&self, login: &Login) -> Result<Option<User>, DbError> {
        Ok(
            read_record(&*self.lock()?, &Identifier::Login(login.clone()))?
                .map(|record| record.user),
        )
    }

    /// What an account shows about itself.
    ///
    /// # Errors
    ///
    /// [`DbError::Sqlite`], [`DbError::Corrupt`] or [`DbError::Poisoned`].
    pub fn profile(&self, user_id: i64) -> Result<Option<Profile>, DbError> {
        let conn = self.lock()?;
        let Some(user) = read_user(&conn, user_id)? else {
            return Ok(None);
        };
        let (email, has_password): (Option<String>, bool) = conn.query_row(
            "SELECT email, EXISTS (SELECT 1 FROM credentials
                                   WHERE user_id = ?1 AND kind = 'password')
             FROM users WHERE id = ?1",
            [user_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        Ok(Some(Profile {
            user,
            email,
            has_password,
        }))
    }

    /// Registers an account (sign-up). With an invitation, the invitation must be valid at
    /// `now` (and, if it names an e-mail address, the account must have that address); it is
    /// used up in the same transaction. The invitation is checked before the login name and
    /// the address, so without a valid invitation nothing can be learnt about existing
    /// accounts.
    ///
    /// # Errors
    ///
    /// [`DbError::Sqlite`] or [`DbError::Poisoned`]; refusals are [`Registration`] values.
    pub fn register(
        &self,
        account: &NewAccount<'_>,
        invitation: Option<&TokenHash>,
        now: i64,
    ) -> Result<Registration, DbError> {
        let mut conn = self.lock()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let used = match invitation {
            None => None,
            Some(hash) => match valid_invitation(&tx, hash, now)? {
                None => return Ok(Registration::InvitationInvalid),
                Some((_id, Some(email)))
                    if Some(email.as_str()) != account.email.map(Email::as_str) =>
                {
                    return Ok(Registration::InvitationForAnotherEmail);
                }
                Some((id, _email)) => Some(id),
            },
        };
        if taken(&tx, "login", account.login.as_str())? {
            return Ok(Registration::LoginTaken);
        }
        if let Some(email) = account.email
            && taken(&tx, "email", email.as_str())?
        {
            return Ok(Registration::EmailTaken);
        }
        let created = insert_account(&tx, account, None, now)?;
        if let Some(id) = used {
            let _rows = tx.execute("DELETE FROM invitations WHERE id = ?1", [id])?;
            audit(
                &tx,
                now,
                Some(&actor(created.id)),
                "invitation.used",
                INVITATION_KIND,
                &id.to_string(),
            )?;
        }
        tx.commit()?;
        Ok(Registration::Created(created))
    }

    /// Records a successful password login: the time of use and, when the stored hash was made
    /// with other parameters than the current ones, the new hash (`rehash`).
    ///
    /// # Errors
    ///
    /// [`DbError::Sqlite`] or [`DbError::Poisoned`].
    pub fn record_password_use(
        &self,
        user_id: i64,
        rehash: Option<&str>,
        now: i64,
    ) -> Result<(), DbError> {
        let conn = self.lock()?;
        let _rows = conn.execute(
            "UPDATE credentials SET last_used_at = ?1, data = coalesce(?2, data)
             WHERE user_id = ?3 AND kind = 'password'",
            params![now, rehash, user_id],
        )?;
        Ok(())
    }

    /// Sets the password of an account, deletes its open reset token (a link issued before the
    /// change must not undo it) and ends its sessions except `keep` (the session the change was
    /// made from). Returns how many sessions ended.
    ///
    /// # Errors
    ///
    /// [`DbError::UnknownUser`], [`DbError::Sqlite`] or [`DbError::Poisoned`].
    pub fn set_password(
        &self,
        user_id: i64,
        hash: &str,
        keep: Option<i64>,
        now: i64,
    ) -> Result<usize, DbError> {
        let mut conn = self.lock()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        if read_user(&tx, user_id)?.is_none() {
            return Err(DbError::UnknownUser(user_id));
        }
        store_password(&tx, user_id, hash, now)?;
        let _resets = tx.execute("DELETE FROM password_resets WHERE user_id = ?1", [user_id])?;
        let who = actor(user_id);
        audit(
            &tx,
            now,
            Some(&who),
            "password.changed",
            USER_KIND,
            &user_id.to_string(),
        )?;
        let ended = tx.execute(
            "DELETE FROM sessions WHERE user_id = ?1 AND id IS NOT ?2",
            params![user_id, keep],
        )?;
        if ended > 0 {
            audit(
                &tx,
                now,
                Some(&who),
                "session.ended_by_password_change",
                USER_KIND,
                &user_id.to_string(),
            )?;
        }
        tx.commit()?;
        Ok(ended)
    }

    /// Stores an invitation. `actor` is the admin's internal id.
    ///
    /// # Errors
    ///
    /// [`DbError::Sqlite`] or [`DbError::Poisoned`].
    pub fn create_invitation(
        &self,
        hash: &TokenHash,
        email: Option<&Email>,
        actor_id: i64,
        expires_at: i64,
        now: i64,
    ) -> Result<InvitationOutcome, DbError> {
        let mut conn = self.lock()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let pending: i64 = tx.query_row(
            "SELECT COUNT(*) FROM invitations WHERE expires_at > ?1",
            [now],
            |row| row.get(0),
        )?;
        if usize::try_from(pending).unwrap_or(usize::MAX) >= MAX_PENDING_INVITATIONS {
            return Ok(InvitationOutcome::TooMany);
        }
        let _rows = tx.execute(
            "INSERT INTO invitations (token_hash, email, created_by, created_at, expires_at)
             VALUES (?1, ?2, ?3, ?4, ?5)",
            params![
                &hash[..],
                email.map(Email::as_str),
                actor_id,
                now,
                expires_at
            ],
        )?;
        let id = tx.last_insert_rowid();
        audit(
            &tx,
            now,
            Some(&actor(actor_id)),
            "invitation.created",
            INVITATION_KIND,
            &id.to_string(),
        )?;
        tx.commit()?;
        Ok(InvitationOutcome::Created(Invitation {
            id,
            email: email.map(|email| email.as_str().to_owned()),
            created_at: now,
            expires_at,
        }))
    }

    /// The invitations that are still valid at `now`, oldest first.
    ///
    /// # Errors
    ///
    /// [`DbError::Sqlite`] or [`DbError::Poisoned`].
    pub fn pending_invitations(&self, now: i64) -> Result<Vec<Invitation>, DbError> {
        let conn = self.lock()?;
        let mut statement = conn.prepare(
            "SELECT id, email, created_at, expires_at FROM invitations
             WHERE expires_at > ?1 ORDER BY id",
        )?;
        let rows = statement.query_map([now], |row| {
            Ok(Invitation {
                id: row.get(0)?,
                email: row.get(1)?,
                created_at: row.get(2)?,
                expires_at: row.get(3)?,
            })
        })?;
        Ok(rows.collect::<Result<_, _>>()?)
    }

    /// Revokes an invitation; `false` when there is none with this id.
    ///
    /// # Errors
    ///
    /// [`DbError::Sqlite`] or [`DbError::Poisoned`].
    pub fn revoke_invitation(&self, id: i64, actor_id: i64, now: i64) -> Result<bool, DbError> {
        let mut conn = self.lock()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let deleted = tx.execute("DELETE FROM invitations WHERE id = ?1", [id])?;
        if deleted > 0 {
            audit(
                &tx,
                now,
                Some(&actor(actor_id)),
                "invitation.revoked",
                INVITATION_KIND,
                &id.to_string(),
            )?;
        }
        tx.commit()?;
        Ok(deleted > 0)
    }

    /// Stores a password reset token for an account (replacing an older one). `actor` is the
    /// admin who asked for it, `None` for the operator's command line; only the command line
    /// may issue one for an admin account ([`ResetIssue::AdminAccount`]).
    ///
    /// # Errors
    ///
    /// [`DbError::Sqlite`], [`DbError::Corrupt`] or [`DbError::Poisoned`].
    pub fn issue_password_reset(
        &self,
        login: &Login,
        hash: &TokenHash,
        actor_id: Option<i64>,
        expires_at: i64,
        now: i64,
    ) -> Result<ResetIssue, DbError> {
        let mut conn = self.lock()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some(record) = read_record(&tx, &Identifier::Login(login.clone()))? else {
            return Ok(ResetIssue::UnknownUser);
        };
        let user = record.user;
        if user.kind != UserKind::Person {
            return Ok(ResetIssue::ServiceAccount);
        }
        if user.role == Role::Admin && actor_id.is_some() {
            return Ok(ResetIssue::AdminAccount);
        }
        let _rows = tx.execute(
            "INSERT INTO password_resets (token_hash, user_id, created_by, created_at, expires_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT (user_id) DO UPDATE SET token_hash = excluded.token_hash,
                 created_by = excluded.created_by, created_at = excluded.created_at,
                 expires_at = excluded.expires_at",
            params![&hash[..], user.id, actor_id, now, expires_at],
        )?;
        audit(
            &tx,
            now,
            actor_id.map(actor).as_deref(),
            "password.reset_issued",
            USER_KIND,
            &user.id.to_string(),
        )?;
        tx.commit()?;
        Ok(ResetIssue::Issued(user))
    }

    /// Stores a password reset token for the account a person named when they asked for a link
    /// by e-mail (self-service, A-10): `identifier` is the typed login name or address. Only a
    /// person's account that is not an admin, has an address and got no token within
    /// `cooldown_ms` gets one ([`MailedReset`]); an older token of the account is replaced. The
    /// audit row names the account by id and no actor (nobody is logged in).
    ///
    /// # Errors
    ///
    /// [`DbError::Sqlite`], [`DbError::Corrupt`] or [`DbError::Poisoned`].
    pub fn issue_password_reset_for_mail(
        &self,
        identifier: &Identifier,
        hash: &TokenHash,
        expires_at: i64,
        now: i64,
        cooldown_ms: i64,
    ) -> Result<MailedReset, DbError> {
        let mut conn = self.lock()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let Some(record) = read_record(&tx, identifier)? else {
            return Ok(MailedReset::UnknownUser);
        };
        let user = record.user;
        if user.kind != UserKind::Person {
            return Ok(MailedReset::ServiceAccount);
        }
        if user.role == Role::Admin {
            return Ok(MailedReset::AdminAccount);
        }
        let email: Option<String> =
            tx.query_row("SELECT email FROM users WHERE id = ?1", [user.id], |row| {
                row.get(0)
            })?;
        let Some(email) = email else {
            return Ok(MailedReset::NoAddress);
        };
        let recent: bool = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM password_resets WHERE user_id = ?1 AND created_at > ?2)",
            params![user.id, now.saturating_sub(cooldown_ms)],
            |row| row.get(0),
        )?;
        if recent {
            return Ok(MailedReset::Cooldown);
        }
        let admins_link: bool = tx.query_row(
            "SELECT EXISTS (SELECT 1 FROM password_resets
                            WHERE user_id = ?1 AND created_by IS NOT NULL AND expires_at > ?2)",
            params![user.id, now],
            |row| row.get(0),
        )?;
        if admins_link {
            return Ok(MailedReset::Cooldown);
        }
        let asked: i64 = tx.query_row(
            "SELECT COUNT(*) FROM audit_log
             WHERE action = 'password.reset_requested' AND kind = ?1 AND key = ?2 AND at > ?3",
            params![USER_KIND, user.id.to_string(), now.saturating_sub(HOUR_MS)],
            |row| row.get(0),
        )?;
        if asked >= MAX_MAILED_PER_HOUR {
            return Ok(MailedReset::Cooldown);
        }
        let _rows = tx.execute(
            "INSERT INTO password_resets (token_hash, user_id, created_by, created_at, expires_at)
             VALUES (?1, ?2, NULL, ?3, ?4)
             ON CONFLICT (user_id) DO UPDATE SET token_hash = excluded.token_hash,
                 created_by = NULL, created_at = excluded.created_at,
                 expires_at = excluded.expires_at",
            params![&hash[..], user.id, now, expires_at],
        )?;
        audit(
            &tx,
            now,
            None,
            "password.reset_requested",
            USER_KIND,
            &user.id.to_string(),
        )?;
        tx.commit()?;
        Ok(MailedReset::Issued { user, email })
    }

    /// The account a password reset token is for, when the token is valid at `now` (to check
    /// the new password against the account before it is redeemed).
    ///
    /// # Errors
    ///
    /// [`DbError::Sqlite`], [`DbError::Corrupt`] or [`DbError::Poisoned`].
    pub fn password_reset_target(
        &self,
        hash: &TokenHash,
        now: i64,
    ) -> Result<Option<Profile>, DbError> {
        let user_id: Option<i64> = self
            .lock()?
            .query_row(
                "SELECT user_id FROM password_resets WHERE token_hash = ?1 AND expires_at > ?2",
                params![&hash[..], now],
                |row| row.get(0),
            )
            .optional()?;
        match user_id {
            Some(id) => self.profile(id),
            None => Ok(None),
        }
    }

    /// Redeems a password reset token: when it is valid at `now`, sets the password, deletes the
    /// token and ends every session of the account. `None` when the token is unknown, used or
    /// expired.
    ///
    /// # Errors
    ///
    /// [`DbError::Sqlite`], [`DbError::Corrupt`] or [`DbError::Poisoned`].
    pub fn redeem_password_reset(
        &self,
        hash: &TokenHash,
        password_hash: &str,
        now: i64,
    ) -> Result<Option<User>, DbError> {
        let mut conn = self.lock()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let found: Option<(i64, i64)> = tx
            .query_row(
                "SELECT id, user_id FROM password_resets WHERE token_hash = ?1 AND expires_at > ?2",
                params![&hash[..], now],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let Some((id, user_id)) = found else {
            return Ok(None);
        };
        let user = read_user(&tx, user_id)?.ok_or(DbError::UnknownUser(user_id))?;
        let _rows = tx.execute("DELETE FROM password_resets WHERE id = ?1", [id])?;
        store_password(&tx, user_id, password_hash, now)?;
        let who = actor(user_id);
        audit(
            &tx,
            now,
            Some(&who),
            "password.reset",
            USER_KIND,
            &user_id.to_string(),
        )?;
        let _ended = end_all(
            &tx,
            user_id,
            Some(&who),
            "session.ended_by_password_reset",
            now,
        )?;
        tx.commit()?;
        Ok(Some(user))
    }

    /// Deletes the invitations and reset tokens that have expired at `now`; returns how many.
    ///
    /// # Errors
    ///
    /// [`DbError::Sqlite`] or [`DbError::Poisoned`].
    pub fn purge_expired_tokens(&self, now: i64) -> Result<usize, DbError> {
        let mut conn = self.lock()?;
        let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let invitations = tx.execute("DELETE FROM invitations WHERE expires_at <= ?1", [now])?;
        let resets = tx.execute("DELETE FROM password_resets WHERE expires_at <= ?1", [now])?;
        tx.commit()?;
        Ok(invitations.saturating_add(resets))
    }
}

#[cfg(test)]
#[path = "accounts_tests.rs"]
mod tests;
