#!/usr/bin/env node
/**
 * os-minter.js — OpenSea FCFS Minter (Node.js)
 * Cookie-based auth, persisted query swap(), EIP-1559 tx.
 *
 * Usage:
 *   # Set cookie
 *   ./os-minter --set-cookie="os2AccessEx=xxx"
 *
 *   # Check drop timing
 *   ./os-minter https://opensea.io/collection/slug --check-drop
 *
 *   # Test auth
 *   ./os-minter --test
 *
 *   # Mint! (auto detect PUBLIC, countdown, then mint)
 *   ./os-minter -p 0x... https://opensea.io/collection/slug
 *
 *   # Save calldata only (no sign/send)
 *   ./os-minter -p 0x... https://opensea.io/collection/slug --output data.json
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ethers } from 'ethers';

// ─── Constants ──────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, '.env');
const SESSION_PATH = path.join(process.env.HOME || '/home/rakatzy', '.os-session.json');
const GRAPHQL_URL = 'https://gql.opensea.io/graphql';
const SWAP_HASH = '768f258429ec0cd8ac2a5eaf46ff8614889dcfccfa44224ec3e823c958345dca';
const DROP_HASH = '2dc7d722d0b9022240a1bb9516c6c5b4e785eec8aae29b24efa330d887390987';
const COLLECTION_ITEMS_HASH = '9e9e342e5a74c5f1407b2eb3d02137c7087acabf3873b8510428b7e9574e9f4f';
const DROP_ELIGIBILITY_HASH = 'd893f026d731e8f14986921fa4229098e018289f6cc7683f8ee2dd83749dd95d';

const HEADERS = {
  accept: 'application/graphql-response+json, application/graphql+json, application/json',
  'content-type': 'application/json',
  'x-app-id': 'os2-web',
  origin: 'https://opensea.io',
  referer: 'https://opensea.io/',
  'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36',
};

const WIB_OFFSET = 7; // UTC+7

// ─── .env Loader ────────────────────────────────────────────

function loadEnv() {
  try {
    const raw = fs.readFileSync(ENV_PATH, 'utf-8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || !trimmed.includes('=')) continue;
      const idx = trimmed.indexOf('=');
      const key = trimmed.slice(0, idx).trim();
      let val = trimmed.slice(idx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      process.env[key] ??= val;
    }
  } catch {}
}

loadEnv();

// ─── Session ────────────────────────────────────────────────

function loadSession() {
  try {
    return JSON.parse(fs.readFileSync(SESSION_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

function saveSession(data) {
  fs.writeFileSync(SESSION_PATH, JSON.stringify(data, null, 2));
  console.log(`✅ Session saved to ${SESSION_PATH}`);
}

function getCookie() {
  const session = loadSession();
  if (session) {
    const c = session.cookie;
    const exp = session.expires_at || 0;
    if (c && Date.now() / 1000 < exp) return c;
  }
  return process.env.OS_COOKIE || '';
}

// ─── GraphQL ────────────────────────────────────────────────

async function gqlRequest(cookie, queryData, opType = 'query') {
  const headers = { ...HEADERS, cookie, 'x-graphql-operation-type': opType };
  const resp = await fetch(GRAPHQL_URL, {
    method: 'POST',
    headers,
    body: JSON.stringify(queryData),
  });
  const text = await resp.text();
  return { status: resp.status, data: JSON.parse(text) };
}

async function fetchDropInfo(cookie, slug) {
  const { data } = await gqlRequest(cookie, {
    extensions: { persistedQuery: { sha256Hash: DROP_HASH, version: 1 } },
    operationName: 'MintModuleQuery',
    variables: { collectionSlug: slug },
  });
  return data?.data?.dropBySlug || null;
}

async function fetchCalldata(cookie, wallet, contractAddress, chain = 'base') {
  const { data } = await gqlRequest(cookie, {
    extensions: { persistedQuery: { sha256Hash: SWAP_HASH, version: 1 } },
    operationName: 'MintActionTimelineQuery',
    variables: {
      address: wallet.toLowerCase(),
      capabilities: { eip7702: false },
      fromAssets: [
        { asset: { chain, contractAddress: '0x0000000000000000000000000000000000000000' } },
      ],
      toAssets: [
        {
          asset: { chain, contractAddress, tokenId: '0' },
          quantity: '1',
        },
      ],
    },
  }, 'mutation');

  const errors = data?.data?.swap?.errors;
  if (errors?.length) {
    const errType = errors[0].__typename || 'UnknownError';
    const errMsg = errors[0].message || errType;
    const fullErr = new Error(`Swap error: ${errMsg}`);
    fullErr.code = errType;  // e.g. 'InsufficientFundError'
    fullErr.raw = data;
    throw fullErr;
  }

  const actions = data?.data?.swap?.actions || [];
  for (const a of actions) {
    if (a.transactionSubmissionData) return a.transactionSubmissionData;
  }
  throw new Error(`No transaction data: ${JSON.stringify(data)}`);
}

async function resolveContractAddress(cookie, slug) {
  const { data } = await gqlRequest(cookie, {
    extensions: { persistedQuery: { sha256Hash: COLLECTION_ITEMS_HASH, version: 1 } },
    operationName: 'CollectionItemsListQuery',
    variables: {
      collectionSlug: slug,
      limit: 1,
      sort: { by: 'PRICE', direction: 'ASC' },
    },
  });
  const items = data?.data?.collectionItems?.items || [];
  if (!items.length) throw new Error(`Cannot resolve contract address for '${slug}'`);
  return {
    contract: items[0].contractAddress,
    chain: items[0].chain?.identifier || 'base',
  };
}

async function fetchTotalMinted(contractAddr, chain) {
  try {
    const rpcMap = { ethereum: 'https://ethereum-rpc.publicnode.com', base: 'https://mainnet.base.org' };
    const rpc = rpcMap[chain] || 'https://mainnet.base.org';
    const provider = new ethers.JsonRpcProvider(rpc);
    // ERC721 totalSupply() signature: 0x18160ddd
    const data = await provider.call({ to: contractAddr, data: '0x18160ddd' });
    return parseInt(data, 16);
  } catch {
    return null;
  }
}

async function validateCookie(cookie) {
  const { status } = await gqlRequest(cookie, {
    extensions: {
      persistedQuery: {
        sha256Hash: '89371f42cf208440cb8ee43f2f83f32c52c9ce7eaf1ef2b5783ba1bca5775ea4',
        version: 1,
      },
    },
    operationName: 'UnreadNotificationsCountV2Query',
    variables: { topic: 'SOCIAL' },
  });
  return status === 200;
}

async function fetchStageTypes(cookie, slug, address) {
  const { data } = await gqlRequest(cookie, {
    extensions: { persistedQuery: { sha256Hash: DROP_ELIGIBILITY_HASH, version: 1 } },
    operationName: 'DropEligibilityQuery',
    variables: { address: address.toLowerCase(), collectionSlug: slug },
  });
  return data?.data?.dropBySlug || null;
}

// ─── Helpers ────────────────────────────────────────────────

function fmtTime(dtStr) {
  if (!dtStr) return '?';
  try {
    const dt = new Date(dtStr.replace('Z', '+00:00'));
    const wib = new Date(dt.getTime() + WIB_OFFSET * 3600000);
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${String(wib.getDate()).padStart(2, '0')} ${months[wib.getMonth()]} ${String(wib.getHours()).padStart(2, '0')}:${String(wib.getMinutes()).padStart(2, '0')} WIB`;
  } catch {
    return String(dtStr).slice(0, 16);
  }
}

function printDrop(drop) {
  const stages = drop?.stages || [];
  if (!stages.length) {
    console.log('No stages found');
    return;
  }
  console.log(`\n📅 Drop: ${drop.slug || 'unknown'}`);
  // Show per-wallet limit from PUBLIC stage
  const pubStage = findPublicStage(stages);
  if (pubStage?.maxTotalMintableByWallet) {
    console.log(`   Max per wallet: ${pubStage.maxTotalMintableByWallet}`);
  }
  console.log(`${'Idx'.padStart(5)} ${'Label'.padEnd(25)} ${'Start (WIB)'.padEnd(22)} ${'Price'.padEnd(10)} ${'Type'.padEnd(20)}`);
  console.log('-'.repeat(85));
  for (const s of stages) {
    const price = s.price?.token?.unit || 'N/A';
    const stype = s.stageType || s.__typename || '?';
    console.log(
      `${String(s.stageIndex ?? '?').padStart(5)} ` +
      `${(s.label || '').slice(0, 24).padEnd(25)} ` +
      `${fmtTime(s.startTime).padEnd(22)} ` +
      `${String(price).padEnd(10)} ` +
      `${String(stype).slice(0, 19).padEnd(20)}`
    );
  }
}

function findPublicStage(stages) {
  // Check stageType first
  for (const s of stages || []) {
    if (s.stageType === 'PUBLIC_SALE') return s;
  }
  // Fallback: check label
  for (const s of stages || []) {
    if ((s.label || '').toUpperCase().includes('PUBLIC')) return s;
  }
  return null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Signing (ethers) ──────────────────────────────────────

async function signAndSend(privateKey, toAddr, dataHex, valueHex, opts = {}) {
  const rpc = opts.rpc || 'https://mainnet.base.org';
  const chainId = opts.chainId || 8453;
  const maxPriorityFee = opts.maxPriorityFee || 2; // gwei
  const maxFee = opts.maxFee || 5; // gwei
  const gasLimit = opts.gasLimit || 300000;

  const provider = new ethers.JsonRpcProvider(rpc);
  const wallet = new ethers.Wallet(privateKey, provider);

  const tx = {
    to: ethers.getAddress(toAddr),
    data: dataHex.startsWith('0x') ? dataHex : '0x' + dataHex,
    value: valueHex.startsWith('0x') ? BigInt(valueHex) : BigInt(valueHex),
    chainId,
    maxPriorityFeePerGas: ethers.parseUnits(String(maxPriorityFee), 'gwei'),
    maxFeePerGas: ethers.parseUnits(String(maxFee), 'gwei'),
    gasLimit,
  };

  // Estimate gas
  try {
    const est = await provider.estimateGas({ ...tx, from: wallet.address });
    tx.gasLimit = est;
    console.log(`  ⛽ Estimated gas: ${est}`);
  } catch {}

  console.log(`  ✍️ Sending tx...`);
  const resp = await wallet.sendTransaction(tx);
  console.log(`  ✅ Tx sent: ${resp.hash}`);

  const receipt = await resp.wait();
  if (receipt.status === 1) {
    console.log(`  ✅ Confirmed in block ${receipt.blockNumber}`);
  } else {
    console.log(`  ❌ Failed! Receipt: ${JSON.stringify(receipt)}`);
  }
  return resp.hash;
}

// ─── Mint Logic ─────────────────────────────────────────────

async function waitAndMint(cookie, contractAddr, chain, wallet, pk, drop, opts = {}) {
  console.log('   Checking eligibility...');
  const eligDrop = await fetchStageTypes(cookie, opts.collection, wallet.address);
  if (!eligDrop?.stages?.length) {
    console.log('❌ Gagal fetch eligibility');
    return;
  }

  // Build merged stages
  const dropMap = {};
  for (const s of drop?.stages || []) {
    dropMap[s.stageIndex] = s;
  }

  const merged = (eligDrop.stages || []).map(s => {
    const idx = s.stageIndex;
    const ds = dropMap[idx] || {};
    const merged = { ...s };
    for (const field of ['startTime', 'price', 'label', 'maxTotalMintableByWallet']) {
      if (ds[field]) merged[field] = ds[field];
    }
    const stype = merged.stageType || '';
    const label = (merged.label || '').toUpperCase();
    merged._eligible = (stype === 'PUBLIC_SALE' || label.includes('PUBLIC')) ? true : (merged.isEligible === true);
    const startStr = merged.startTime;
    merged._startDt = startStr ? new Date(startStr.replace('Z', '+00:00')) : null;
    return merged;
  });

  const now = new Date();

  // Print stage status
  console.log('\n📋 Checking stages:');
  for (const s of merged) {
    const label = s.label || s.stageType || '?';
    const isOpen = s._startDt && s._startDt <= now;
    const price = s.price?.token?.unit || '?';
    const timeStr = s._startDt ? fmtTime(s.startTime) : '?';
    console.log(
      `   ${String(s.stageIndex ?? '?')}. ${String(label).slice(0, 19).padEnd(20)} ` +
      `${s._eligible ? '✅' : '❌'} eligible | ` +
      `${isOpen ? '🟢' : '⏳'} ${timeStr.padEnd(20)} | ` +
      `${price} ETH`
    );
  }

  // Priority 1: eligible + open → mint now
  for (const s of merged) {
    if (s._eligible && s._startDt && s._startDt <= now) {
      await mintNow(cookie, contractAddr, chain, wallet, pk, s, opts);
      return;
    }
  }

  // Priority 2: eligible + not yet open → countdown
  for (const s of merged) {
    if (s._eligible && s._startDt && s._startDt > now) {
      let waitSecs = Math.floor((s._startDt - now) / 1000);
      if (waitSecs > (opts.maxWait || 86400)) {
        console.log(`\n⏰ '${s.label || s.stageType || '?'}' buka jam ${fmtTime(s.startTime)} (${(waitSecs / 3600).toFixed(1)}h lagi) — exceed --max-wait`);
        console.log(`   Pakai: --max-wait ${waitSecs + 3600}`);
        return;
      }
      console.log(`\n⏳ Nunggu '${s.label || s.stageType || '?'}' buka jam ${fmtTime(s.startTime)} (${waitSecs}s lagi)...`);
      // Cek supply awal
      let lastSupply = await fetchTotalMinted(contractAddr, chain);
      let supplyCheckCount = 0;
      let soldOut = false;
      try {
        while (waitSecs > 0 && !soldOut) {
          const hrs = Math.floor(waitSecs / 3600);
          const rem = waitSecs % 3600;
          const mins = Math.floor(rem / 60);
          const secs2 = rem % 60;
          let msg = `⏳ ${mins < 1 ? '🟢' : '⏳'} `;
          if (hrs) msg += `${hrs}h `;
          msg += `${mins}m ${secs2}s`;
          // Show supply if available
          if (lastSupply !== null) msg += ` | ${lastSupply} minted`;
          process.stdout.write(`\r   ${msg}   `);
          await sleep(Math.min(1000, waitSecs * 1000));
          waitSecs = Math.floor((s._startDt - new Date()) / 1000);
          if (waitSecs < 0) break;
          // Every 30s check supply
          supplyCheckCount++;
          if (supplyCheckCount % 30 === 0) {
            const newSupply = await fetchTotalMinted(contractAddr, chain);
            if (newSupply !== null) {
              if (lastSupply !== null && newSupply === lastSupply && waitSecs <= 0) {
                // Stage buka tapi supply gak nambah → sold out
                soldOut = true;
              }
              lastSupply = newSupply;
            }
          }
        }
      } catch {
        console.log('\n   ⏹ Batal');
        return;
      }
      if (soldOut) {
        console.log('\n   ❌ SOLD OUT! Total minted stuck di ' + lastSupply);
        console.log('   Countdown dihentikan.');
        return;
      }
      console.log('\n   🚀 DIBUKA!');
      await mintNow(cookie, contractAddr, chain, wallet, pk, s, opts);
      return;
    }
  }

  // Not eligible → check PUBLIC
  const publicStage = findPublicStage(merged);
  if (publicStage) {
    if (publicStage._startDt && publicStage._startDt <= now) {
      await mintNow(cookie, contractAddr, chain, wallet, pk, publicStage, opts);
      return;
    }
    let waitSecs = publicStage._startDt ? Math.floor((publicStage._startDt - now) / 1000) : 0;
    if (waitSecs > 0) {
      if (waitSecs > (opts.maxWait || 86400)) {
        console.log(`\n⏰ PUBLIC buka jam ${fmtTime(publicStage.startTime)} (${(waitSecs / 3600).toFixed(1)}h lagi) — exceed --max-wait`);
        console.log(`   Pakai: --max-wait ${waitSecs + 3600}`);
        return;
      }
      console.log(`\n⏳ Nunggu PUBLIC buka jam ${fmtTime(publicStage.startTime)} (${waitSecs}s lagi)...`);
      let lastSupply = await fetchTotalMinted(contractAddr, chain);
      let supplyCheckCount = 0;
      let soldOut = false;
      try {
        while (waitSecs > 0 && !soldOut) {
          const hrs = Math.floor(waitSecs / 3600);
          const rem = waitSecs % 3600;
          const mins = Math.floor(rem / 60);
          const secs2 = rem % 60;
          let msg = `⏳ ${mins < 1 ? '🟢' : '⏳'} `;
          if (hrs) msg += `${hrs}h `;
          msg += `${mins}m ${secs2}s`;
          if (lastSupply !== null) msg += ` | ${lastSupply} minted`;
          else if (lastSupply === null && supplyCheckCount > 0) msg += ` | ? minted`;
          process.stdout.write(`\r   ${msg}   `);
          await sleep(Math.min(1000, waitSecs * 1000));
          waitSecs = Math.floor((publicStage._startDt - new Date()) / 1000);
          if (waitSecs < 0) break;
          supplyCheckCount++;
          if (supplyCheckCount % 30 === 0) {
            const newSupply = await fetchTotalMinted(contractAddr, chain);
            if (newSupply !== null) {
              if (lastSupply !== null && newSupply === lastSupply && waitSecs <= 0) {
                soldOut = true;
              }
              lastSupply = newSupply;
            }
          }
        }
      } catch {
        console.log('\n   ⏹ Batal');
        return;
      }
      if (soldOut) {
        console.log('\n   ❌ SOLD OUT! Total minted stuck di ' + lastSupply);
        console.log('   Countdown dihentikan.');
        return;
      }
      console.log('\n   🚀 PUBLIC DIBUKA!');
      await mintNow(cookie, contractAddr, chain, wallet, pk, publicStage, opts);
    }
  } else {
    console.log('\n❌ Gak ada stage yang bisa di-mint');
    console.log('   Kamu gak eligible untuk allowlist, dan gak ada PUBLIC_SALE');
  }
}

async function mintNow(cookie, contractAddr, chain, wallet, pk, stage, opts = {}) {
  const label = stage.label || stage.stageType || 'mint';
  const price = stage.price?.token?.unit || '?';
  console.log(`\n🚀 MINT '${label}' (${price} ETH)!`);

  const txData = await fetchCalldata(cookie, wallet.address, contractAddr, chain).catch(e => {
    if (e.code === 'SoldOutError' || e.message?.includes('sold out') || e.message?.includes('SoldOut')) {
      console.log('   ❌ SOLD OUT! Semua udah ke-mint.');
      return null;
    }
    throw e;
  });
  if (!txData) return;

  console.log(`   To: ${txData.to.slice(0, 20)}...`);
  console.log(`   Data: ${txData.data.slice(0, 40)}...`);
  console.log(`   Value: ${txData.value}`);

  if (opts.output) {
    const out = {
      to: txData.to,
      data: txData.data,
      value: txData.value,
      from: wallet.address,
      chainId: opts.chainId || 8453,
      nonce: null,
    };
    fs.writeFileSync(opts.output, JSON.stringify(out, null, 2));
    console.log(`✅ Calldata saved to ${opts.output}`);
  } else {
    console.log('✍️  Signing + sending...');
    await signAndSend(pk, txData.to, txData.data, txData.value, opts);
  }
}

// ─── CLI ────────────────────────────────────────────────────

function extractSlug(raw) {
  // opensea.io/collection/SLUG → SLUG
  const m = raw.match(/opensea\.io\/collection\/([^/?\s]+)/);
  if (m) return m[1];
  // raw slug: alphanumeric + hyphens, min 3 chars
  if (/^[a-z0-9][a-z0-9-]{2,}$/i.test(raw)) return raw;
  return null;
}

function parseArgs() {
  const args = {};
  const raw = process.argv.slice(2);
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i];
    if (a === '--set-cookie') {
      args.setCookie = raw[++i];
    } else if (a === '--private-key' || a === '-p') {
      args.privateKey = raw[++i];
    } else if (a === '--collection' || a === '-c') {
      args.collection = raw[++i];
    } else if (a === '--check-drop') {
      args.checkDrop = true;
    } else if (a === '--list-drops') {
      args.listDrops = true;
    } else if (a === '--set-drops-hash') {
      args.setDropsHash = raw[++i];
    } else if (a === '--test') {
      args.test = true;
    } else if (a === '--max-wait') {
      args.maxWait = parseInt(raw[++i]) || 86400;
    } else if (a === '--rpc') {
      args.rpc = raw[++i];
    } else if (a === '--chain-id') {
      args.chainId = parseInt(raw[++i]) || 8453;
    } else if (a === '--output') {
      args.output = raw[++i];
    } else if (!a.startsWith('-')) {
      // Positional arg: URL or slug
      const slug = extractSlug(a);
      if (slug) args.collection = slug;
    }
  }
  return args;
}

// ─── Main ──────────────────────────────────────────────────

async function main() {
  const args = parseArgs();

  // Set cookie mode
  if (args.setCookie) {
    let cookieStr = args.setCookie.replace(/\s+/g, '');
    if (!cookieStr.startsWith('os2AccessEx=')) {
      cookieStr = `os2AccessEx=${cookieStr}`;
    }
    saveSession({
      cookie: cookieStr,
      wallet_address: 'pending',
      expires_at: Math.floor(Date.now() / 1000) + 86400 * 30,
      created_at: Math.floor(Date.now() / 1000),
    });
    console.log('✅ Cookie saved! Run with -c <slug> to mint.');
    return;
  }

  // Set drops hash
  if (args.setDropsHash) {
    const hash = args.setDropsHash;
    let envContent = '';
    try { envContent = fs.readFileSync(ENV_PATH, 'utf-8'); } catch {}
    if (!envContent.includes('DROPS_LIST_HASH')) {
      fs.appendFileSync(ENV_PATH, `\nDROPS_LIST_HASH="${hash}"\n`);
    } else {
      // Replace existing line
      envContent = envContent.replace(/^DROPS_LIST_HASH=.*$/m, `DROPS_LIST_HASH="${hash}"`);
      fs.writeFileSync(ENV_PATH, envContent);
    }
    process.env.DROPS_LIST_HASH = hash;
    console.log('✅ DROPS_LIST_HASH saved to .env');
    return;
  }

  // Get cookie
  const cookie = getCookie();
  if (!cookie) {
    console.log('❌ No cookie found!');
    console.log('   Run: ./os-minter --set-cookie="os2AccessEx=YOUR_COOKIE"');
    console.log('   Or set: export OS_COOKIE="os2AccessEx=..."');
    process.exit(1);
  }

  // Validate cookie
  const valid = await validateCookie(cookie);
  if (!valid) {
    console.log('❌ Cookie expired or invalid!');
    console.log('   Get a new one from browser DevTools → Cookies → os2AccessEx');
    process.exit(1);
  }
  console.log('✅ Cookie valid!');

  // Check drop mode
  if (args.checkDrop) {
    if (!args.collection) {
      console.log('❌ -c/--collection required for --check-drop');
      process.exit(1);
    }
    const drop = await fetchDropInfo(cookie, args.collection);
    if (!drop?.stages?.length) {
      console.log(`❌ No drop found for '${args.collection}'`);
      console.log('   Possible: slug salah, drop udah selesai, atau collection gak punya drop');
      return;
    }
    printDrop(drop);
    return;
  }

  // List drops
  if (args.listDrops) {
    const hash = process.env.DROPS_LIST_HASH;
    if (!hash) {
      console.log('❌ DROPS_LIST_HASH belum diisi!');
      console.log('\n   Cara dapetin hash:');
      console.log('   1) Buka https://opensea.io/drops di Chrome');
      console.log('   2) F12 → Console');
      console.log('   3) Paste ini terus Enter:\n');
      console.log('      (function h(){const f=window.fetch;window.fetch=function(...a){');
      console.log(`      const u=typeof a[0]=='string'?a[0]:a[0]?.url||''`);
      console.log(`      const b=typeof a[1]?.body=='string'?a[1].body:''`);
      console.log("      if(u.includes('gql.opensea.io')&&b)console.log('📡',b.slice(0,300))");
      console.log('      return f.apply(this,a)}})()\n');
      console.log('   4) Scroll halaman drops → lihat console → ada request GQL');
      console.log('   5) Copy SHA256 hash-nya → kirim ke aku');
      process.exit(1);
    }
    const { data } = await gqlRequest(cookie, {
      extensions: { persistedQuery: { sha256Hash: hash, version: 1 } },
      operationName: 'DropsQuery',
      variables: { first: 50, status: 'LIVE' },
    });
    console.log(JSON.stringify(data, null, 2).slice(0, 2000));
    return;
  }

  // Test mode
  if (args.test) {
    console.log('✅ Auth OK! (cookie valid)');
    return;
  }

  // Need collection for minting
  if (!args.collection) {
    console.log('❌ -c/--collection required');
    process.exit(1);
  }

  // Get private key
  const pk = args.privateKey || process.env.PRIVATE_KEY;
  if (!pk) {
    console.log('❌ -p/--private-key required!');
    console.log('   Options:');
    console.log('     1) -p "0x..."');
    console.log('     2) export PRIVATE_KEY="0x..."');
    console.log(`     3) echo 'PRIVATE_KEY="0x..."' > ${ENV_PATH}`);
    process.exit(1);
  }
  const finalPk = pk.startsWith('0x') ? pk : '0x' + pk;

  // Derive wallet
  const wallet = new ethers.Wallet(finalPk);
  console.log(`\n🚀 Wallet: ${wallet.address}`);
  console.log(`   Collection: ${args.collection}`);

  // Fetch drop info
  console.log('\n🔍 Fetching drop info...');
  const drop = await fetchDropInfo(cookie, args.collection);
  printDrop(drop);

  // Resolve contract
  console.log('🔍 Resolving contract address...');
  try {
    const { contract, chain } = await resolveContractAddress(cookie, args.collection);
    console.log(`   Contract: ${contract}`);
    console.log(`   Chain: ${chain}`);

    // Fetch total minted
    const totalMinted = await fetchTotalMinted(contract, chain);
    if (totalMinted !== null) {
      console.log(`   Minted: ${totalMinted.toLocaleString()}`);
    }

    const opts = {
      collection: args.collection,
      maxWait: args.maxWait || 86400,
      output: args.output,
      rpc: args.rpc || 'https://mainnet.base.org',
      chainId: args.chainId || 8453,
    };

    // ─── Smart mint mode ──────────────────────────────
    // Auto: cek drop → countdown ke PUBLIC → mint
    // Kalo PUBLIC udah buka → mint langsung
    console.log('⏰ Smart mode: checking stages...');
    await waitAndMint(cookie, contract, chain, wallet, finalPk, drop, opts);
  } catch (e) {
    console.log(`❌ ${e.message}`);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('❌ Fatal:', err.message || err);
  process.exit(1);
});
