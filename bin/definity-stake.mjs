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
  TOKEN_PROGRAM_ID, ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync,
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

// The exact production direct-stake instruction set — create-ATA (idempotent) +
// SanctumSplMulti DepositSol + SPL Memo `direct:<vote>`. Shared by the signed and
// the build-only (--owner) paths, so the UNSIGNED transaction a treasury verifies
// is byte-identical to the one that ultimately gets signed and broadcast.
function directStakeIxs(owner, validator, lamports) {
  const ata = getAssociatedTokenAddressSync(DEFINSOL_MINT, owner, true);
  const ixs = [
    createAssociatedTokenAccountIdempotentInstruction(owner, ata, owner, DEFINSOL_MINT),
    depositSolIx(owner, ata, lamports),
    memoIx(`direct:${validator}`),
  ];
  return { ata, ixs };
}

// Build-only: compile an UNSIGNED v0 transaction, decode it for verification, and
// emit base64 for offline signing (Ledger / air-gapped / Squads multisig). No
// private key is loaded or used. With --blockhash it builds fully offline (no RPC,
// no simulation). Signatures are left as zero placeholders for the offline signer.
async function emitUnsigned(conn, owner, ixs, { validator, amt, lamports, ata, blockhash }) {
  const offline = !!blockhash;
  let bh = blockhash, lastValid = null;
  if (!offline) {
    const r = await conn.getLatestBlockhash('confirmed');
    bh = r.blockhash; lastValid = r.lastValidBlockHeight;
  }
  const msg = new TransactionMessage({ payerKey: owner, recentBlockhash: bh, instructions: ixs }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  const b64 = Buffer.from(tx.serialize()).toString('base64');

  console.log('build-only direct-stake — UNSIGNED transaction (no private key was loaded)\n');
  console.log(`  fee payer / owner :  ${owner.toBase58()}`);
  console.log(`  amount            :  ${amt} SOL   (${lamports} lamports)`);
  console.log(`  definSOL recipient:  ${ata.toBase58()}   (owner's associated token account)`);
  console.log(`  direct memo       :  "direct:${validator}"`);
  console.log(`  recent blockhash  :  ${bh}${lastValid != null ? `   (valid to block ${lastValid}; ~60–90s — refresh in your signer if it expires)` : '   (supplied via --blockhash)'}`);
  console.log('\n  instructions (verify these against your own decode of the base64 below):');
  console.log(`    1. create ATA (idempotent)   ${ASSOCIATED_TOKEN_PROGRAM_ID.toBase58()}   → ${ata.toBase58()} for owner, mint definSOL`);
  console.log(`    2. DepositSol (ix ${DEPOSIT_SOL_IX})          ${SANCTUM_SPL_MULTI.toBase58()}   → ${amt} SOL into pool ${POOL.toBase58()}`);
  console.log(`    3. memo                      ${MEMO_PROGRAM.toBase58()}   → "direct:${validator}"`);

  if (!offline) {
    const { value } = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
    if (value.err) { console.log(`\n  ✗ simulation failed: ${JSON.stringify(value.err)}`); process.exitCode = 2; }
    else console.log(`\n  ✓ simulation OK (${value.unitsConsumed ?? '?'} CU) — the accounts + memo above are exactly what will execute.`);
  } else {
    console.log('\n  (offline: simulation skipped — no RPC. Decode the base64 in your own tooling to verify.)');
  }
  console.log(`\n--- unsigned transaction (base64) ---\n${b64}\n--- end unsigned transaction ---`);
  console.log(`\nSign as ${owner.toBase58()} on your offline / hardware / multisig signer, then broadcast.`);
}

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

async function cmdDirectStake({ validator, amount, keypair, owner: ownerArg, rpc: url, blockhash, broadcast }) {
  if (!validator || !B58_RE.test(validator)) die('--validator <vote-pubkey> is required');
  const amt = Number(amount);
  if (!(amt > 0)) die('--amount <SOL> must be > 0');
  const lamports = Math.round(amt * LAMPORTS_PER_SOL);

  // Build-only (treasury / hardware / air-gapped / multisig): --owner <pubkey>,
  // no private key is loaded. Emits an UNSIGNED transaction to verify + sign offline.
  if (ownerArg) {
    if (!B58_RE.test(ownerArg)) die('--owner <pubkey> is not a valid address');
    if (broadcast) die('--owner is build-only (there is no key to sign) — drop --broadcast; sign & submit the emitted transaction offline');
    const owner = new PublicKey(ownerArg);
    const { ata, ixs } = directStakeIxs(owner, validator, lamports);
    await emitUnsigned(rpc(url), owner, ixs, { validator, amt, lamports, ata, blockhash });
    return;
  }

  // Signed path (local keypair).
  const signer = loadKeypair(keypair);
  const { ixs } = directStakeIxs(signer.publicKey, validator, lamports);
  console.log(`direct-stake ${amt} SOL from ${signer.publicKey.toBase58()} → validator ${validator}`);
  console.log(`  (deposit SOL → definSOL, tagged \`direct:${validator}\`; directed at the next optimiser cycle, + up to 3.5× matching)`);
  report(await submit(rpc(url), signer, ixs, broadcast));
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

// Core unstake: redeem `definsolLamports` (base units) of definSOL → SOL via a
// Jupiter swap. Shared by `unstake` (an amount) and `unstake-all` (full balance).
async function doUnstake(conn, signer, definsolLamports, broadcast) {
  const q = await fetch(`${JUP}/quote?inputMint=${DEFINSOL_MINT.toBase58()}&outputMint=${WSOL}&amount=${definsolLamports}&slippageBps=50`).then((r) => r.json());
  if (!q?.outAmount) die('no swap route for that amount');
  const inDef = definsolLamports / LAMPORTS_PER_SOL;
  const outSol = Number(q.outAmount) / LAMPORTS_PER_SOL;
  const { swapTransaction } = await fetch(`${JUP}/swap`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ quoteResponse: q, userPublicKey: signer.publicKey.toBase58(), wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true }),
  }).then((r) => r.json());
  if (!swapTransaction) die('Jupiter did not return a swap transaction');
  const tx = VersionedTransaction.deserialize(Buffer.from(swapTransaction, 'base64'));
  tx.sign([signer]);
  console.log(`unstake ${inDef} definSOL → ~${outSol.toFixed(4)} SOL (Jupiter swap, ${(Number(q.priceImpactPct) * 100).toFixed(3)}% impact)`);
  if (!broadcast) {
    const { value } = await conn.simulateTransaction(tx, { sigVerify: false, replaceRecentBlockhash: true });
    return report({ simulated: true, err: value.err, unitsConsumed: value.unitsConsumed });
  }
  const sig = await conn.sendRawTransaction(tx.serialize(), { maxRetries: 5 });
  console.log('  submitted — confirming…');
  await confirmSig(conn, sig);
  report({ signature: sig });
}

