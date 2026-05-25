use serde::{Deserialize, Serialize};
use std::path::PathBuf;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Config {
    /// Ethereum wallet private key
    pub private_key: String,
    /// OpenSea collection slug (e.g., "the-stiffies-962977063")
    pub collection_slug: String,
    /// RPC URL for the chain
    pub rpc_url: String,
    /// Chain ID
    pub chain_id: u64,
    /// OpenSea GraphQL endpoint
    pub graphql_endpoint: String,
    /// Persisted query hash for swap/mutation (MintActionTimelineQuery)
    pub swap_query_hash: String,
    /// Persisted query hash for drop info (MintModuleQuery)
    pub drop_info_query_hash: String,
    /// Auth cookie: os2AccessEx=xxx
    pub auth_cookie: String,
    /// Gas limit for mint tx
    pub gas_limit: u64,
    /// Max priority fee (gwei)
    pub max_priority_fee_gwei: u64,
    /// Max fee per gas (gwei)
    pub max_fee_gwei: u64,
}

impl Default for Config {
    fn default() -> Self {
        Self {
            private_key: String::new(),
            collection_slug: String::new(),
            rpc_url: "https://mainnet.base.org".into(),
            chain_id: 8453,
            graphql_endpoint: "https://gql.opensea.io/graphql".into(),
            swap_query_hash: "768f258429ec0cd8ac2a5eaf46ff8614889dcfccfa44224ec3e823c958345dca".into(),
            drop_info_query_hash: "2dc7d722d0b9022240a1bb9516c6c5b4e785eec8aae29b24efa330d887390987".into(),
            auth_cookie: String::new(),
            gas_limit: 300_000,
            max_priority_fee_gwei: 2,
            max_fee_gwei: 5,
        }
    }
}

impl Config {
    pub fn load() -> anyhow::Result<Self> {
        let config_path = dirs_or_default();

        if config_path.exists() {
            let content = std::fs::read_to_string(&config_path)?;
            Ok(toml::from_str(&content)?)
        } else {
            let cfg = Config::default();
            let toml_str = toml::to_string_pretty(&cfg)?;
            std::fs::write(config_path, toml_str)?;
            println!("Created default config at ~/.os-minter.toml — edit it with your settings");
            Ok(cfg)
        }
    }

    pub fn from_args(private_key: String, collection_slug: String) -> Self {
        Self {
            private_key,
            collection_slug,
            ..Default::default()
        }
    }

    pub fn with_cookie(mut self, cookie: String) -> Self {
        self.auth_cookie = cookie;
        self
    }

    pub fn cookie_header(&self) -> String {
        if self.auth_cookie.starts_with("os2AccessEx=") {
            self.auth_cookie.clone()
        } else if !self.auth_cookie.is_empty() {
            format!("os2AccessEx={}", self.auth_cookie)
        } else {
            String::new()
        }
    }
}

fn dirs_or_default() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".into());
    PathBuf::from(home).join(".os-minter.toml")
}