use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use reqwest::header::{HeaderMap, HeaderValue, REFERER, USER_AGENT};
use serde::{Deserialize, Serialize};

use crate::config::Config;

// ─── Session Persistence ──────────────────────────────────────

fn session_path(cfg: &Config) -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(format!(".os-session-{}.json", cfg.chain_id))
}

pub fn load_session(cfg: &Config) -> Option<SessionData> {
    let path = session_path(cfg);
    if !path.exists() {
        return None;
    }
    std::fs::read_to_string(&path)
        .ok()
        .and_then(|s| serde_json::from_str::<SessionData>(&s).ok())
}

pub fn save_session(cfg: &Config, session: &SessionData) {
    if let Ok(json) = serde_json::to_string_pretty(session) {
        let _ = std::fs::write(session_path(cfg), &json);
    }
}

/// Stored session data for persistence
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionData {
    pub wallet_address: String,
    pub cookie: String,
    pub expires_at: u64,
    pub created_at: u64,
}

impl SessionData {
    pub fn is_expired(&self) -> bool {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        now >= self.expires_at
    }

    pub fn time_left_secs(&self) -> i64 {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        self.expires_at as i64 - now as i64
    }
}

/// OpenSea session with auth cookie
#[derive(Debug, Clone)]
pub struct OpenSeaSession {
    pub client: reqwest::Client,
    pub cookie: String,
    pub wallet_address: String,
}

impl OpenSeaSession {
    /// Build session from saved data
    pub fn from_data(data: &SessionData) -> anyhow::Result<Self> {
        let client = build_client(&data.cookie)?;
        Ok(OpenSeaSession {
            client,
            cookie: data.cookie.clone(),
            wallet_address: data.wallet_address.clone(),
        })
    }

    /// Build session from cookie string + wallet address
    pub fn from_cookie(cfg: &Config, wallet_address: &str) -> anyhow::Result<Self> {
        let cookie = cfg.cookie_header();
        let client = build_client(&cookie)?;
        Ok(OpenSeaSession {
            client,
            cookie,
            wallet_address: wallet_address.to_string(),
        })
    }

    /// Test if the session cookie is still valid
    pub async fn validate(&self, cfg: &Config) -> Result<bool> {
        let resp = self
            .client
            .post(&cfg.graphql_endpoint)
            .header("x-graphql-operation-type", "query")
            .header("x-app-id", "os2-web")
            .json(&serde_json::json!({
                "extensions": {
                    "persistedQuery": {
                        "sha256Hash": "89371f42cf208440cb8ee43f2f83f32c52c9ce7eaf1ef2b5783ba1bca5775ea4",
                        "version": 1
                    }
                },
                "operationName": "UnreadNotificationsCountV2Query",
                "variables": {"topic": "SOCIAL"}
            }))
            .send()
            .await?;

        Ok(resp.status().is_success())
    }
}

/// Get or refresh session. If saved session exists and valid, reuse.
/// If not, try config cookie. If neither works, return error with instructions.
pub async fn get_or_refresh_session(cfg: &Config) -> Result<OpenSeaSession> {
    // Try saved session first
    if let Some(session) = load_session(cfg) {
        if !session.is_expired() {
            tracing::info!(
                "Using saved session ({}s left)",
                session.time_left_secs()
            );
            let os_session = OpenSeaSession::from_data(&session)?;

            // Quick validation
            if os_session.validate(cfg).await.unwrap_or(false) {
                return Ok(os_session);
            }
            tracing::warn!("Saved session expired on server, trying config cookie...");
        } else {
            tracing::info!("Saved session file expired, trying config cookie...");
        }
    }

    // Try cookie from config
    let cookie = cfg.cookie_header();
    if cookie.is_empty() {
        anyhow::bail!(
            "No auth cookie found!\n\n\
             To get your OpenSea cookie:\n\
             1. Open https://opensea.io in Chrome/Firefox\n\
             2. Connect your wallet and login\n\
             3. F12 → Application (Chrome) / Storage (Firefox) → Cookies → opensea.io\n\
             4. Copy the value of 'os2AccessEx'\n\
             5. Set it in ~/.os-minter.toml: auth_cookie = \"os2AccessEx=YOUR_COOKIE\"\n\
             Or run: os-minter --set-cookie \"os2AccessEx=YOUR_COOKIE\""
        );
    }

    let client = build_client(&cookie)?;
    let ws = std::env::var("WALLET_ADDRESS").unwrap_or_else(|_| "0xunknown".into());

    let session = OpenSeaSession {
        client,
        cookie: cookie.clone(),
        wallet_address: ws,
    };

    // Validate the cookie actually works
    if !session.validate(cfg).await.unwrap_or(false) {
        anyhow::bail!(
            "Cookie '{}' is invalid or expired!\n\
             Get a new one from opensea.io browser DevTools → Cookies.",
            &cookie[..40.min(cookie.len())]
        );
    }

    tracing::info!("✅ Cookie auth valid!");

    // Save session for next run
    let session_data = SessionData {
        wallet_address: session.wallet_address.clone(),
        cookie: cookie.clone(),
        expires_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
            + 86400 * 30, // Assume 30 days
        created_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    };
    save_session(cfg, &session_data);

    Ok(session)
}

fn build_client(cookie: &str) -> Result<reqwest::Client> {
    let mut headers = HeaderMap::new();
    headers.insert(
        USER_AGENT,
        HeaderValue::from_static(
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36",
        ),
    );
    headers.insert("x-app-id", HeaderValue::from_static("os2-web"));
    headers.insert("origin", HeaderValue::from_static("https://opensea.io"));
    headers.insert(REFERER, HeaderValue::from_static("https://opensea.io/"));
    headers.insert(
        "content-type",
        HeaderValue::from_static("application/json"),
    );
    headers.insert(
        "accept",
        HeaderValue::from_static(
            "application/graphql-response+json, application/graphql+json, application/json",
        ),
    );
    headers.insert("cookie", HeaderValue::from_str(cookie)?);

    let client = reqwest::Client::builder()
        .default_headers(headers)
        .build()
        .context("Failed to build HTTP client")?;

    Ok(client)
}

/// Parse wallet address from saved session or env
pub fn get_wallet_address(cfg: &Config) -> String {
    if let Some(session) = load_session(cfg) {
        return session.wallet_address;
    }
    std::env::var("WALLET_ADDRESS").unwrap_or_else(|_| "0x80516aa1a1b97f8aba8765fdf69e3ffd030599bd".into())
}

/// Save a new cookie (called from --set-cookie CLI)
pub fn save_cookie(cfg: &Config, cookie_val: &str) -> Result<()> {
    let cookie = if cookie_val.starts_with("os2AccessEx=") {
        cookie_val.to_string()
    } else {
        format!("os2AccessEx={}", cookie_val)
    };

    let ws = get_wallet_address(cfg);
    let session_data = SessionData {
        wallet_address: ws,
        cookie,
        expires_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs()
            + 86400 * 30,
        created_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs(),
    };
    save_session(cfg, &session_data);
    tracing::info!("✅ Cookie saved to {}", session_path(cfg).display());
    Ok(())
}