#!/usr/bin/env python3
"""
os-minter.py — OpenSea FCFS Minter Script
Cookie-based auth, persisted query swap(), EIP-1559 tx.

Usage:
  # Set cookie
  python3 os-minter.py --set-cookie="os2AccessEx=xxx"

  # Check drop timing
  python3 os-minter.py --collection="the-stiffies-962977063" --check-drop

  # Test auth
  python3 os-minter.py --collection="the-stiffies-962977063" --test

  # Mint!
  python3 os-minter.py --private-key="0x..." --collection="the-stiffies-962977063"
"""

import json, os, sys, time
from datetime import datetime, timezone, timedelta
from pathlib import Path

# ─── .env Loader (auto-load from script dir) ─────────────────

def load_env():
    env_path = Path(__file__).resolve().parent / ".env"
    if env_path.exists():
        for line in env_path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key, val = key.strip(), val.strip()
            if val and val[0] in ('"', "'") and val[-1] == val[0]:
                val = val[1:-1]
            os.environ.setdefault(key, val)

load_env()

# Load DROPS_LIST_HASH from env after .env is loaded
DROPS_LIST_HASH = os.environ.get("DROPS_LIST_HASH", "")
COLLECTION_ITEMS_HASH = "9e9e342e5a74c5f1407b2eb3d02137c7087acabf3873b8510428b7e9574e9f4f"
DROP_ELIGIBILITY_HASH = "d893f026d731e8f14986921fa4229098e018289f6cc7683f8ee2dd83749dd95d"

import requests

# ─── Config ──────────────────────────────────────────────────

GRAPHQL_URL = "https://gql.opensea.io/graphql"
SWAP_HASH = "768f258429ec0cd8ac2a5eaf46ff8614889dcfccfa44224ec3e823c958345dca"
DROP_HASH = "2dc7d722d0b9022240a1bb9516c6c5b4e785eec8aae29b24efa330d887390987"
SESSION_FILE = Path.home() / ".os-session.json"

# Defaults
RPC_URL = "https://mainnet.base.org"
CHAIN_ID = 8453
GAS_LIMIT = 300_000
MAX_PRIORITY_FEE = 2  # gwei
MAX_FEE = 5  # gwei

HEADERS = {
    "accept": "application/graphql-response+json, application/graphql+json, application/json",
    "content-type": "application/json",
    "x-app-id": "os2-web",
    "origin": "https://opensea.io",
    "referer": "https://opensea.io/",
    "user-agent": "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36",
}


# ─── Session ─────────────────────────────────────────────────

def load_session():
    if SESSION_FILE.exists():
        try:
            return json.loads(SESSION_FILE.read_text())
        except:
            pass
    return None

def save_session(data):
    SESSION_FILE.write_text(json.dumps(data, indent=2))
    print(f"✅ Session saved to {SESSION_FILE}")

def get_cookie():
    """Get cookie from session or env."""
    session = load_session()
    if session:
        cookie = session.get("cookie", "")
        expires = session.get("expires_at", 0)
        if cookie and time.time() < expires:
            return cookie
    return os.environ.get("OS_COOKIE", "")


# ─── GraphQL ─────────────────────────────────────────────────

def gql_request(cookie, query_data, op_type="query"):
    """Send a persisted GraphQL request."""
    headers = dict(HEADERS)
    headers["cookie"] = cookie
    headers["x-graphql-operation-type"] = op_type

    resp = requests.post(GRAPHQL_URL, json=query_data, headers=headers, timeout=30)
    return resp

def fetch_drop_info(cookie, slug):
    """Get drop stages and pricing."""
    query = {
        "extensions": {
            "persistedQuery": {"sha256Hash": DROP_HASH, "version": 1}
        },
        "operationName": "MintModuleQuery",
        "variables": {"collectionSlug": slug},
    }
    resp = gql_request(cookie, query, "query")
    data = resp.json()
    drop = data.get("data", {}).get("dropBySlug", {})
    return drop

