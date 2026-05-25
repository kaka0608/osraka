use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::Result;
use ethers::prelude::*;
use ethers::signers::Signer;
use ethers::utils::parse_units;
use tokio::time::sleep;
use tracing::{info, warn};

use crate::auth;
use crate::auth::OpenSeaSession;
use crate::config::Config;
use crate::graphql::{self, TxSubmissionData};

pub struct MinterBot {
    pub(crate) cfg: Config,
    pub(crate) session: Option<OpenSeaSession>,
    pub(crate) wallet: LocalWallet,
}

impl MinterBot {
    pub async fn new(cfg: Config) -> Result<Self> {
        let wallet: LocalWallet = cfg.private_key.parse()?;
        Ok(Self {
            cfg,
            session: None,
            wallet,
        })
    }

    /// Initialize: authenticate with cookie (saved or config)
    pub async fn init(&mut self) -> Result<()> {
        info!("🔐 Authenticating with OpenSea (cookie)...");
        let session = auth::get_or_refresh_session(&self.cfg).await?;
        info!("✅ Authenticated as {}", session.wallet_address);
        self.session = Some(session);
        Ok(())
    }

    /// Run the full bot cycle
    pub async fn run(&mut self) -> Result<()> {
        if self.session.is_none() {
            self.init().await?;
        }

        let session = self.session.as_ref().unwrap();
        let address = self.wallet.address();
        let addr_str = format!("{:?}", address);

        // Step 1: Fetch drop info
        info!("🔍 Fetching drop info for: {}", self.cfg.collection_slug);
        match graphql::fetch_drop_info(session, &self.cfg).await {
            Ok(drop) => {
                info!("Drop slug: {:?}", drop.slug);
                if let Some(stage) = drop.stages.first() {
                    info!(
                        "Next stage: {:?} at {:?}",
                        stage.label, stage.start_time
                    );
                    if let Some(price) = &stage.price {
                        if let Some(token) = price.get("token") {
                            if let Some(unit) = token.get("unit") {
                                info!("Price: {} ETH", unit);
                            }
                        }
                        if let Some(usd) = price.get("usd") {
                            info!("Price: {} USD", usd);
                        }
                    }
                }
            }
            Err(e) => warn!("Could not fetch drop info: {}", e),
        }

        // Step 2: Pre-fetch nonce from RPC
        info!("🔄 Warm-up phase...");
        let start = Instant::now();
        let nonce = self.pre_fetch_nonce().await?;
        info!("  Nonce: {} (fetched in {:?})", nonce, start.elapsed());

        // Step 3: Fetch calldata via swap() persisted query
        info!("📡 Fetching calldata via swap() persisted query...");
        let chain = if self.cfg.chain_id == 8453 {
            "base"
        } else if self.cfg.chain_id == 1 {
            "ethereum"
        } else {
            "base"
        };

        let calldata = graphql::fetch_calldata(
            session,
            &self.cfg,
            &addr_str,
            &self.cfg.collection_slug,
            chain,
        )
        .await?;

        info!("  Target: {}", calldata.to);
        info!("  Data: {}...", &calldata.data[..40.min(calldata.data.len())]);
        info!("  Value: {}", calldata.value);

        // Step 4: Build, sign, send transaction
        info!("✍️  Signing and sending transaction...");
        let tx_hash = self.send_transaction(&calldata, nonce).await?;
        info!("✅ Transaction sent: 0x{}", hex::encode(tx_hash));

        // Step 5: Wait for confirmation
        self.wait_for_confirmation(tx_hash).await?;

        Ok(())
    }

    /// Pre-fetch the next nonce from the RPC
    async fn pre_fetch_nonce(&self) -> Result<U256> {
        let provider = Provider::<Http>::try_from(&self.cfg.rpc_url)?;
        let address = self.wallet.address();
        let nonce = provider
            .get_transaction_count(address, Some(BlockId::Number(BlockNumber::Pending)))
            .await?;
        Ok(nonce)
    }

    /// Build, sign, and broadcast the mint transaction
    async fn send_transaction(
        &self,
        calldata: &TxSubmissionData,
        nonce: U256,
    ) -> Result<[u8; 32]> {
        let provider = Arc::new(Provider::<Http>::try_from(&self.cfg.rpc_url)?);
        let from_addr = self.wallet.address();

        // Parse the hex calldata
        let data_bytes = calldata.data.trim_start_matches("0x");
        let tx_data: Bytes = hex::decode(data_bytes)
            .map_err(|e| anyhow::anyhow!("Failed to decode calldata hex: {}", e))?
            .into();

        let tx = Eip1559TransactionRequest::new()
            .from(from_addr)
            .to(calldata.to.parse::<Address>()?)
            .data(tx_data)
            .value(U256::from_dec_str(&calldata.value)?)
            .nonce(nonce)
            .chain_id(self.cfg.chain_id)
            .max_priority_fee_per_gas(parse_units(self.cfg.max_priority_fee_gwei, "gwei")?)
            .max_fee_per_gas(parse_units(self.cfg.max_fee_gwei, "gwei")?)
            .gas(self.cfg.gas_limit);

        let pending_tx = provider.send_transaction(tx, None).await?;
        Ok(pending_tx.tx_hash().0)
    }

    /// Wait for tx confirmation
    async fn wait_for_confirmation(&self, tx_hash: [u8; 32]) -> Result<()> {
        let provider = Arc::new(Provider::<Http>::try_from(&self.cfg.rpc_url)?);
        let tx_hash = TxHash::from(tx_hash);

        // Poll for receipt with timeout
        let start = Instant::now();
        let receipt = loop {
            if let Some(receipt) = provider.get_transaction_receipt(tx_hash).await? {
                break receipt;
            }
            if start.elapsed() > Duration::from_secs(120) {
                anyhow::bail!("Transaction timeout after 120s");
            }
            sleep(Duration::from_secs(2)).await;
        };

        let status = receipt
            .status
            .ok_or_else(|| anyhow::anyhow!("Receipt status not available"))?;

        if status == U64::one() {
            info!(
                "✅ Transaction confirmed in block {}",
                receipt.block_number.unwrap_or_default()
            );
            Ok(())
        } else {
            anyhow::bail!("Transaction failed with status {:?}", status)
        }
    }
}