// Full definSOL balance held by `owner`, in base units (exact — avoids dust).
async function definsolBalanceLamports(conn, owner) {
  const accts = await conn.getParsedTokenAccountsByOwner(owner, { mint: DEFINSOL_MINT });
  return accts.value.reduce((a, x) => a + Number(x.account.data.parsed.info.tokenAmount.amount), 0);
}

async function cmdUnstake({ amount, keypair, rpc: url, broadcast }) {
  const amt = Number(amount);
  if (!(amt > 0)) die('--amount <definSOL> must be > 0 (or use `unstake-all`)');
  const signer = loadKeypair(keypair);
  await doUnstake(rpc(url), signer, Math.round(amt * LAMPORTS_PER_SOL), broadcast);
}

async function cmdUnstakeAll({ keypair, rpc: url, broadcast }) {
  const signer = loadKeypair(keypair);
  const conn = rpc(url);
  const lamports = await definsolBalanceLamports(conn, signer.publicKey);
  if (lamports <= 0) die('no definSOL held — nothing to unstake');
  console.log(`unstake-all: full balance of ${lamports / LAMPORTS_PER_SOL} definSOL from ${signer.publicKey.toBase58()}`);
  await doUnstake(conn, signer, lamports, broadcast);
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
  unstake      --amount <definSOL>                  redeem some definSOL → SOL (Jupiter, redeems at ~NAV)
  unstake-all                                        redeem your ENTIRE definSOL balance → SOL (no dust)
  balance      [--wallet <addr>]                    definSOL held + directed positions
  validators   [--query <text>]                     list Definity's vetted validator set

Options:
  --keypair <path>   signer (default: $SOLANA_KEYPAIR or ~/.config/solana/id.json)
  --rpc <url>        RPC endpoint (default: $SOLANA_RPC or mainnet-beta)
  --broadcast        actually sign & send (default: simulate only)

Build-only (treasuries / hardware / multisig — NO private key is loaded):
  direct-stake --validator <vote> --amount <SOL> --owner <pubkey>
    Prints a full decode (owner, amount, ATA, direct: memo, blockhash), simulates
    it unsigned, and emits an UNSIGNED base64 transaction to verify + sign offline
    (Ledger / air-gapped / Squads). Add --blockhash <hash> to build fully offline
    (skips the RPC fetch + simulation).

Examples:
  definity-stake validators --query <name-or-city>
  definity-stake direct-stake --validator <validatorVote> --amount 1
  definity-stake direct-stake --validator <validatorVote> --amount 1 --broadcast
  definity-stake direct-stake --validator <validatorVote> --amount 1 --owner <treasuryPubkey>   # unsigned
`;

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    validator: { type: 'string' }, amount: { type: 'string' }, keypair: { type: 'string' },
    owner: { type: 'string' }, blockhash: { type: 'string' },
    rpc: { type: 'string' }, wallet: { type: 'string' }, query: { type: 'string' },
    broadcast: { type: 'boolean' }, help: { type: 'boolean', short: 'h' },
  },
});
const cmd = positionals[0];
if (values.help || !cmd) { console.log(HELP); process.exit(0); }

const commands = { 'direct-stake': cmdDirectStake, stake: cmdStake, unstake: cmdUnstake, 'unstake-all': cmdUnstakeAll, balance: cmdBalance, validators: cmdValidators };
const run = commands[cmd];
if (!run) die(`unknown command "${cmd}". Run --help.`);
run(values).catch((e) => die(e.message));