def fetch_calldata(cookie, wallet, contract_address, chain="base"):
    """Get transaction calldata from swap() mutation."""
    query = {
        "extensions": {
            "persistedQuery": {"sha256Hash": SWAP_HASH, "version": 1}
        },
        "operationName": "MintActionTimelineQuery",
        "variables": {
            "address": wallet.lower(),
            "capabilities": {"eip7702": False},
            "fromAssets": [
                {"asset": {"chain": chain, "contractAddress": "0x0000000000000000000000000000000000000000"}}
            ],
            "toAssets": [
                {
                    "asset": {"chain": chain, "contractAddress": contract_address, "tokenId": "0"},
                    "quantity": "1",
                }
            ],
        },
    }
    resp = gql_request(cookie, query, "mutation")
    data = resp.json()

    # Check for swap errors
    errors = data.get("data", {}).get("swap", {}).get("errors", [])
    if errors:
        msg = errors[0].get("message", "unknown error")
        raise Exception(f"Swap error: {msg} — {data}")

    # Extract tx data
    actions = data.get("data", {}).get("swap", {}).get("actions", [])
    for a in actions:
        tx = a.get("transactionSubmissionData")
        if tx:
            return tx

    raise Exception(f"No transaction data in response: {data}")


def resolve_contract_address(cookie, slug):
    """Cari contract address dari collection slug via CollectionItemsListQuery."""
    query = {
        "extensions": {
            "persistedQuery": {"sha256Hash": COLLECTION_ITEMS_HASH, "version": 1}
        },
        "operationName": "CollectionItemsListQuery",
        "variables": {
            "collectionSlug": slug,
            "limit": 1,
            "sort": {"by": "PRICE", "direction": "ASC"},
        },
    }
    resp = gql_request(cookie, query, "query")
    data = resp.json()
    items = data.get("data", {}).get("collectionItems", {}).get("items", [])
    if not items:
        raise Exception(f"Cannot resolve contract address for '{slug}'")
    
    contract = items[0].get("contractAddress", "")
    chain = items[0].get("chain", {}).get("identifier", "base")
    return contract, chain


def validate_cookie(cookie):
    """Test if cookie is still valid."""
    query = {
        "extensions": {
            "persistedQuery": {
                "sha256Hash": "89371f42cf208440cb8ee43f2f83f32c52c9ce7eaf1ef2b5783ba1bca5775ea4",
                "version": 1,
            }
        },
        "operationName": "UnreadNotificationsCountV2Query",
        "variables": {"topic": "SOCIAL"},
    }
    resp = gql_request(cookie, query, "query")
    return resp.status_code == 200


def fetch_drops_list(cookie):
    """Get list of active/upcoming drops.
    
    NOTE: Butuh DROPS_LIST_HASH dari browser capture.
    Buka opensea.io/drops → F12 Console → jalankan script capture_hash.js
    """
    if not DROPS_LIST_HASH:
        return None
    
    query = {
        "extensions": {
            "persistedQuery": {"sha256Hash": DROPS_LIST_HASH, "version": 1}
        },
        "operationName": "DropsQuery",  # may need different name
        "variables": {"first": 50, "status": "LIVE"},
    }
    resp = gql_request(cookie, query, "query")
    return resp.json()


# ─── Signing (via web3.py) ───────────────────────────────────

def sign_and_send(private_key, to_addr, data_hex, value_hex, nonce=None):
    """Sign and send EIP-1559 transaction using web3.py."""
    from web3 import Web3
    from web3.middleware import SignAndSendRawMiddlewareBuilder
    from eth_account import Account

    w3 = Web3(Web3.HTTPProvider(RPC_URL))
    acct = Account.from_key(private_key)
    addr = acct.address

    # Get nonce if not provided
    if nonce is None:
        nonce = w3.eth.get_transaction_count(addr, "pending")

    # Build tx
    tx = {
        "from": addr,
        "to": Web3.to_checksum_address(to_addr),
        "data": data_hex if data_hex.startswith("0x") else "0x" + data_hex,
        "value": int(value_hex, 16) if value_hex.startswith("0x") else int(value_hex),
        "nonce": nonce,
        "chainId": CHAIN_ID,
        "maxPriorityFeePerGas": w3.to_wei(MAX_PRIORITY_FEE, "gwei"),
        "maxFeePerGas": w3.to_wei(MAX_FEE, "gwei"),
        "gas": GAS_LIMIT,
    }

    # Estimate gas (optional)
    try:
        tx["gas"] = w3.eth.estimate_gas(tx)
        print(f"  ⛽ Estimated gas: {tx['gas']}")
    except:
        pass  # use default

    # Sign + send
    signed = acct.sign_transaction(tx)
    tx_hash = w3.eth.send_raw_transaction(signed.raw_transaction)
    print(f"  ✅ Tx sent: {tx_hash.hex()}")

    # Wait for receipt
    receipt = w3.eth.wait_for_transaction_receipt(tx_hash, timeout=120)
    status = receipt.get("status")
    block = receipt.get("blockNumber")

    if status == 1:
        print(f"  ✅ Confirmed in block {block}")
    else:
        print(f"  ❌ Failed! Receipt: {receipt}")

    return tx_hash


