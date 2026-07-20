#!/usr/bin/env node
// definity-stake — Definity staking CLI.
//
// The differentiator vs. the generic `spl-stake-pool` CLI: DIRECT staking. A
// direct-stake deposit is a Sanctum `DepositSol` into the definSOL pool plus an
// SPL Memo `direct:<validatorVote>`; Definity's optimiser reads that memo and
// directs pool stake onto the validator you chose, then adds up to 3.5× matching.
// No off-the-shelf CLI adds that memo, so no other tool can direct-stake here.
//
// This is the exact transaction the definity.finance direct-stake widget builds
// (create-ATA + DepositSol + memo), signed by your local keypair instead of a
// browser wallet. Deposits are permissionless and zero-fee on this pool.
//
// Safe by default: every command SIMULATES and prints the result. Pass --broadcast
// to actually sign & send.

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { parseArgs } from 'node:util';
import {
  Connection, Keypair, PublicKey, SystemProgram,
  TransactionInstruction, TransactionMessage, VersionedTransaction,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
  createAssociatedTokenAccountIdempotentInstruction,
} from '@solana/spl-token';

// ── definSOL pool — verified on-chain (mirrors the website's deposit.ts) ──────
const SANCTUM_SPL_MULTI     = new PublicKey('SPMBzsVUuoHA4Jm6KunbsotaahvVikZs1JyTW6iJvbn');
const POOL                  = new PublicKey('Bvbu55B991evqqhLtKcyTZjzQ4EQzRUwtf9T4CcpMmPL');
const POOL_WITHDRAW_AUTH    = new PublicKey('5ugu8RogBq5ZdfGt4hKxKotRBkndiV1ndsqWCf7PBmST');
const POOL_RESERVE          = new PublicKey('G6ncaiwGJ1A5kCRkaogWbrsrEBvmmUWZr4ZhsTgAEckp');
const POOL_MANAGER_FEE      = new PublicKey('BVWVFqB9UGTqh4jFgBeTg2JjgxD7jPEAZhZPLTztx2h');
const DEFINSOL_MINT         = new PublicKey('DEF1NXSZ8Th9n28hYBayrFtx9bj1EwwTiy3mhHEB9oyA');
const MEMO_PROGRAM          = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const WSOL                  = 'So11111111111111111111111111111111111111112';
const DEPOSIT_SOL_IX        = 14; // SPL stake-pool instruction index
const LAMPORTS_PER_SOL      = 1_000_000_000;
const JUP                   = 'https://lite-api.jup.ag/swap/v1';
const SITE                  = 'https://definity.finance';
const B58_RE                = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function die(msg) { console.error(`error: ${msg}`); process.exit(1); }

function loadKeypair(path) {
  const p = (path || process.env.SOLANA_KEYPAIR || `${homedir()}/.config/solana/id.json`).replace(/^~/, homedir());
  try {
    return Keypair.fromSecretKey(Uint8Array.from(JSON.parse(readFileSync(p, 'utf8'))));
  } catch (e) {
    die(`could not load keypair from ${p} (${e.message}). Pass --keypair <path> or set SOLANA_KEYPAIR.`);
  }
}

function rpc(url) {
  return new Connection(url || process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com', 'confirmed');
}

// SanctumSplMulti DepositSol: data = u8(14) ++ u64_le(lamports). `owner` is the
// lamports source (signer) and definSOL recipient (its ATA).
function depositSolIx(owner, ata, lamports) {
  const data = Buffer.alloc(9);
  data.writeUInt8(DEPOSIT_SOL_IX, 0);
  data.writeBigUInt64LE(BigInt(lamports), 1);
  return new TransactionInstruction({
    programId: SANCTUM_SPL_MULTI,
    keys: [
      { pubkey: POOL, isSigner: false, isWritable: true },
      { pubkey: POOL_WITHDRAW_AUTH, isSigner: false, isWritable: false },
      { pubkey: POOL_RESERVE, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: POOL_MANAGER_FEE, isSigner: false, isWritable: true },
      { pubkey: POOL_MANAGER_FEE, isSigner: false, isWritable: true }, // referral = manager fee
      { pubkey: DEFINSOL_MINT, isSigner: false, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    ],
    data,
  });
}

const memoIx = (text) =>
  new TransactionInstruction({ programId: MEMO_PROGRAM, keys: [], data: Buffer.from(text, 'utf8') });

// Build + (simulate | send) a v0 transaction from a set of instructions.
async function submit(conn, signer, instructions, broadcast) {
  const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash('confirmed');
  const msg = new TransactionMessage({ payerKey: signer.publicKey, recentBlockhash: blockhash, instructions }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  tx.sign([signer]);
  if (!broadcast) {
    const { value } = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
    return { simulated: true, err: value.err, unitsConsumed: value.unitsConsumed, logs: value.logs };
  }
  const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false, maxRetries: 5 });
  await conn.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, 'confirmed');
  return { signature: sig };
}

