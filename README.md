# definity-stake

[![npm](https://img.shields.io/npm/v/@definity/stake.svg)](https://www.npmjs.com/package/@definity/stake)

A command-line staking tool for [Definity](https://definity.finance) — for treasuries, validators, and scripts that stake from a keypair instead of a browser.

Its point of difference over the generic `spl-stake-pool` CLI is **direct staking**: a deposit that routes pool stake onto a validator *you* choose, then earns up to 3.5× matching on top. That works by attaching a `direct:<validatorVote>` memo to the deposit — something no off-the-shelf stake-pool CLI does — so this is the only tool that can direct-stake into the definSOL pool.

It builds the exact transaction the definity.finance direct-stake widget builds (create-ATA + Sanctum `DepositSol` + the `direct:` memo), signed by your local keypair. Deposits are permissionless and zero-fee on the pool.

## Install

Published on npm as **[`@definity/stake`](https://www.npmjs.com/package/@definity/stake)**. Requires Node ≥ 18.

Run it without installing anything:

```bash
npx @definity/stake --help
```

Or install it globally to get a `definity-stake` command on your PATH:

```bash
npm install -g @definity/stake
definity-stake --help
```

<details>
<summary>From source</summary>

```bash
git clone https://github.com/esterhuizen/definity-stake-cli.git
cd definity-stake-cli && npm install
./bin/definity-stake.mjs --help    # or `npm link` → then `definity-stake …`
```
</details>

## Usage

The command is `definity-stake` when installed globally, or `npx @definity/stake` without installing — identical otherwise.

```
definity-stake <command> [options]

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
```

**Safe by default.** Every command *simulates* the transaction and prints the result. Add `--broadcast` to sign and send for real.

## Treasuries, hardware wallets & multisig (offline signing)

For a treasury you should never hand a raw key to a CLI. Pass **`--owner <pubkey>`** instead of a keypair and `direct-stake` runs in **build-only** mode: **no private key is loaded**, and it prints a full decode plus an **unsigned, serialized transaction (base64)** for you to verify and sign offline (Ledger, air-gapped, or a Squads multisig).

```bash
definity-stake direct-stake \
  --validator <validatorVote> --amount 1 \
  --owner <yourTreasuryPubkey>
```

It emits:

- a human-readable decode — fee payer/owner, amount, the definSOL recipient ATA, the exact `direct:<vote>` memo, the recent blockhash, and each instruction (create-ATA · Sanctum `DepositSol` ix 14 · memo);
- a **simulation** of the *unsigned* transaction (`sigVerify` off) so you can see it lands before signing;
- the **base64 unsigned transaction**, which you can independently decode to confirm the accounts, amount and memo, then sign offline and broadcast.

The instruction set is **byte-identical** to the signed path (both build from the same code), so what you verify is what executes. The recent blockhash expires in ~60–90s — refresh it in your signer if needed, or build fully offline with **`--blockhash <hash>`** (skips the RPC fetch and simulation).

> **Reproducibility.** Dependencies are pinned to exact versions and the `package-lock.json` is committed. Each release is a git tag (e.g. `v0.3.0`) — build from the tag for a verifiable, reproducible install.

## Examples

```bash
# Find a validator to back (filter the vetted set by name, city, or country)
definity-stake validators --query <name-or-city>

# Dry-run a 1 SOL direct stake (simulates, no funds move)
definity-stake direct-stake \
  --validator <validatorVote> --amount 1

# Send it
definity-stake direct-stake \
  --validator <validatorVote> --amount 1 --broadcast

# Treasury: build an UNSIGNED tx to verify + sign offline (no key loaded)
definity-stake direct-stake \
  --validator <validatorVote> --amount 1 --owner <treasuryPubkey>

# Check what you hold + what's directed
definity-stake balance

# Exit: redeem 5 definSOL back to SOL
definity-stake unstake --amount 5 --broadcast

# Full exit: redeem your entire definSOL balance (exact, no dust left over)
definity-stake unstake-all --broadcast
```

## How direct staking settles

1. Your deposit mints definSOL to your wallet and carries the `direct:<vote>` memo.
2. Definity's optimiser reads the memo and directs your 1× principal onto that validator at the next cycle.
3. Once the deposit has been held a full epoch, up to 3.5× matching is added on top — up to 4.5× total, capped at 20,000 SOL/validator.
4. To exit, `unstake` swaps your definSOL back to SOL (redeems at ~NAV; the directed stake unwinds with your holdings).

Your funds and definSOL stay in your wallet the whole time — Definity never custodies them.

## Pool facts

- Pool: `Bvbu55B991evqqhLtKcyTZjzQ4EQzRUwtf9T4CcpMmPL` (Sanctum `SanctumSplMulti`, program `SPMBzs…`)
- definSOL mint: `DEF1NXSZ8Th9n28hYBayrFtx9bj1EwwTiy3mhHEB9oyA`
- `DepositSol` is permissionless and currently zero-fee.

> Prototype. Simulate first; you are responsible for your keys and transactions.