# ─── CLI ─────────────────────────────────────────────────────

WIB = timezone(timedelta(hours=7))  # UTC+7

def fmt_time(dt_str):
    """Format ISO time string to WIB."""
    if not dt_str:
        return "?"
    try:
        dt = datetime.fromisoformat(dt_str.replace("Z", "+00:00"))
        return dt.astimezone(WIB).strftime("%d %b %H:%M WIB")
    except:
        return dt_str[:16]

def print_drop(drop):
    stages = drop.get("stages", [])
    if not stages:
        print("No stages found")
        return
    print(f"\n📅 Drop: {drop.get('slug', 'unknown')}")
    print(f"{'Index':>5} {'Label':<25} {'Start (WIB)':<25} {'Price ETH':<10} {'Type':<20}")
    print("-" * 85)
    for s in stages:
        price_token = s.get("price", {}).get("token", {}).get("unit", "N/A")
        stype = s.get("stageType", s.get("__typename", "?"))
        print(
            f"{str(s.get('stageIndex', '?')):>5} "
            f"{str(s.get('label', ''))[:25]:<25} "
            f"{fmt_time(s.get('startTime',''))[:25]:<25} "
            f"{str(price_token):<10} "
            f"{str(stype)[:20]:<20}"
        )


def find_public_stage(drop):
    """Find PUBLIC_SALE stage from drop info.
    Checks MintModuleQuery first, then DropEligibilityQuery for stageType.
    """
    # First check if any stage has PUBLIC in its type
    for s in drop.get("stages", []):
        stype = s.get("stageType", "")
        if stype == "PUBLIC_SALE":
            return s
    return None


def fetch_stage_types(cookie, slug, address):
    """Get detailed stage info with stageType from DropEligibilityQuery."""
    query = {
        "extensions": {
            "persistedQuery": {"sha256Hash": DROP_ELIGIBILITY_HASH, "version": 1}
        },
        "operationName": "DropEligibilityQuery",
        "variables": {
            "address": address.lower(),
            "collectionSlug": slug,
        },
    }
    resp = gql_request(cookie, query, "query")
    data = resp.json()
    return data.get("data", {}).get("dropBySlug", {})


