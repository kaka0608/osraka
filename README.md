# OpenSea FCFS Minter Bot 🚀

Node.js bot untuk FCFS NFT minting di OpenSea.
Auto-extract slug dari URL, smart stage detection, countdown, auto-mint pas PUBLIC buka.

**Made by Rakatzy. Inspired by Zun's article.**

## ✨ Features

- 🔗 **Paste URL** — Auto-extract slug dari `opensea.io/collection/slug`
- 🔍 **Check drop** — Lihat semua stage + waktu buka (WIB) + harga + max per wallet + total minted
- 🧠 **Smart auto-mint** — Cek eligibility → countdown tiap detik → mint otomatis pas PUBLIC buka
- 🔐 **Cookie auth** — Gak perlu API key OpenSea, cukup cookie dari browser
- 💰 **EIP-1559** — Sign and send transaction langsung dari script (ethers.js v6)
- 📝 **Dry run** — Simpan calldata ke file JSON buat inspeksi
- ⚙️ **.env + session** — Private key di `.env`, cookie tersimpan otomatis

## 📋 Requirements

- **Node.js 18+** (tested on v22)
- **ETH** untuk gas (min ~0.002 ETH di chain target)
- **OpenSea cookie** dari browser (Chrome/Firefox DevTools)

## 🚀 Quick Start

### 1. Setup

```bash
cd ~/opensea-minter-bot
npm install
```

### 2. Get Cookie + Private Key

**Cara dapetin cookie:**
1. Buka https://opensea.io di Chrome → Login + Connect Wallet
2. `F12` → tab **Application** (Chrome) / **Storage** (Firefox)
3. Kiri: **Cookies** → `opensea.io`
4. Cari `os2AccessEx` → Copy **Value**
5. Set cookie:

```bash
./os-minter --set-cookie="os2AccessEx=COPIED_VALUE"
```

**Set private key:**
```bash
echo 'PRIVATE_KEY="0xYOUR_PRIVATE_KEY"' >> .env
```

Atau pake flag tiap jalan:
```bash
./os-minter -p "0x..." "url"
```

### 3. Test Auth

```bash
./os-minter --test
# ✅ Cookie valid!
```

### 4. Check Drop Timing

```bash
./os-minter "https://opensea.io/collection/the-stiffies-962977063" --check-drop

# Output:
# 📅 Drop: unknown
#    Max per wallet: 2
#   Idx Label             Start (WIB)        Price  Type
# -----------------------------------------------------------------
#     1 STIFFIES TEAM     25 May 22:00 WIB   N/A    Erc721SeaDropV1Stage
#     2 STIFFIES WL       25 May 23:00 WIB   N/A    Erc721SeaDropV1Stage
#     0 STIFFIES PUBLIC   26 May 01:00 WIB   N/A    Erc721SeaDropV1Stage
#    Contract: 0xc08ae...
#    Chain: ethereum
#    Minted: 803
```

### 5. Smart Auto-Mint 🎯

```bash
# Paste URL, script otomatis:
# 1. Cek drop + eligibility
# 2. Kalo PUBLIC buka → MINT LANGSUNG
# 3. Kalo PUBLIC masih nanti → COUNTDOWN TIAP DETIK → mint pas buka

./os-minter -p "0x..." "https://opensea.io/collection/the-stiffies-962977063"

# Output:
# ⏳ Nunggu 'STIFFIES PUBLIC' buka jam 26 May 01:00 WIB (4418s lagi)...
#    ⏳ ⏳ 1h 13m 32s... 1h 13m 31s... 1h 13m 30s...
#    🚀 DIBUKA!
#       📡 Fetching calldata...
#       ✍️  Signing + sending...
#       ✅ Tx sent: 0x...
#       ✅ Confirmed in block 123456
```

### 6. Dry Run (Simpan Calldata)

```bash
./os-minter -p "0x..." "https://opensea.io/collection/slug" --output mint-data.json
```

## 📖 All Commands

| Command | Description |
|---------|-------------|
| `--set-cookie "val"` | Save OpenSea auth cookie |
| `--test` | Test cookie auth |
| `<url_or_slug>` | Positional: OpenSea URL or collection slug |
| `-p, --private-key <key>` | Private key (or use .env) |
| `--check-drop` | Show drop stages, timing, price, supply |
| `--max-wait <secs>` | Max wait time (default: 86400 = 24h) |
| `--output <file>` | Save calldata as JSON (no send) |
| `--rpc <url>` | RPC URL (default: mainnet.base.org) |
| `--chain-id <id>` | Chain ID (default: auto from OpenSea) |

## 📁 Files

```
os-minter/
├── os-minter         # Bash wrapper
├── os-minter.js      # Main Node.js script 🎯
├── package.json      # Deps (ethers v6)
├── .env              # Private key (gitignored)
├── .env.example      # Config template
└── README.md         # This file
```

## 🔬 Technical Details

- **Endpoint**: `gql.opensea.io/graphql` (OpenSea internal API)
- **Auth**: `os2AccessEx` cookie (browser session, valid ~30 hari)
- **Query**: Persisted GraphQL (SHA256 hashes)
- **Tx**: EIP-1559 via `ethers.js` v6

### Known Hashes

| Hash | Operation |
|------|-----------|
| `768f25...` | **swap() mutation** — calldata 🔑 |
| `2dc7d7...` | `MintModuleQuery` — drop info |
| `d893f0...` | `DropEligibilityQuery` — eligibility |
| `9e9e34...` | `CollectionItemsListQuery` — contract address |

## ⚠️ Important Notes

1. **ETH for gas** — Wallet needs ETH on the target chain (~0.002 ETH minimum)
2. **Cookie expires** — Re-apply with `--set-cookie` when cookie expires (~30 hari)
3. **No batch mint** — Single wallet per run
4. **EIP-1559 only** — No legacy tx support
5. **Smart mode** — Selalu auto-detect PUBLIC stage, gak maksain mint kalo gak eligible

## 🔗 Connect

- Twitter/X: [@rakaxbt](https://x.com/rakaxbt)

---

*Built with ❤️ for the degans*