// Poll a signature to confirmation — used for txs we didn't build the lifetime
// for (e.g. Jupiter's swap), so a `sent` result means it actually landed.
async function confirmSig(conn, signature, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { value } = await conn.getSignatureStatuses([signature]);
    const s = value[0];
    if (s?.err) throw new Error(`transaction failed on-chain: ${JSON.stringify(s.err)}`);
    if (s?.confirmationStatus === 'confirmed' || s?.confirmationStatus === 'finalized') return;
    await new Promise((r) => setTimeout(r, 1500));
  }
  throw new Error(`confirmation timed out (it may still land — check https://solscan.io/tx/${signature})`);
}

async function cmdDirectStake({ validator, amount, keypair, rpc: url, broadcast }) {
  if (!validator || !B58_RE.test(validator)) die('--validator <vote-pubkey> is required');
  const amt = Number(amount);
  if (!(amt > 0)) die('--amount <SOL> must be > 0');
  const signer = loadKeypair(keypair);
  const conn = rpc(url);
  const owner = signer.publicKey;
  const ata = getAssociatedTokenAddressSync(DEFINSOL_MINT, owner, true);
  const ixs = [
    createAssociatedTokenAccountIdempotentInstruction(owner, ata, owner, DEFINSOL_MINT),
    depositSolIx(owner, ata, Math.round(amt * LAMPORTS_PER_SOL)),
    memoIx(`direct:${validator}`),
  ];
  console.log(`direct-stake ${amt} SOL from ${owner.toBase58()} → validator ${validator}`);
  console.log(`  (deposit SOL → definSOL, tagged \`direct:${validator}\`; directed at the next optimiser cycle, + up to 3.5× matching)`);
  const r = await submit(conn, signer, ixs, broadcast);
  report(r);
}

async function cmdStake({ amount, keypair, rpc: url, broadcast }) {
  const amt = Number(amount);
  if (!(amt > 0)) die('--amount <SOL> must be > 0');
  const signer = loadKeypair(keypair);
  const conn = rpc(url);
  const owner = signer.publicKey;
  const ata = getAssociatedTokenAddressSync(DEFINSOL_MINT, owner, true);
  const ixs = [
    createAssociatedTokenAccountIdempotentInstruction(owner, ata, owner, DEFINSOL_MINT),
    depositSolIx(owner, ata, Math.round(amt * LAMPORTS_PER_SOL)),
  ];
  console.log(`liquid-stake ${amt} SOL from ${owner.toBase58()} → definSOL (no direction, no matching)`);
  report(await submit(conn, signer, ixs, broadcast));
}

async function cmdUnstake({ amount, keypair, rpc: url, broadcast }) {
  const amt = Number(amount);
  if (!(amt > 0)) die('--amount <definSOL> must be > 0');
  const signer = loadKeypair(keypair);
  const conn = rpc(url);
  const lamports = Math.round(amt * LAMPORTS_PER_SOL);
  const q = await fetch(`${JUP}/quote?inputMint=${DEFINSOL_MINT.toBase58()}&outputMint=${WSOL}&amount=${lamports}&slippageBps=50`).then((r) => r.json());
  if (!q?.outAmount) die('no swap route for that amount');
  const outSol = Number(q.outAmount) / LAMPORTS_PER_SOL;
  const { swapTransaction } = await fetch(`${JUP}/swap`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ quoteResponse: q, userPublicKey: signer.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true }),
  }).then((r) => r.json());
  if (!swapTransaction) die('Jupiter did not return a swap transaction');
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
  tx.sign([signer]);
  console.log(`unstake ${amt} definSOL → ~${outSol.toFixed(4)} SOL (Jupiter swap, ${(Number(q.priceImpactPct) * 100).toFixed(3)}% impact)`);
  if (!broadcast) {
    const { value } = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
    return report({ simulated: true, err: value.err, unitsConsumed: value.unitsConsumed });
  }
  const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 5 });
  console.log('  submitted — confirming…');
  await confirmSig(conn, sig);
  report({ signature: sig });
}