def wait_and_mint(cookie, contract_addr, chain, acct, pk, drop, args):
    """Smart mint: cek semua stage, prioritaskan eligible.
    
    1. Kalo eligible GTD/FCFS/WL yang udah buka → MINT SKRG
    2. Kalo eligible GTD/FCFS/WL yang belum buka → TUNGGU sampe buka
    3. Kalo gak eligible tapi ada PUBLIC_SALE → TUNGGU / MINT pas buka
    4. Kalo gak ada sama sekali → SKIP
    """
    # Fetch eligibility (punya stageType + isEligible)
    print("   Checking eligibility...")
    elig_drop = fetch_stage_types(cookie, args.collection, acct.address)
    if not elig_drop.get("stages"):
        print("❌ Gagal fetch eligibility")
        return

    # Map stageIndex for quick lookup
    drop_map = {}
    for s in (drop.get("stages") or []):
        drop_map[s.get("stageIndex")] = s

    # Gabung data: DropEligibilityQuery (stageType, isEligible) + MintModuleQuery (startTime, price, label)
    merged_stages = []
    for s in (elig_drop.get("stages") or []):
        idx = s.get("stageIndex")
        ds = drop_map.get(idx, {})
        merged = dict(s)  # copy eligibility stage
        # Merge fields from MintModuleQuery
        for field in ["startTime", "price", "label", "maxTotalMintableByWallet"]:
            if field not in ds and not ds.get(field):
                if ds.get(field):
                    merged[field] = ds.get(field)
            elif ds.get(field):
                merged[field] = ds.get(field)
        # Determine if eligible
        stype = merged.get("stageType", "")
        if stype == "PUBLIC_SALE":
            merged["_eligible"] = True  # publik selalu eligible
        else:
            merged["_eligible"] = merged.get("isEligible") is True
        # Determine start time
        start_str = merged.get("startTime", "")
        if start_str:
            merged["_start_dt"] = datetime.fromisoformat(start_str.replace("Z", "+00:00"))
        else:
            merged["_start_dt"] = None
        merged_stages.append(merged)

    now = datetime.now(timezone.utc)

    # Priority 1: cari stage yang ELIGIBLE + SUDAH BUKA
    print("\n📋 Checking stages:")
    for s in merged_stages:
        label = s.get("label", s.get("stageType", "?"))
        eligible = s["_eligible"]
        start_dt = s["_start_dt"]
        is_open = start_dt and start_dt <= now if start_dt else False
        price = s.get("price", {}).get("token", {}).get("unit", "?")
        time_str = start_dt.astimezone(WIB).strftime("%d %b %H:%M WIB") if start_dt else "?"
        print(f"   {s.get('stageIndex','?')}. {label[:20]:<20} "
              f"{'✅' if eligible else '❌'} eligible | "
              f"{'🟢' if is_open else '⏳'} "
              f"{time_str:<20} | "
              f"{price} ETH")

    # Cari stage eligible + sudah buka → mint NOW
    for s in merged_stages:
        if s["_eligible"] and s["_start_dt"] and s["_start_dt"] <= now:
            mint_now(cookie, contract_addr, chain, acct, pk, s, args)
            return

    # Cari stage eligible + belum buka (tunggu bentar)
    for s in merged_stages:
        if s["_eligible"] and s["_start_dt"] and s["_start_dt"] > now:
            target_wib = s["_start_dt"].astimezone(WIB).strftime("%H:%M WIB")
            print(f"\n⏳ Stage '{s.get('label','?')}' buka jam {target_wib} "
                  f"({(s['_start_dt'] - now).total_seconds():.0f}s lagi)")
            return  # TODO: full countdown + wait

    # Gak eligible sama sekali → cek PUBLIC_SALE
    public = [s for s in merged_stages if s.get("stageType") == "PUBLIC_SALE"]
    if public:
        ps = public[0]
        if ps["_start_dt"] and ps["_start_dt"] <= now:
            mint_now(cookie, contract_addr, chain, acct, pk, ps, args)
        else:
            wait_secs = (ps["_start_dt"] - now).total_seconds() if ps["_start_dt"] else 0
            if wait_secs > 0:
                if wait_secs > args.max_wait:
                    target_wib = ps["_start_dt"].astimezone(WIB).strftime("%H:%M WIB")
                    print(f"\n⏰ PUBLIC buka jam {target_wib} ({wait_secs/3600:.1f}h lagi) — exceed --max-wait")
                    print(f"   Pakai: --max-wait {int(wait_secs)+3600}")
                    return
                target_wib = ps["_start_dt"].astimezone(WIB).strftime("%H:%M WIB")
                print(f"\n⏳ Nunggu PUBLIC buka jam {target_wib} ({wait_secs:.0f}s lagi)...")
                try:
                    while wait_secs > 0:
                        hrs, rem = divmod(int(wait_secs), 3600)
                        mins, secs = divmod(rem, 60)
                        msg = f"⏳ {'🟢' if mins < 1 else '⏳'} "
                        if hrs: msg += f"{hrs}h "
                        msg += f"{mins}m {secs}s   "
                        print(f"\r   {msg}", end="", flush=True)
                        time.sleep(min(5, wait_secs))
                        wait_secs = (ps["_start_dt"] - datetime.now(timezone.utc)).total_seconds()
                        if wait_secs < 0:
                            break
                except KeyboardInterrupt:
                    print("\n   ⏹ Batal")
                    return
                print("\n   🚀 PUBLIC DIBUKA!")
                mint_now(cookie, contract_addr, chain, acct, pk, ps, args)
    else:
        print("\n❌ Gak ada stage yang bisa di-mint")
        print("   Kamu gak eligible untuk allowlist, dan gak ada PUBLIC_SALE")


