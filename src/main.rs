mod auth;
mod bot;
pub(crate) mod config;
mod graphql;

use clap::Parser;
use ethers::signers::Signer;
use tracing_subscriber::EnvFilter;

#[derive(Parser, Debug)]
#[command(name = "os-minter", about = "OpenSea FCFS NFT Minter Bot")]
struct Args {
    /// Private key for the minting wallet
    #[arg(short, long)]
    private_key: Option<String>,

    /// OpenSea collection slug (e.g., "cool-cats-nft")
    #[arg(short, long)]
    collection: Option<String>,

    /// Just test cookie auth (no mint)
    #[arg(long)]
    test_auth: bool,

    /// Just test calldata fetch (no mint)
    #[arg(long)]
    test_calldata: bool,

    /// RPC URL (default: Base mainnet)
    #[arg(long, default_value = "https://mainnet.base.org")]
    rpc: String,

    /// Chain ID (default: 8453 = Base)
    #[arg(long, default_value_t = 8453)]
    chain_id: u64,

    /// Set OpenSea auth cookie (os2AccessEx=xxx) and save to session file
    #[arg(long)]
    set_cookie: Option<String>,

    /// Drop info only — check mint timing & price
    #[arg(long)]
    check_drop: bool,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let args = Args::parse();

    // --set-cookie mode: save cookie and exit
    if let Some(cookie_val) = &args.set_cookie {
        let cfg = config::Config::load().unwrap_or_default();
        auth::save_cookie(&cfg, cookie_val)?;
        println!("✅ Cookie saved! You can now run: os-minter --collection <slug>");
        return Ok(());
    }

    // --check-drop mode: just check timing
    if args.check_drop {
        let cfg = config::Config::load().unwrap_or_default();
        let mut checker = bot::MinterBot::new(cfg).await?;
        checker.init().await?;
        let session = checker.session.as_ref().unwrap();
        let drop = graphql::fetch_drop_info(session, &checker.get_config()).await?;
        println!("Drop slug: {:?}", drop.slug);
        for stage in &drop.stages {
            println!(
                "  Stage {} ({:?}): {:?} — price: {:?} ETH",
                stage.stage_index.unwrap_or(99),
                stage.label,
                stage.start_time,
                stage
                    .price
                    .as_ref()
                    .and_then(|p| p.get("token"))
                    .and_then(|t| t.get("unit"))
                    .and_then(|u| u.as_f64())
                    .unwrap_or(-1.0)
            );
        }
        return Ok(());
    }

    // Validate required args for minting
    let private_key = args
        .private_key
        .or_else(|| std::env::var("PRIVATE_KEY").ok())
        .ok_or_else(|| {
            anyhow::anyhow!(
                "Private key required! Pass --private-key or set PRIVATE_KEY env var"
            )
        })?;

    let collection = args.collection.ok_or_else(|| {
        anyhow::anyhow!("Collection slug required! Pass --collection <slug>")
    })?;

    let cfg = config::Config::from_args(private_key, collection);

    let mut minter = bot::MinterBot::new(cfg).await?;

    if args.test_auth {
        tracing::info!("🧪 Testing cookie authentication...");
        minter.init().await?;
        tracing::info!("✅ Auth successful!");
        return Ok(());
    }

    if args.test_calldata {
        tracing::info!("🧪 Testing calldata fetch...");
        minter.init().await?;

        let address = minter.get_wallet_address();
        let chain = if args.chain_id == 8453 {
            "base"
        } else if args.chain_id == 1 {
            "ethereum"
        } else {
            "base"
        };

        let session = minter.session.as_ref().unwrap();
        let calldata = graphql::fetch_calldata(
            session,
            &minter.get_config(),
            &address,
            &minter.get_config().collection_slug,
            chain,
        )
        .await?;
        tracing::info!("✅ Calldata:");
        tracing::info!("   to: {}", calldata.to);
        tracing::info!("   data: {}...", &calldata.data[..40.min(calldata.data.len())]);
        tracing::info!("   value: {}", calldata.value);
        return Ok(());
    }

    // Full run
    tracing::info!("🚀 Starting OpenSea FCFS Minter Bot");
    tracing::info!("   Wallet: {:?}", minter.get_wallet_address());
    tracing::info!("   Collection: {}", minter.get_config().collection_slug);
    minter.run().await?;

    Ok(())
}

// Helper to expose config for test commands
impl bot::MinterBot {
    fn get_config(&self) -> config::Config {
        self.cfg.clone()
    }

    fn get_wallet_address(&self) -> String {
        format!("{:?}", self.wallet.address())
    }
}