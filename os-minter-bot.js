#!/usr/bin/env node
/**
 * os-minter-bot.js — v2 Multi-Fitur
 * Gas tracker, Favorites, Multi-wallet mint, History, Auto-backup
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import TelegramBot from 'node-telegram-bot-api';
import { ethers } from 'ethers';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENV_PATH = path.join(__dirname, '.env');
const WALLETS_PATH = path.join(process.env.HOME||'/home/rakatzy','.os-wallets.json');
const USERS_PATH = path.join(process.env.HOME||'/home/rakatzy','.os-users.json');
const HISTORY_PATH = path.join(process.env.HOME||'/home/rakatzy','.os-history.json');
const FAVS_PATH = path.join(process.env.HOME||'/home/rakatzy','.os-favorites.json');

// ─── Load .env ──────────────────────────────────────────────
function loadEnv() {
  try { const r=fs.readFileSync(ENV_PATH,'utf-8'); for(const l of r.split('\n')){const t=l.trim();if(!t||t.startsWith('#')||!t.includes('='))continue;const i=t.indexOf('=');const k=t.slice(0,i).trim();let v=t.slice(i+1).trim();if((v.startsWith('"')&&v.endsWith('"'))||(v.startsWith("'")&&v.endsWith("'")))v=v.slice(1,-1);process.env[k]??=v;} } catch {}
}
loadEnv();

const TOKEN=process.env.TELEGRAM_BOT_TOKEN||'';
if(!TOKEN){console.error('❌ TELEGRAM_BOT_TOKEN not set');process.exit(1);}
const ENCRYPT_PASS=process.env.WALLET_ENCRYPT_KEY||null;

import{fetchDropInfo,fetchCalldata,resolveContractAddress,fetchTotalMinted,fetchStageTypes,findPublicStage,validateCookie,getCookie,fmtTime,sleep,signAndSend}from'./os-minter.js';

// ─── Storage ────────────────────────────────────────────────
function loadJSON(p){try{return JSON.parse(fs.readFileSync(p,'utf-8'))}catch{return {}}}
function saveJSON(p,d){fs.writeFileSync(p,JSON.stringify(d,null,2));}

function loadWallets(){return loadJSON(WALLETS_PATH)}
function saveWallets(w){saveJSON(WALLETS_PATH,w)}
function getUserWallet(cid){return loadWallets()[String(cid)]||null}
function setUserWallet(cid,pk,addr){const w=loadWallets();w[String(cid)]={privateKey:pk,address:addr,registered_at:Date.now()};saveWallets(w);}
function removeUserWallet(cid){const w=loadWallets();delete w[String(cid)];saveWallets(w);}

// ─── Encrypt ────────────────────────────────────────────────
function encryptWallet(pk){
  if(!ENCRYPT_PASS) return pk;
  const buf=Buffer.from(pk,'utf-8'),key=Buffer.from(ENCRYPT_PASS.padEnd(32,'.').slice(0,32));
  const enc=Buffer.alloc(buf.length);
  for(let i=0;i<buf.length;i++)enc[i]=buf[i]^key[i%key.length];
  return 'enc:'+enc.toString('base64');
}
function decryptWallet(enc){
  if(!enc.startsWith('enc:')) return enc;
  if(!ENCRYPT_PASS) return null;
  const buf=Buffer.from(enc.slice(4),'base64'),key=Buffer.from(ENCRYPT_PASS.padEnd(32,'.').slice(0,32));
  const dec=Buffer.alloc(buf.length);
  for(let i=0;i<buf.length;i++)dec[i]=buf[i]^key[i%key.length];
  return dec.toString('utf-8');
}

// Patch set/remove wallet to encrypt
const _origSet=setUserWallet;
setUserWallet=function(cid,pk,addr){const w=loadWallets();w[String(cid)]={privateKey:encryptWallet(pk),address:addr,registered_at:Date.now()};saveWallets(w);};
const _origGet=getUserWallet;
getUserWallet=function(cid){const w=loadWallets()[String(cid)];if(!w)return null;return{...w,privateKey:decryptWallet(w.privateKey)};};

// ─── User tracking ─────────────────────────────────────────
function loadUsers(){return loadJSON(USERS_PATH)}
function saveUsers(u){saveJSON(USERS_PATH,u)}
function logUser(msg){const c=String(msg.chat?.id||msg.from?.id||msg);const f=msg.from||msg.chat||{};const u=loadUsers();const n=Date.now();if(!u[c]){u[c]={chat_id:Number(c),username:f.username||null,first_name:f.first_name||null,last_name:f.last_name||null,first_seen:n,last_seen:n,commands:0,wallet:null,last_cmd:null};}else{u[c].last_seen=n;u[c].username=f.username||u[c].username;u[c].first_name=f.first_name||u[c].first_name;u[c].last_name=f.last_name||u[c].last_name;}saveUsers(u);}
function incUserCmd(msg){const c=String(msg.chat?.id||msg.from?.id);const u=loadUsers();if(u[c]){u[c].commands++;u[c].last_cmd=new Date().toISOString();saveUsers(u);}}
function setUserWalletRef(cid,addr){const u=loadUsers();if(u[String(cid)]){u[String(cid)].wallet=addr;saveUsers(u);}}

// ─── History ────────────────────────────────────────────────
function addHistory(chatId,txHash,slug,walletAddr,chain,status){
  const h=loadJSON(HISTORY_PATH);
  const id=String(chatId);
  if(!h[id])h[id]=[];
  h[id].unshift({tx:txHash,slug,wallet:walletAddr,chain,status,time:Date.now()});
  if(h[id].length>50)h[id]=h[id].slice(0,50);
  saveJSON(HISTORY_PATH,h);
}

// ─── Auto Scan Drops ─────────────────────────────────────────
const SCANNED_PATH = path.join(process.env.HOME||'/home/rakatzy','.os-scanned.json');
const SCAN_INTERVAL = 30 * 60 * 1000; // 30 menit

async function scanDrops() {
  const cookie = getCookie();
  if (!cookie) return;
  try {
    const valid = await validateCookie(cookie);
    if (!valid) return;
  } catch { return; }

  const scanned = loadJSON(SCANNED_PATH);
  if (!scanned._seen) scanned._seen = [];
  if (!scanned._found) scanned._found = [];

  const newDrops = [];

  for (const chain of SCAN_CHAINS) {
    try {
      const html = await (await fetch(
        `https://opensea.io/rankings?chain=${chain}&sortBy=volume`,
        { headers: { cookie, 'user-agent': 'Mozilla/5.0' } }
      )).text();
      
      const slugs = [...new Set([...html.matchAll(/href="\/collection\/([^"]+)"/g)].map(m => m[1]))];
      
      for (const slug of slugs.slice(0, 30)) {
        if (scanned._seen.includes(slug)) continue;
        scanned._seen.push(slug);
        
        try {
          const r = await fetch('https://gql.opensea.io/graphql', {
            method: 'POST',
            headers: {
              cookie, 'content-type': 'application/json',
              'x-app-id': 'os2-web', 'x-graphql-operation-type': 'query',
              origin: 'https://opensea.io',
            },
            body: JSON.stringify({
              extensions: { persistedQuery: { sha256Hash: '2dc7d722d0b9022240a1bb9516c6c5b4e785eec8aae29b24efa330d887390987', version: 1 } },
              operationName: 'MintModuleQuery',
              variables: { collectionSlug: slug }
            })
          });
          const data = await r.json();
          const drop = data?.data?.data?.dropBySlug;
          
          if (drop?.stages?.length) {
            const now = new Date();
            const upcoming = drop.stages.filter(s =>
              s.startTime && new Date(s.startTime.replace('Z','+00:00')) > now
            ).filter(s =>
              s.stageType === 'PUBLIC_SALE' || (s.label||'').toUpperCase().includes('PUBLIC')
            );
            
            if (upcoming.length && !scanned._found.includes(slug)) {
              scanned._found.push(slug);
              newDrops.push({ slug, chain, stage: upcoming[0] });
            }
          }
        } catch {}
        
        // Rate limit: tunggu bentar
        await new Promise(r => setTimeout(r, 200));
      }
    } catch {}
  }

  saveJSON(SCANNED_PATH, scanned);

  // Notify all users about new drops
  if (newDrops.length) {
    const users = loadUsers();
    for (const uid of Object.keys(users)) {
      try {
        let msg = `📡 ${bold('New FCFS Drop Ditemukan!')}\n\n`;
        for (const d of newDrops) {
          const price = d.stage.price?.token?.unit || 'FREE';
          const start = d.stage.startTime ? fmtTime(d.stage.startTime) : '?';
          msg += `• ${code(d.slug)}\n  🔗 ${d.chain} | 💰 ${price} ETH | ⏳ ${start}\n`;
        }
        msg += `\n/mint https://opensea.io/collection/${newDrops[0].slug}`;
        await bot.sendMessage(Number(uid), msg, menuKb());
      } catch {}
    }
  }

  return newDrops;
}

let scanTimer = null;

// ─── Multi-chain config ─────────────────────────────────────
const CHAIN_CONFIG = {
  base:       { rpc: 'https://mainnet.base.org',                    chainId: 8453,  explorer: 'basescan.org' },
  ethereum:   { rpc: 'https://ethereum-rpc.publicnode.com',         chainId: 1,     explorer: 'etherscan.io' },
  polygon:    { rpc: 'https://polygon-rpc.com',                     chainId: 137,   explorer: 'polygonscan.com' },
  arbitrum:   { rpc: 'https://arb1.arbitrum.io/rpc',                chainId: 42161, explorer: 'arbiscan.io' },
  optimism:   { rpc: 'https://mainnet.optimism.io',                 chainId: 10,    explorer: 'optimistic.etherscan.io' },
  zora:       { rpc: 'https://rpc.zora.energy',                     chainId: 7777777, explorer: 'explorer.zora.energy' },
  avalanche:  { rpc: 'https://api.avax.network/ext/bc/C/rpc',       chainId: 43114, explorer: 'snowtrace.io' },
  bsc:        { rpc: 'https://bsc-dataseed.binance.org',            chainId: 56,    explorer: 'bscscan.com' },
};
const SCAN_CHAINS = Object.keys(CHAIN_CONFIG);

// ─── Gas tracker ────────────────────────────────────────────
async function getGasPrice(chain){
  const cfg = CHAIN_CONFIG[chain];
  if (!cfg) return '⚡ ? gwei';
  try{
    const p=new ethers.JsonRpcProvider(cfg.rpc);
    const fee=await p.getFeeData();
    const gwei=Number(ethers.formatUnits(fee.gasPrice||0n,'gwei'));
    const priority=Number(ethers.formatUnits(fee.maxPriorityFeePerGas||0n,'gwei'));
    return `⚡ ${gwei.toFixed(1)} gwei${priority>0?` (prio ${priority.toFixed(1)})`:''}`;
  }catch{return '⚡ ? gwei';}
}

const bot=new TelegramBot(TOKEN,{polling:true});
const activeMints=new Map();

function addrShort(a){return a?`${a.slice(0,6)}…${a.slice(-4)}`:'?'}
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')}
function code(s){return `<code>${esc(s)}</code>`}
function bold(s){return `<b>${esc(s)}</b>`}
function extractSlug(r){if(!r)return null;const m=r.match(/opensea\.io\/collection\/([^/?\s]+)/);if(m)return m[1];if(/^[a-z0-9][a-z0-9-]{2,}$/i.test(r))return r;return null;}
function fmtDur(s){if(s<0)s=0;const h=Math.floor(s/3600),rm=s%3600,m=Math.floor(rm/60),sec=rm%60;return(h?`${h}j `:'')+`${m}m ${sec}s`;}
function wib(){return new Date(Date.now()+7*3600000).toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit'})}

function menuKb(a){
  const k=[
    [{text:'✏️ Mint NFT',callback_data:'menu_mint'},{text:'👛 Ganti Wallet',callback_data:'menu_wallet'}],
    [{text:'📋 Check Drop',callback_data:'menu_check'}],
    [{text:'🆕 Buat Wallet Baru',callback_data:'menu_create_wallet'}],
    [{text:'👥 Users',callback_data:'menu_users'},{text:'📊 Status',callback_data:'menu_status'}],
    [{text:'📡 Auto Scan',callback_data:'menu_scan'},{text:'📊 Stats',callback_data:'menu_stats'}],
    [{text:'📜 History',callback_data:'menu_history'}],
    [{text:'❓ Bantuan',callback_data:'menu_help'}],
  ];
  if(a)k.push(...a);
  return{reply_markup:{inline_keyboard:k},parse_mode:'HTML',disable_web_page_preview:true};
}
function resultKb(txHash, chain){
  const k=[];
  const cfg = CHAIN_CONFIG[chain] || CHAIN_CONFIG.base;
  if(txHash)k.push([{text:'🔍 Explorer',url:`https://${cfg.explorer}/tx/${txHash}`}]);
  k.push([{text:'⬅️ Kembali ke Menu',callback_data:'menu_start'}]);
  return{reply_markup:{inline_keyboard:k},parse_mode:'HTML',disable_web_page_preview:true};
}

// ─── Callbacks ──────────────────────────────────────────────
bot.on('callback_query',async(q)=>{
  const cid=q.message.chat.id;
  await bot.answerCallbackQuery(q.id);
  if(q.data==='menu_start'){showMenu(cid);}
  else if(q.data==='menu_status'){bot.sendMessage(cid,'📊 Loading...',{parse_mode:'HTML'});cmdStatus(cid);}
  else if(q.data==='menu_mint'){bot.sendMessage(cid,`✏️ ${bold('Mint NFT')}\n\nKirim URL/slug:\n/mint https://opensea.io/collection/...\n\n${bold('/mintall')} — mint pake SEMUA wallet`,{parse_mode:'HTML'});}
  else if(q.data==='menu_wallet'){bot.sendMessage(cid,`👛 ${bold('Ganti Wallet')}\n\n/register 0x... — pake wallet sendiri\n/unregister — hapus wallet\n\n${ENCRYPT_PASS?'🔒 PK terenkripsi':'🔓 PK plain text (set WALLET_ENCRYPT_KEY)'}`,{parse_mode:'HTML'});}
  else if(q.data==='menu_check'){bot.sendMessage(cid,`📋 ${bold('Check Drop')}\n\n/check https://opensea.io/collection/...`,{parse_mode:'HTML'});}
  else if(q.data==='menu_create_wallet'){doCreateWallet(cid);}
  else if(q.data==='menu_users'){showUsers(cid);}
  else if(q.data==='menu_history'){showHistory(cid);}
  else if(q.data==='menu_help'){showHelp(cid);}
  else if(q.data==='menu_favs'){showFavs(cid);}
  else if(q.data==='menu_scan'){showScan(cid);}
else if(q.data==='menu_stats'){bot.sendMessage(cid,`📊 ${bold('Stats Koleksi')}\n\nKirim URL/slug:\n/stats https://opensea.io/collection/...`,{parse_mode:'HTML'});}
});

async function doCreateWallet(cid){
  try{
    const w=ethers.Wallet.createRandom();
    setUserWallet(cid,w.privateKey,w.address);
    setUserWalletRef(cid,w.address);
    await bot.sendMessage(cid,
      `🆕 ${bold('Wallet Baru Dibuat!')}\n\nAddress: ${code(w.address)}\nPK: ${code(w.privateKey)}\n\n⚠️ ${bold('Simpan private key!')}\n💰 Gas fee pake wallet ini.`,{parse_mode:'HTML'});
  }catch(e){await bot.sendMessage(cid,`❌ ${esc(e.message)}`,{parse_mode:'HTML'});}
}

async function showUsers(cid){
  const users=loadUsers(),wallets=loadWallets(),ids=Object.keys(users);
  if(!ids.length){await bot.sendMessage(cid,'Belum ada user.',{parse_mode:'HTML'});return;}
  let msg=`👥 ${bold('Users ('+ids.length+')')}\n\n`;
  for(const id of ids){
    const u=users[id];
    const name=[u.first_name,u.last_name].filter(Boolean).join(' ')||u.username||'?';
    const uname=u.username?`@${u.username}`:'';
    const w=wallets[id];
    const addr=w?addrShort(w.address):(u.wallet?addrShort(u.wallet):'❌');
    const last=new Date(u.last_seen).toLocaleString('id-ID',{timeZone:'Asia/Jakarta',hour:'2-digit',minute:'2-digit'});
    msg+=`${bold(name)} ${uname}\n   👛 ${addr} | 🕐 ${last} | ${u.commands} cmd\n`;
    if(msg.length>3500){msg+='...';break;}
  }
  msg+=`\nTotal wallet: ${Object.keys(wallets).length}`;
  await bot.sendMessage(cid,msg,menuKb());
}

async function showHistory(cid){
  const h=loadJSON(HISTORY_PATH);
  const items=h[String(cid)];
  if(!items?.length) return bot.sendMessage(cid,'Belum ada riwayat mint.',menuKb());
  let msg=`📜 ${bold('Riwayat Mint')}\n\n`;
  for(const item of items.slice(0,10)){
    const t=new Date(item.time).toLocaleString('id-ID',{timeZone:'Asia/Jakarta',day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'});
    const icon=item.status==='success'?'✅':'❌';
    msg+=`${icon} ${code(item.slug)} — ${item.chain}\n   ${t} | ${code(item.tx.slice(0,10)+'...')}\n`;
    if(msg.length>3500)break;
  }
  await bot.sendMessage(cid,msg,menuKb());
}

async function showFavs(cid){
  const favs=getUserFavs(cid);
  if(!favs.length) return bot.sendMessage(cid,`Belum ada favorite.`,menuKb());
  let msg=`Belum ada favorite.`;
  await bot.sendMessage(cid,msg,menuKb());
}

async function showScan(cid){
  const scanned=loadJSON(SCANNED_PATH);
  const found=scanned._found||[];
  const seen=scanned._seen||[];
  let msg=`📡 ${bold('Auto Scan Drops')}\n\n`;
  msg+=`⏱ Scan tiap 30 menit\n`;
  msg+=`👁 ${seen.length} koleksi discan\n`;
  msg+=`🎯 ${found.length} FCFS drop ditemukan\n\n`;
  if(found.length){
    msg+=`${bold('Ditemukan:')}\n`;
    for(const s of found.slice(-10)){
      msg+=`• ${code(s)}\n`;
    }
    msg+=`\nScan berikutnya: ~${Math.ceil((SCAN_INTERVAL - (Date.now() - (scanned._lastScan||0)))/60000)} menit`;
  }else{
    msg+=`Belum ada drop FCFS terdeteksi.\nScan otomatis berjalan...`;
  }
  await bot.sendMessage(cid,msg,menuKb());
}

async function showHelp(cid){
  const msg=`☁️ ${bold('OS Minter Bot — Panduan')}\n\n`+
    `${bold('1. Buat / Daftarin Wallet')}\n`+
    `Klik "🆕 Buat Wallet Baru" → bot bikin wallet random.\n`+
    `Atau /register 0x... — pake wallet sendiri.\n\n`+
    `${bold('2. Cek Drop')}\n`+
    `/check https://... — liat stages, harga, supply.\n\n`+
    `${bold('3. Mint NFT')}\n`+
    `/mint https://... — auto countdown + mint 1x.\n`+
    `/mint 5 https://... — batch mint 5x (max 10).\n`+
    `/mintall https://... — mint pake SEMUA wallet terdaftar!\n\n`+
    `${bold('4. Auto Scan Drops')}\n`+
    `Bot otomatis scan OpenSea tiap 30 menit cari FCFS drop baru.\n`+
    `Klik "📡 Auto Scan" atau lihat notifikasi otomatis.\n\n`+
`${bold('5. Lihat Stats NFT')}\n`+
    `/stats https://... — liat floor price, volume, holder, supply.\n\n`+
    `${bold('6. Lainnya')}\n`+
    `/cancel — stop mint.\n`+
    `/history — liat riwayat mint.\n`+
    `/status — status wallet + gas price + scan info.\n\n`+
    `${bold('⚠️ Penting!')}\n`+
    `• Gas fee dari wallet masing-masing\n`+
    `• Minimal ~0.002 ETH utk gas\n`+
    `• ${ENCRYPT_PASS?'🔒 PK terenkripsi':'🔓 PK plain text'}`;
  await bot.sendMessage(cid,msg,menuKb());
}

// ─── Show menu ──────────────────────────────────────────────
async function showMenu(cid){
  const uw=getUserWallet(cid);
  let msg=`☁️ ${bold('OS Minter Bot')}\n`;
  if(uw){
    msg+=`👛 Wallet: ${code(uw.address)}\n`;
    try{const p=new ethers.JsonRpcProvider('https://mainnet.base.org');msg+=`💰 ${Number(ethers.formatEther(await p.getBalance(uw.address))).toFixed(4)} ETH`;}catch{msg+='💰 ? ETH';}
  }else{
    msg+=`❌ ${bold('Belum register.')} Klik "🆕 Buat Wallet Baru" atau /register`;
  }
  msg+=`\n\nPilih aksi: ${wib()}`;
  const cookie=getCookie();
  if(cookie){const v=await validateCookie(cookie);if(!v)msg+='\n⚠️ Cookie expired!';}
  await bot.sendMessage(cid,msg,menuKb());
}

// ─── Commands ───────────────────────────────────────────────
bot.onText(/^\/start$/,async(m)=>{logUser(m);incUserCmd(m);showMenu(m.chat.id);});

bot.onText(/^\/register(?:\s+(.+))?$/i,async(m,match)=>{
  const cid=m.chat.id;logUser(m);incUserCmd(m);
  const raw=match?.[1]?.trim();
  if(!raw)return bot.sendMessage(cid,'❌ /register 0x...',{parse_mode:'HTML'});
  let pk=raw.startsWith('0x')?raw:'0x'+raw;
  try{const w=new ethers.Wallet(pk);setUserWallet(cid,pk,w.address);setUserWalletRef(cid,w.address);await bot.sendMessage(cid,`✅ ${bold('Wallet registered!')}\n${code(w.address)}`,menuKb());}
  catch{await bot.sendMessage(cid,'❌ Private key tidak valid!',{parse_mode:'HTML'});}
});

bot.onText(/^\/unregister$/,async(m)=>{const cid=m.chat.id;logUser(m);incUserCmd(m);if(!getUserWallet(cid))return bot.sendMessage(cid,'❌ Belum register.',menuKb());removeUserWallet(cid);await bot.sendMessage(cid,'🗑️ Wallet dihapus',menuKb());});

bot.onText(/^\/status$/,async(m)=>{logUser(m);incUserCmd(m);cmdStatus(m.chat.id);});

async function cmdStatus(cid){
  try{
    let s=`📊 ${bold('Status Bot')}\n\n`;
    const uw=getUserWallet(cid);
    if(uw){
      s+=`👛 Wallet: ${code(uw.address)}\n📅 ${new Date(uw.registered_at).toLocaleString('id-ID',{timeZone:'Asia/Jakarta'})}\n`;
      try{const p=new ethers.JsonRpcProvider('https://mainnet.base.org');s+=`💰 Base: ${Number(ethers.formatEther(await p.getBalance(uw.address))).toFixed(4)} ETH\n`;}catch{s+='💰 Base: ?\n';}
      try{const p=new ethers.JsonRpcProvider('https://ethereum-rpc.publicnode.com');s+=`💰 ETH: ${Number(ethers.formatEther(await p.getBalance(uw.address))).toFixed(4)} ETH\n`;}catch{s+='💰 ETH: ?\n';}
    }else s+='❌ Belum register\n';
    s+=`\n${await getGasPrice('base')}\n${await getGasPrice('ethereum')}\n\n`;
    const cookie=getCookie();
    if(cookie)s+=`🍪 Cookie: ${await validateCookie(cookie)?'✅':'❌'}`;else s+='🍪 Cookie: ❌';
    const ses=activeMints.get(cid);if(ses)s+=`\n🔄 Mint: ${ses.collection||'?'}`;
    const scanned=loadJSON(SCANNED_PATH);const sFound=scanned._found||[];
    if(sFound.length)s+=`\n📡 ${sFound.length} drop ditemukan`;
    await bot.sendMessage(cid,s,menuKb());
  }catch(e){await bot.sendMessage(cid,`❌ ${esc(e.message)}`,menuKb());}
}

// ─── /check ─────────────────────────────────────────────────
bot.onText(/^\/check(?:\s+(.+))?$/i,async(m,match)=>{
  const cid=m.chat.id;logUser(m);incUserCmd(m);
  const raw=match?.[1]?.trim();
  if(!raw)return bot.sendMessage(cid,'❌ /check <url>',{parse_mode:'HTML'});

  const slug=extractSlug(raw);
  if(!slug)return bot.sendMessage(cid,'❌ Invalid slug',{parse_mode:'HTML'});
  await bot.sendMessage(cid,`🔍 ${code(slug)}...`,{parse_mode:'HTML'});
  try{
    const cookie=getCookie();
    if(!cookie||!await validateCookie(cookie))return bot.sendMessage(cid,'❌ Cookie expired!',{parse_mode:'HTML'});
    const drop=await fetchDropInfo(cookie,slug);
    if(!drop?.stages?.length)return bot.sendMessage(cid,`❌ No drop ${code(slug)}`,{parse_mode:'HTML'});
    let out=`📦 ${bold(drop.slug||slug)}\n`;
    const pub=findPublicStage(drop.stages);
    if(pub?.maxTotalMintableByWallet)out+=`Max/wallet: ${pub.maxTotalMintableByWallet}\n`;
    try{const {contract,chain}=await resolveContractAddress(cookie,slug);out+=`Contract: ${code(addrShort(contract))}\nChain: ${chain}\n${await getGasPrice(chain)}\n`;const m2=await fetchTotalMinted(contract,chain);if(m2!==null)out+=`Minted: ${m2.toLocaleString()}\n`;}catch{}
    const allPassed=drop.stages.every(s=>!s.startTime||new Date(s.startTime.replace('Z','+00:00'))<=new Date());
    if(allPassed)out+=`\n❌ ${bold('SOLD OUT!')} Koleksi ini udah habis sayang 😢\n`;
    out+='\nStages:\n';
    for(const s of drop.stages){
      const label=s.label||s.stageType||'?';const price=s.price?.token?.unit||'N/A';
      const t=s.startTime?fmtTime(s.startTime):'?';
      const open=s.startTime?new Date(s.startTime.replace('Z','+00:00'))<=new Date():false;
      out+=`${open?'🟢':'⏳'} ${bold(label)} — ${price} ETH\n   ${t} | #${s.stageIndex}\n`;
    }
    await bot.sendMessage(cid,out,menuKb());
  }catch(e){await bot.sendMessage(cid,`❌ ${esc(e.message.slice(0,200))}`,menuKb());}
});

// ─── /stats ─────────────────────────────────────────────────
bot.onText(/^\/stats(?:\s+(.+))?$/i,async(m,match)=>{
  const cid=m.chat.id;logUser(m);incUserCmd(m);
  const raw=match?.[1]?.trim();
  if(!raw)return bot.sendMessage(cid,'❌ /stats <url atau slug>',{parse_mode:'HTML'});
  const slug=extractSlug(raw);
  if(!slug)return bot.sendMessage(cid,'❌ Invalid slug',{parse_mode:'HTML'});
  await bot.sendMessage(cid,`📊 ${bold(slug)} — fetching stats...`,{parse_mode:'HTML'});
  try{
    const cookie=getCookie();
    if(!cookie||!await validateCookie(cookie))return bot.sendMessage(cid,'❌ Cookie expired!',{parse_mode:'HTML'});
    
    // Fetch stats
    const stats=await fetchCollectionStats(cookie,slug);
    if(!stats)return bot.sendMessage(cid,`❌ Gagal ambil stats untuk ${code(slug)}`,{parse_mode:'HTML'});
    
    // Try to get contract + chain too
    let contractStr='', chainStr='';
    try{
      const {contract,chain}=await resolveContractAddress(cookie,slug);
      contractStr=`\n📄 ${bold('Contract:')} ${code(addrShort(contract))}`;
      chainStr=`\n⛓️ ${bold('Chain:')} ${chain.toUpperCase()}`;
    }catch{}

let out=`📊 ${bold(slug.toUpperCase())}\n`;
    out += `━━━━━━━━━━━━━━━━━━━━\n`;

    // Floor price
    const fp=stats.floorPrice;
    out += `💵 ${bold('Floor:')} ${fp>0?fp.toLocaleString(undefined,{maximumFractionDigits:4}):'?'} ${stats.floorSymbol||'ETH'}`;
    // Top offer approximation from cheapest listing - skip for now
    out += `\n`;

    // Volume
    out += `📈 ${bold('Volume:')} ${stats.volume>0?stats.volume.toLocaleString(undefined,{maximumFractionDigits:2}):'?'} ${stats.volumeSymbol||'ETH'}`;
    if(stats.sales>0)out+=` (${stats.sales.toLocaleString()} sales)`;
    out += `\n`;

    // Average price
    if(stats.averagePrice>0)out+=`📊 ${bold('Avg Price:')} ${stats.averagePrice.toLocaleString(undefined,{maximumFractionDigits:4})} ETH\n`;

    // Holders / Supply
    out += `👥 ${bold('Holders:')} ${stats.numOwners>0?stats.numOwners.toLocaleString():'?'}`;
    if(stats.totalSupply>0)out+=` / ${bold('Supply:')} ${stats.totalSupply.toLocaleString()}`;
    out += `\n`;

    // Market cap
    if(stats.marketCap>0)out+=`🏦 ${bold('Market Cap:')} ${stats.marketCap.toLocaleString(undefined,{maximumFractionDigits:2})} ETH\n`;

    // Contract & chain
    out += contractStr+chainStr;

    // Gas estimate
    try{
      const chain=chainStr?chainStr.trim().split(' ').pop():'base';
      const gas=await getGasPrice(chain.toLowerCase());
      out += `\n⛽ ${gas}`;
    }catch{}

    await bot.sendMessage(cid,out,menuKb());
  }catch(e){await bot.sendMessage(cid,`❌ ${esc(e.message.slice(0,200))}`,menuKb());}
});

// ─── /history ───────────────────────────────────────────────
bot.onText(/^\/history$/,async(m)=>{const cid=m.chat.id;logUser(m);incUserCmd(m);showHistory(cid);});

// ─── /mint ──────────────────────────────────────────────────
bot.onText(/^\/mint(?:\s+(.+))?$/i,async(m,match)=>{
  const cid=m.chat.id;logUser(m);incUserCmd(m);
  const raw=match?.[1]?.trim();
  if(!raw)return bot.sendMessage(cid,'❌ /mint [jumlah] <url>\n   /mint 3 https://... — batch mint 3x',{parse_mode:'HTML'});

  // Parse count + slug: "/mint 3 slug" atau "/mint slug"
  let count=1, slugRaw=raw;
  const numMatch=raw.match(/^(\d+)\s+(.+)/);
  if(numMatch){count=parseInt(numMatch[1]);slugRaw=numMatch[2];}
  if(count<1||count>10)return bot.sendMessage(cid,'❌ Jumlah mint: 1-10 aja.',{parse_mode:'HTML'});

  const slug=extractSlug(slugRaw);
  if(!slug)return bot.sendMessage(cid,'❌ Invalid URL',{parse_mode:'HTML'});
  if(activeMints.has(cid))return bot.sendMessage(cid,'⚠️ Ada mint aktif! /cancel dulu.',{parse_mode:'HTML'});
  const uw=getUserWallet(cid);
  if(!uw)return bot.sendMessage(cid,'❌ /register dulu!',{parse_mode:'HTML'});
  const ses={cancel:false,collection:slug,done:false};
  activeMints.set(cid,ses);
  await bot.sendMessage(cid,`✏️ ${bold('Mint NFT')}\n👛 ${code(addrShort(uw.address))}\n📦 ${code(slug)}\n🔢 ${count}x NFT\n\nMulai...`,menuKb());
  runMint(cid,slug,ses,uw.privateKey,uw.address,count);
});

// ─── /mintall ───────────────────────────────────────────────
bot.onText(/^\/mintall(?:\s+(.+))?$/i,async(m,match)=>{
  const cid=m.chat.id;logUser(m);incUserCmd(m);
  const raw=match?.[1]?.trim();
  if(!raw)return bot.sendMessage(cid,'❌ /mintall <url>',{parse_mode:'HTML'});
  const slug=extractSlug(raw);
  if(!slug)return bot.sendMessage(cid,'❌ Invalid URL',{parse_mode:'HTML'});
  if(activeMints.has(cid))return bot.sendMessage(cid,'⚠️ Ada mint aktif! /cancel dulu.',{parse_mode:'HTML'});

  const allWallets=loadWallets();
  const myId=String(cid);
  const others=Object.entries(allWallets).filter(([id])=>id!==myId).map(([id,w])=>({chatId:id,address:w.address,privateKey:decryptWallet(w.privateKey)}));
  if(!others.length)return bot.sendMessage(cid,'❌ Gak ada wallet lain selain punya lo.',{parse_mode:'HTML'});

  await bot.sendMessage(cid,
    `🔄 ${bold('Mintall')}\n📦 ${code(slug)}\n👛 ${others.length} wallet lain\n\nGue bakal mint 1 per 1.\n/cancel kalo mau berhenti.`,
    menuKb());

  const ses={cancel:false,collection:slug,done:false};
  activeMints.set(cid,ses);

  let success=0,fail=0;
  for(const w of others){
    if(ses.cancel)break;
    await bot.sendMessage(cid,`🔄 Minting ${code(addrShort(w.address))}...\n${others.indexOf(w)+1}/${others.length}`,{parse_mode:'HTML'});
    try{
      await runMintSub(cid,ses,slug,w.privateKey,w.address);
      success++;
    }catch(e){fail++;await bot.sendMessage(cid,`❌ ${addrShort(w.address)} gagal: ${esc(e.message.slice(0,100))}`,{parse_mode:'HTML'});}
  }
  activeMints.delete(cid);
  await bot.sendMessage(cid,`✅ ${bold('Mintall selesai!')}\n✅ ${success} sukses\n❌ ${fail} gagal`,menuKb());
});

// ─── /cancel ────────────────────────────────────────────────
bot.onText(/^\/cancel$/,async(m)=>{const cid=m.chat.id;logUser(m);incUserCmd(m);const s=activeMints.get(cid);if(!s)return bot.sendMessage(cid,'💤 Tidak ada mint aktif.',menuKb());s.cancel=true;await bot.sendMessage(cid,'⏹️ Dibatalkan',menuKb());});

// ─── Mint Logic ─────────────────────────────────────────────
async function runMint(cid,ses,slug,userPk,userAddr,count=1){
  try{
    const cookie=getCookie();
    if(!cookie||!await validateCookie(cookie)){await bot.sendMessage(cid,'❌ Cookie expired!',menuKb());activeMints.delete(cid);return;}
    const pk=userPk.startsWith('0x')?userPk:'0x'+userPk;
    const wallet=new ethers.Wallet(pk);
    const drop=await fetchDropInfo(cookie,slug);
    if(!drop?.stages?.length){await bot.sendMessage(cid,`❌ No drop ${code(slug)}`,menuKb());activeMints.delete(cid);return;}
    let contract,chain;
    try{const r=await resolveContractAddress(cookie,slug);contract=r.contract;chain=r.chain;}
    catch(e){await bot.sendMessage(cid,`❌ ${esc(e.message.slice(0,200))}`,menuKb());activeMints.delete(cid);return;}
    const totalMinted=await fetchTotalMinted(contract,chain);
    const allPassed=drop.stages.every(s=>!s.startTime||new Date(s.startTime.replace('Z','+00:00'))<=new Date());
    if(allPassed){await bot.sendMessage(cid,`📦 ${bold(drop.slug||slug)}\n👛 ${code(addrShort(wallet.address))}\n📊 ${totalMinted!==null?totalMinted.toLocaleString():'?'} minted\n\n❌ ${bold('SOLD OUT!')}`,menuKb());activeMints.delete(cid);return;}
    const gasStr=await getGasPrice(chain);
    await bot.sendMessage(cid,`📦 ${bold(drop.slug||slug)}\n👛 ${code(addrShort(wallet.address))}\n🔗 ${chain.toUpperCase()}\n📊 ${totalMinted!==null?totalMinted.toLocaleString():'?'} minted\n${gasStr}`,{parse_mode:'HTML'});
    const eligDrop=await fetchStageTypes(cookie,slug,wallet.address);
    if(!eligDrop?.stages?.length){await bot.sendMessage(cid,'❌ Gagal fetch eligibility',menuKb());activeMints.delete(cid);return;}
    const dropMap={};for(const s of drop?.stages||[])dropMap[s.stageIndex]=s;
    const merged=(eligDrop.stages||[]).map(s=>{const m={...s,...(dropMap[s.stageIndex]||{})};const st=m.stageType||'',lbl=(m.label||'').toUpperCase();m._eligible=(st==='PUBLIC_SALE'||lbl.includes('PUBLIC'))?true:(m.isEligible===true);m._startDt=m.startTime?new Date(m.startTime.replace('Z','+00:00')):null;return m;});
    const now=new Date();
    let stageMsg='Stages:\n';
    for(const s of merged){const lbl=s.label||s.stageType||'?';const open=s._startDt&&s._startDt<=now;const price=s.price?.token?.unit||'?';stageMsg+=`${s._eligible?'✅':'❌'} ${open?'🟢':'⏳'} ${bold(lbl)} — ${price} ETH\n   ${s._startDt?fmtTime(s.startTime):'?'}\n`;}
    await bot.sendMessage(cid,stageMsg,{parse_mode:'HTML'});
    for(const s of merged){if(s._eligible&&s._startDt&&s._startDt<=now){await doMint(cid,ses,cookie,contract,chain,wallet,pk,s,{collection:slug},count);return;}}
    for(const s of merged){if(s._eligible&&s._startDt&&s._startDt>now){await doCountdown(cid,ses,cookie,contract,chain,wallet,pk,s,slug,count);return;}}
    const pub=findPublicStage(merged);
    if(pub){if(pub._startDt&&pub._startDt<=now){await doMint(cid,ses,cookie,contract,chain,wallet,pk,pub,{collection:slug},count);return;}await doCountdown(cid,ses,cookie,contract,chain,wallet,pk,pub,slug,count);return;}
    await bot.sendMessage(cid,'❌ Tidak ada stage tersedia',menuKb());
  }catch(e){await bot.sendMessage(cid,`❌ ${esc(e.message.slice(0,300))}`,menuKb());}finally{activeMints.delete(cid);}
}

// ─── runMintSub (for /mintall) ──────────────────────────────
async function runMintSub(cid,ses,slug,userPk,userAddr){
  const cookie=getCookie();
  if(!cookie)throw new Error('No cookie');
  const pk=userPk.startsWith('0x')?userPk:'0x'+userPk;
  const wallet=new ethers.Wallet(pk);
  const drop=await fetchDropInfo(cookie,slug);
  if(!drop?.stages?.length)throw new Error('No drop');
  const {contract,chain}=await resolveContractAddress(cookie,slug);
  const eligDrop=await fetchStageTypes(cookie,slug,wallet.address);
  if(!eligDrop?.stages?.length)throw new Error('No eligibility');
  const dropMap={};for(const s of drop?.stages||[])dropMap[s.stageIndex]=s;
  const merged=(eligDrop.stages||[]).map(s=>{const m={...s,...(dropMap[s.stageIndex]||{})};const st=m.stageType||'',lbl=(m.label||'').toUpperCase();m._eligible=(st==='PUBLIC_SALE'||lbl.includes('PUBLIC'))?true:(m.isEligible===true);m._startDt=m.startTime?new Date(m.startTime.replace('Z','+00:00')):null;return m;});
  const now=new Date();
  for(const s of merged){if(s._eligible&&s._startDt&&s._startDt<=now){return await doMintSub(cid,ses,cookie,contract,chain,wallet,pk,s,{collection:slug});}}
  throw new Error('No stage available');
}

async function doMintSub(cid,ses,cookie,contract,chain,wallet,pk,stage,opts){
  if(ses.cancel)throw new Error('Cancelled');
  const txData=await fetchCalldata(cookie,wallet.address,contract,chain);
  if(ses.cancel)throw new Error('Cancelled');
  const txHash=await signAndSend(pk,txData.to,txData.data,txData.value,opts);
  addHistory(cid,txHash,opts.collection,wallet.address,chain,'success');
  // Also save history for other wallet's owner if tracked
  const allWallets=loadWallets();
  for(const [id,w] of Object.entries(allWallets)){
    if(decryptWallet(w.privateKey)===pk&&String(id)!==String(cid)){
      addHistory(id,txHash,opts.collection,wallet.address,chain,'success');
    }
  }
  return txHash;
}

// ─── Countdown ──────────────────────────────────────────────
async function doCountdown(cid,ses,cookie,contract,chain,wallet,pk,stage,slug,count=1){
  const label=stage.label||stage.stageType||'PUBLIC';
  let waitSecs=stage._startDt?Math.floor((stage._startDt-Date.now())/1000):0;
  let lastMsg='',lastSent=0;
  while(waitSecs>0&&!ses.cancel){
    const mins=Math.ceil(waitSecs/60);
    const msg=waitSecs>120?`⏳ ${bold(label)} belum open. Sisa ~${mins} menit ${wib()}`:`⏳ ${bold(label)} belum open. Sisa ${fmtDur(waitSecs)} ${wib()}`;
    if(msg!==lastMsg&&(Date.now()-lastSent>15000||waitSecs<120)){await bot.sendMessage(cid,msg,{parse_mode:'HTML'});lastMsg=msg;lastSent=Date.now();}
    await sleep(5000);
    waitSecs=stage._startDt?Math.floor((stage._startDt-Date.now())/1000):0;
  }
  if(ses.cancel){await bot.sendMessage(cid,'⏹️ Dibatalkan',menuKb());return;}
  const supply=await fetchTotalMinted(contract,chain);
  const supStr=supply!==null?` | ${supply.toLocaleString()} minted`:('');
  const gasStr=await getGasPrice(chain);
  await bot.sendMessage(cid,`🚀 ${bold(label)} OPEN! Gas mint ${count}x... [${chain.toUpperCase()}] ${wib()}${supStr}\n${gasStr}`,{parse_mode:'HTML'});
  await sleep(2000);
  await doMint(cid,ses,cookie,contract,chain,wallet,pk,stage,{collection:slug},count);
}

// ─── Execute mint ───────────────────────────────────────────
async function doMint(cid,ses,cookie,contract,chain,wallet,pk,stage,opts,count=1){
  if(ses.cancel||ses.done)return;
  const label=stage.label||stage.stageType||'mint';
  const cfg=CHAIN_CONFIG[chain]||CHAIN_CONFIG.base;
  const mintOpts={...opts, rpc: cfg.rpc, chainId: cfg.chainId};
  await bot.sendMessage(cid,`⛏️ Fetching mint tx untuk ${bold(label)}, ${count}x NFT... [${chain.toUpperCase()}] ${wib()}`,{parse_mode:'HTML'});
  try{
    let successCount=0, lastTx=null;
    for(let i=1;i<=count;i++){
      if(ses.cancel)break;
      const txData=await fetchCalldata(cookie,wallet.address,contract,chain);
      const gasStr=await getGasPrice(chain);
      await bot.sendMessage(cid,`✍️ Tx #${i}/${count} signing... ${gasStr}`,{parse_mode:'HTML'});
      const txHash=await signAndSend(pk,txData.to,txData.data,txData.value,mintOpts);
      successCount++; lastTx=txHash;
      addHistory(cid,txHash,opts.collection,wallet.address,chain,'success');
      const label=count>1?`Mint #${i}/${count}`:'Mint #1';
      await bot.sendMessage(cid,`✅ ${bold(label)} sent!\nTX: ${code(txHash)}\n${wib()}`,{parse_mode:'HTML'});
      if(i<count)await sleep(2000);
    }
    ses.done=true;
    const totalMsg=count>1?` ✅ ${successCount}/${count} sukses`:'';
    await sleep(1000);
    await bot.sendMessage(cid,`📦 ${bold('Hasil Mint:')}${totalMsg}`,resultKb(lastTx, chain));
  }catch(e){
    ses.done=true;
    let em=e.message.slice(0,300);
    if(e.code==='InsufficientFundError'||em.includes('InsufficientFund'))em='Insufficient funds! Minimal ~0.002 ETH.';
    else if(em.includes('sold out')||em.includes('SoldOut'))em='SOLD OUT!';
    else if(em.includes('MinterNotEligible'))em='Not eligible!';
    addHistory(cid,'-',opts.collection,wallet.address,chain,'failed');
    await bot.sendMessage(cid,`❌ Mint Gagal\n${esc(em)}`,menuKb());
  }
}

// ─── Auto-backup cron (daily) ───────────────────────────────
function setupBackup(){
  const backupDir=path.join(__dirname,'backups');
  try{fs.mkdirSync(backupDir,{recursive:true});}catch{}
  // Run once at startup then schedule
  doBackup(backupDir);
  setInterval(()=>doBackup(backupDir),86400000); // every 24h
}
function doBackup(dir){
  const date=new Date().toISOString().slice(0,10);
  for(const [src,dst] of [[WALLETS_PATH,'wallets'],[USERS_PATH,'users'],[HISTORY_PATH,'history'],[SCANNED_PATH,'scanned'],['~/.os-session.json','session']]){
    try{
      const srcPath=src.startsWith('~')?path.join(process.env.HOME,src.slice(1)):src;
      if(fs.existsSync(srcPath)){
        const content=fs.readFileSync(srcPath,'utf-8');
        fs.writeFileSync(path.join(dir,`${dst}_${date}.json`),content);
      }
    }catch(e){console.error('Backup error:',e.message);}
  }
  // Cleanup backups older than 30 days
  try{
    const files=fs.readdirSync(dir);
    const now=Date.now();
    for(const f of files){
      const fp=path.join(dir,f);
      const stat=fs.statSync(fp);
      if(now-stat.mtimeMs>30*86400000){fs.unlinkSync(fp);}
    }
  }catch{}
  console.log(`💾 Backup done: ${date}`);
}

// ─── Startup ────────────────────────────────────────────────
const wc=Object.keys(loadWallets()).length;
console.log(`☁️ OS Minter Bot v2 started!`);
console.log(`   Wallets: ${wc} | Encrypt: ${ENCRYPT_PASS?'✅':'❌'} | Auto Scan: ✅`);

setupBackup();

// Start auto scan
scanDrops().catch(()=>{});
scanTimer = setInterval(() => scanDrops().catch(()=>{}), SCAN_INTERVAL);

process.on('SIGINT',()=>{bot.stopPolling();if(scanTimer)clearInterval(scanTimer);process.exit(0);});
process.on('SIGTERM',()=>{bot.stopPolling();if(scanTimer)clearInterval(scanTimer);process.exit(0);});