def mint_now(cookie, contract_addr, chain, acct, pk, stage, args):
    """MINT SEKARANG JUGA."""
    label = stage.get("label", stage.get("stageType", "mint"))
    price = stage.get("price", {}).get("token", {}).get("unit", "?")
    print(f"\n🚀 MINT '{label}' ({price} ETH)!")
    
    tx_data = fetch_calldata(cookie, acct.address, contract_addr, chain)
    print(f"   To: {tx_data['to'][:20]}...")
    print(f"   Data: {tx_data['data'][:40]}...")
    print(f"   Value: {tx_data['value']}")
    
    if args.output:
        out = {"to": tx_data["to"], "data": tx_data["data"], "value": tx_data["value"],
               "from": acct.address, "chainId": args.chain_id, "nonce": None}
        Path(args.output).write_text(json.dumps(out, indent=2))
        print(f"✅ Calldata saved to {args.output}")
    else:
        print("✍️  Signing + sending...")
        sign_and_send(pk, tx_data["to"], tx_data["data"], tx_data["value"])


def main():
    import argparse

    parser = argparse.ArgumentParser(description="OpenSea FCFS Minter")
    parser.add_argument("--set-cookie", help="Save os2AccessEx cookie")
    parser.add_argument("--private-key", "-p", help="Wallet private key (or PRIVATE_KEY env)")
    parser.add_argument("--collection", "-c", help="Collection slug")
    parser.add_argument("--check-drop", action="store_true", help="Check drop timing only")
    parser.add_argument("--list-drops", action="store_true", help="List all live drops (hash needed)")
    parser.add_argument("--set-drops-hash", help="Set DROPS_LIST_HASH from browser capture")
    parser.add_argument("--test", action="store_true", help="Test auth only")
    parser.add_argument("--rpc", default=RPC_URL, help=f"RPC URL (default: {RPC_URL})")
    parser.add_argument("--chain-id", type=int, default=CHAIN_ID, help=f"Chain ID (default: {CHAIN_ID})")
    parser.add_argument("--output", help="Save calldata to JSON file (no sign/send)")
    parser.add_argument("--wait-mint", action="store_true",
        help="Wait until PUBLIC stage opens, then auto-mint")
    parser.add_argument("--max-wait", type=int, default=86400,
        help="Max wait seconds for --wait-mint (default: 24h)")

    args = parser.parse_args()

    # Set cookie mode
    if args.set_cookie:
        cookie_str = args.set_cookie
        if not cookie_str.startswith("os2AccessEx="):
            cookie_str = f"os2AccessEx={cookie_str}"
        save_session({
            "cookie": cookie_str,
            "wallet_address": "pending",
            "expires_at": time.time() + 86400 * 30,
            "created_at": time.time(),
        })
        print("✅ Cookie saved! Run with --collection <slug> to mint.")
        return

    # Set drops listing hash
    if args.set_drops_hash:
        global DROPS_LIST_HASH
        DROPS_LIST_HASH = args.set_drops_hash
        # Save to .env
        env_path = Path(__file__).resolve().parent / ".env"
        with open(env_path, "a") as f:
            f.write(f'\nDROPS_LIST_HASH="{DROPS_LIST_HASH}"\n')
        print(f"✅ DROPS_LIST_HASH saved to .env")
        return

    # Get cookie
    cookie = get_cookie()
    if not cookie:
        print("❌ No cookie found!")
        print("   Run: python3 os-minter.py --set-cookie=\"os2AccessEx=YOUR_COOKIE\"")
        print("   Or set: export OS_COOKIE=\"os2AccessEx=...\"")
        sys.exit(1)

    # Validate cookie
    if not validate_cookie(cookie):
        print("❌ Cookie expired or invalid!")
        print("   Get a new one from browser DevTools → Cookies → os2AccessEx")
        sys.exit(1)
    print("✅ Cookie valid!")

    # Check drop mode
    if args.check_drop:
        if not args.collection:
            print("❌ --collection required for --check-drop")
            sys.exit(1)
        drop = fetch_drop_info(cookie, args.collection)
        print_drop(drop)
        return

    # List drops mode
    if args.list_drops:
        if not DROPS_LIST_HASH:
            print("❌ DROPS_LIST_HASH belum diisi!")
            print()
            print("   Cara dapetin hash:")
            print("   1) Buka https://opensea.io/drops di Chrome")
            print("   2) F12 → Console")
            print("   3) Paste ini terus Enter:")
            print()
            print('      (function h(){const f=window.fetch;window.fetch=function(...a){')
            print("      const u=typeof a[0]=='string'?a[0]:a[0]?.url||''")
            print("      const b=typeof a[1]?.body=='string'?a[1].body:''")
            print("      if(u.includes('gql.opensea.io')&&b)console.log('📡',b.slice(0,300))")
            print("      return f.apply(this,a)}})()")
            print()
            print("   4) Scroll halaman drops → lihat console → ada request GQL")
            print("   5) Copy SHA256 hash-nya → kirim ke aku")
            print("   6) Nanti aku update scriptnya")
            sys.exit(1)
        drops = fetch_drops_list(cookie)
        if drops:
            print(json.dumps(drops, indent=2)[:2000])
        return

    # Test mode
    if args.test:
        print("✅ Auth OK! (cookie valid)")
        return

    # Need collection for minting
    if not args.collection:
        print("❌ --collection required")
        sys.exit(1)

    # Get private key
    pk = args.private_key or os.environ.get("PRIVATE_KEY")
    if not pk:
        print("❌ --private-key required!")
        print("   Options:")
        print("     1) --private-key=\"0x...\"")
        print("     2) export PRIVATE_KEY=\"0x...\"")
        print(f"     3) echo 'PRIVATE_KEY=\"0x...\"' > {Path(__file__).resolve().parent / '.env'}")
        sys.exit(1)
    if not pk.startswith("0x"):
        pk = "0x" + pk

    # Derive wallet address
    from eth_account import Account
    acct = Account.from_key(pk)
    print(f"\n🚀 Wallet: {acct.address}")
    print(f"   Collection: {args.collection}")

    # Fetch drop info
    print("\n🔍 Fetching drop info...")
    drop = fetch_drop_info(cookie, args.collection)
    print_drop(drop)

    # Resolve contract address dari slug
    print("🔍 Resolving contract address...")
    try:
        contract_addr, chain = resolve_contract_address(cookie, args.collection)
        print(f"   Contract: {contract_addr}")
        print(f"   Chain: {chain}")
    except Exception as e:
        print(f"❌ {e}")
        sys.exit(1)

    # ─── Wait-mint mode ────────────────────────────────
    if args.wait_mint:
        print("⏰ --wait-mint mode: checking PUBLIC stage...")
        wait_and_mint(cookie, contract_addr, chain, acct, pk, drop, args)
        return

    # ─── Normal mint flow ───────────────────────────────
    # Fetch calldata
    print("\n📡 Fetching calldata...")
    try:
        tx_data = fetch_calldata(cookie, acct.address, contract_addr, chain)
        print(f"   To:    {tx_data['to']}")
        print(f"   Data:  {tx_data['data'][:60]}...")
        print(f"   Value: {tx_data['value']}")
    except Exception as e:
        print(f"❌ {e}")
        sys.exit(1)

    # Save to file mode
    if args.output:
        output = {
            "to": tx_data["to"],
            "data": tx_data["data"],
            "value": tx_data["value"],
            "from": acct.address,
            "chainId": args.chain_id,
            "nonce": None,
        }
        Path(args.output).write_text(json.dumps(output, indent=2))
        print(f"✅ Calldata saved to {args.output}")
        return

    # Sign and send
    print("\n✍️  Signing and sending transaction...")
    sign_and_send(pk, tx_data["to"], tx_data["data"], tx_data["value"])


if __name__ == "__main__":
    main()