async function cmdBalance({ wallet, keypair, rpc: url }) {
  const addr = wallet || loadKeypair(keypair).publicKey.toBase58();
  const conn = rpc(url);
  const accts = await conn.getParsedTokenAccountsByOwner(new PublicKey(addr), { mint: DEFINSOL_MINT });
  const held = accts.value.reduce((a, x) => a + (x.account.data.parsed.info.tokenAmount.uiAmount || 0), 0);
  console.log(`wallet ${addr}\n  definSOL held: ${held}`);
  try {
    const d = await fetch(`${SITE}/api/direct-stake/balance?wallet=${addr}`).then((r) => (r.ok ? r.json() : null));
    for (const p of d?.positions ?? []) {
      console.log(`  → ${p.name || p.vote}: principal ${p.principalSol} · matched ${p.matchedPlannedSol} · pending ${p.pendingMatchSol} · deployed ${p.matchedDeployedSol}`);
    }
  } catch { /* directed view unavailable */ }
}

async function cmdValidators({ query }) {
  const d = await fetch(`${SITE}/validators.json`).then((r) => r.json());
  const vs = (d.validators ?? []).filter((v) => !query || `${v.name} ${v.vote} ${v.city} ${v.country}`.toLowerCase().includes(query.toLowerCase()));
  console.log(`${vs.length} vetted validator(s):`);
  for (const v of vs.slice(0, 40)) console.log(`  ${v.vote}  ${v.name || ''} ${v.city ? '· ' + v.city : ''}`);
}

function report(r) {
  if (r.signature) { console.log(`  ✅ sent: https://solscan.io/tx/${r.signature}`); return; }
  if (r.err) { console.log(`  ✗ simulation failed: ${JSON.stringify(r.err)}`); process.exitCode = 2; return; }
  console.log(`  ✓ simulation OK (${r.unitsConsumed ?? '?'} CU). Re-run with --broadcast to send.`);
}

const HELP = `definity-stake — Definity staking CLI

Commands:
  direct-stake --validator <vote> --amount <SOL>   deposit, directed to a validator (+ up to 3.5× matching)
  stake        --amount <SOL>                       plain liquid-stake (definSOL, no direction)
  unstake      --amount <definSOL>                  redeem definSOL → SOL (Jupiter, redeems at ~NAV)
  balance      [--wallet <addr>]                    definSOL held + directed positions
  validators   [--query <text>]                     list Definity's vetted validator set

Options:
  --keypair <path>   signer (default: $SOLANA_KEYPAIR or ~/.config/solana/id.json)
  --rpc <url>        RPC endpoint (default: $SOLANA_RPC or mainnet-beta)
  --broadcast        actually sign & send (default: simulate only)

Examples:
  definity-stake validators --query stakecraft
  definity-stake direct-stake --validator BDn3HiXMTym7ZQofWFxDb7ZGQX6GomQzJYKfytTAqd5g --amount 1
  definity-stake direct-stake --validator BDn3Hi… --amount 1 --broadcast
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    validator: { type: 'string' }, amount: { type: 'string' }, keypair: { type: 'string' },
    rpc: { type: 'string' }, wallet: { type: 'string' }, query: { type: 'string' },
    broadcast: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  },
});
const cmd = positionals[0];
if (values.help || !cmd) { console.log(HELP); process.exit(0); }

const commands = { 'direct-stake': cmdDirectStake, stake: cmdStake, unstake: cmdUnstake, balance: cmdBalance, validators: cmdValidators };
const run = commands[cmd];
if (!run) die(`unknown command "${cmd}". Run --help.`);
run(values).catch((e) => die(e.message));
