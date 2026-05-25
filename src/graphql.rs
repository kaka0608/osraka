use serde_json::json;

use crate::auth::OpenSeaSession;
use crate::config::Config;

/// Response from the swap() mutation
#[derive(Debug, serde::Deserialize)]
#[allow(dead_code)]
pub struct SwapResponseData {
    pub actions: Vec<SwapAction>,
    pub errors: Vec<GraphQLError>,
    #[serde(rename = "__typename")]
    pub typename: String,
}

#[derive(Debug, serde::Deserialize)]
#[allow(dead_code)]
pub struct SwapAction {
    #[serde(rename = "__typename")]
    pub typename: String,
    #[serde(rename = "transactionSubmissionData")]
    pub tx_data: Option<TxSubmissionData>,
}

#[derive(Debug, serde::Deserialize)]
#[allow(dead_code)]
pub struct TxSubmissionData {
    pub to: String,
    pub data: String,
    pub value: String,
}

#[derive(Debug, serde::Deserialize)]
#[allow(dead_code)]
pub struct GraphQLError {
    #[serde(rename = "type")]
    pub error_type: Option<String>,
    pub message: Option<String>,
}

/// Drop metadata
#[derive(Debug, serde::Deserialize)]
#[allow(dead_code)]
pub struct DropInfo {
    pub slug: Option<String>,
    pub stages: Vec<DropStage>,
}

#[derive(Debug, serde::Deserialize)]
#[allow(dead_code)]
pub struct DropStage {
    pub label: Option<String>,
    pub start_time: Option<String>,
    pub stage_index: Option<u32>,
    pub price: Option<serde_json::Value>,
}

/// Fetch calldata using the persisted MintActionTimelineQuery (swap mutation)
pub async fn fetch_calldata(
    session: &OpenSeaSession,
    cfg: &Config,
    wallet_address: &str,
    collection_slug: &str,
    chain: &str,
) -> anyhow::Result<TxSubmissionData> {
    let query = json!({
        "extensions": {
            "persistedQuery": {
                "sha256Hash": cfg.swap_query_hash,
                "version": 1
            }
        },
        "operationName": "MintActionTimelineQuery",
        "variables": {
            "address": wallet_address.to_lowercase(),
            "capabilities": { "eip7702": false },
            "fromAssets": [
                {
                    "asset": {
                        "chain": chain,
                        "contractAddress": "0x0000000000000000000000000000000000000000"
                    }
                }
            ],
            "toAssets": [
                {
                    "asset": {
                        "chain": chain,
                        "contractAddress": collection_slug,
                        "tokenId": "0"
                    },
                    "quantity": "1"
                }
            ]
        }
    });

    let resp = session
        .client
        .post(&cfg.graphql_endpoint)
        .header("x-graphql-operation-type", "mutation")
        .header("x-app-id", "os2-web")
        .json(&query)
        .send()
        .await?;

    let status = resp.status();
    let body: serde_json::Value = resp.json().await?;

    if !status.is_success() {
        anyhow::bail!("GraphQL request failed ({}): {}", status, body);
    }

    // Check for errors first
    if let Some(errors) = body["data"]["swap"]["errors"].as_array() {
        if !errors.is_empty() {
            let err_msg = errors
                .first()
                .and_then(|e| e["message"].as_str())
                .unwrap_or("unknown swap error");
            anyhow::bail!("Swap error: {} (response: {})", err_msg, body);
        }
    }

    // Extract transaction submission data
    let actions = body["data"]["swap"]["actions"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("No actions array in response: {}", body))?;

    let tx_data = actions
        .iter()
        .find_map(|a| a["transactionSubmissionData"].as_object())
        .ok_or_else(|| anyhow::anyhow!("No transactionSubmissionData in actions: {}", body))?;

    Ok(TxSubmissionData {
        to: tx_data["to"]
            .as_str()
            .unwrap_or("")
            .to_string(),
        data: tx_data["data"]
            .as_str()
            .unwrap_or("")
            .to_string(),
        value: tx_data["value"]
            .as_str()
            .unwrap_or("0")
            .to_string(),
    })
}

/// Fetch drop timing and pricing using persisted MintModuleQuery
pub async fn fetch_drop_info(
    session: &OpenSeaSession,
    cfg: &Config,
) -> anyhow::Result<DropInfo> {
    let query = json!({
        "extensions": {
            "persistedQuery": {
                "sha256Hash": cfg.drop_info_query_hash,
                "version": 1
            }
        },
        "operationName": "MintModuleQuery",
        "variables": {
            "collectionSlug": cfg.collection_slug
        }
    });

    let resp = session
        .client
        .post(&cfg.graphql_endpoint)
        .header("x-graphql-operation-type", "query")
        .header("x-app-id", "os2-web")
        .json(&query)
        .send()
        .await?;

    let status = resp.status();
    let body: serde_json::Value = resp.json().await?;

    if !status.is_success() {
        anyhow::bail!("Drop info request failed ({}): {}", status, body);
    }

    let drop =
        serde_json::from_value::<DropInfo>(body["data"]["dropBySlug"].clone())
            .map_err(|e| anyhow::anyhow!("Failed to parse drop info: {} — body: {}", e, body))?;

    Ok(drop)
}