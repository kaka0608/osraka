# OpenSea FCFS Minter Bot 🚀

Rust + Python bot untuk FCFS (First-Come-First-Served) NFT minting di OpenSea.
Auto-detect collection, smart stage selection, countdown to mint.

**Made by Rakatzy. Inspired by Zun's article.**

## ✨ Features

- 🔍 **Check drop** — Lihat semua stage + waktu buka (WIB) + harga
- 🧠 **Smart wait-mint** — Otomatis deteksi allowlist vs public, countdown, mint pas buka
- 🔐 **Cookie auth** — Gak perlu API key OpenSea, cukup cookie dari browser
- 💰 **EIP-1559** — Sign and send transaction langsung dari script
- 📝 **Dry run** — Simpan calldata ke file JSON buat inspeksi
- ⚙️ **.env support** — Private key + cookie di `.env`, gak perlu tiap kali

## 📋 Requirements

- **Python 3.11+**
- **ETH** untuk gas (min ~0.003 ETH di Base chain)
- **OpenSea cookie** dari browser (Chrome/Firefox DevTools)

## 🚀 Quick Start

### 1. Clone & Setup

```bash
git clone <repo-url> os-minter
cd os-minter
cp .env.example .env
```

### 2. Get Cookie + Private Key

```bash
# Set cookie dari browser
./os-minter --set-cookie="os2AccessEx=YOUR_COOKIE_VALUE"

# Atau isi langsung di .env
#   PRIVATE_KEY="0x..."
#   OS_COOKIE="os2AccessEx=..."
```

> **Cara dapetin cookie:**
> 1. Buka https://opensea.io di Chrome → Login + Connect Wallet
> 2. F12 → Application → Cookies → opensea.io → `os2AccessEx` → Copy Value
> 3. `./os-minter --set-cookie="os2AccessEx=COPIED_VALUE"`

### 3. Test Auth

```bash
./os-minter --test
# ✅ Cookie valid!
```

### 4. Check Drop Timing

```bash
./os-minter -c "bad-migo" --check-drop

# Output:
# Index Label      Start (WIB)           Price  Type
#     1 GTD        25 May 20:30 WIB      0.0    Presale
#     2 FCFS       25 May 20:45 WIB      0.0    Presale
#     0 World      25 May 22:45 WIB      0.0005 Public
```

### 5. Smart Wait & Auto-Mint 🎯

```bash
# Script akan:
# 1. Cek semua stage
# 2. Kalo ada allowlist + kamu eligible → MINT LANGSUNG
# 3. Kalo gak eligible → tunggu PUBLIC_SALE buka
# 4. Kalo gak ada PUBLIC_SALE → skip (gak maksain mint)

./os-minter -c "bad-migo" --wait-mint

# Atau batasi max waktu tunggu (misal 2 jam = 7200 detik)
./os-minter -c "bad-migo" --wait-mint --max-wait 7200
```

### 6. Dry Run (Simpan Calldata)

```bash
./os-minter -c "bad-migo" --output mint-calldata.json
```

## 📖 All Commands

| Command | Description |
|---------|-------------|
| `--set-cookie "val"` | Save OpenSea auth cookie |
| `--test` | Test cookie auth |
| `-c, --collection <slug>` | Collection slug (required for mint) |
| `-p, --private-key <key>` | Private key (or use .env) |
| `--check-drop` | Show drop stages, timing, price |
| `--wait-mint` | Smart wait + auto-mint |
| `--max-wait <secs>` | Max wait time (default: 86400 = 24h) |
| `--output <file>` | Save calldata as JSON (no send) |
| `--rpc <url>` | RPC URL (default: mainnet.base.org) |
| `--chain-id <id>` | Chain ID (default: 8453 = Base) |
| `--set-drops-hash <hash>` | Set drops listing hash from browser |

## 📁 Files

```
os-minter/
├── os-minter        # Bash wrapper (auto-setup venv)
├── os-minter.py     # Main Python script
├── .env.example     # Config template (copy to .env)
├── .gitignore       # .env + secrets excluded
├── README.md        # This file
├── src/             # Rust source (alternative)
└── Cargo.toml       # Rust project config
```

## 🔬 Technical Details

- **Endpoint**: `gql.opensea.io/graphql` (OpenSea internal API)
- **Auth**: `os2AccessEx` cookie (browser session)
- **Query**: Persisted GraphQL (SHA256 hashes)
- **Tx**: EIP-1559 via `web3.py` + `eth-account`

### Known Hashes

| Hash | Operation |
|------|-----------|
| `768f25...` | **swap() mutation** — calldata 🔑 |
| `2dc7d7...` | `MintModuleQuery` — drop info |
| `d893f0...` | `DropEligibilityQuery` — eligibility |
| `9e9e34...` | `CollectionItemsListQuery` — contract address |

## ⚠️ Important Notes

1. **ETH for gas** — Wallet needs ETH on the target chain (~0.003 ETH minimum)
2. **Cookie expires** — Re-apply with `--set-cookie` when cookie expires
3. **No batch mint** — Single wallet per run
4. **EIP-1559 only** — No legacy tx support
5. **Rust version** — Also available in `src/`, needs `cargo build`

## 🔗 Connect

- Twitter/X: [@rakaxbt](https://x.com/rakaxbt)

---

*Built with ❤️ for the degens*