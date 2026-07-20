# definity-stake

A command-line staking tool for [Definity](https://definity.finance) — for treasuries, validators, and scripts that stake from a keypair instead of a browser.

Its point of difference over the generic `spl-stake-pool` CLI is **direct staking**: a deposit that routes pool stake onto a validator *you* choose, then earns up to 3.5× matching on top. That works by attaching a `direct:<validatorVote>` memo to the deposit — something no off-the-shelf stake-pool CLI does — so this is the only tool that can direct-stake into the definSOL pool.

It builds the exact transaction the definity.finance direct-stake widget builds (create-ATA + Sanctum `DepositSol` + the `direct:` memo), signed by your local keypair. Deposits are permissionless and zero-fee on the pool.

## Install

```bash
git clone <this-repo> && cd definity-stake-cli && npm install
./bin/definity-stake.mjs --help
# or link it: npm link  → then `definity-stake …`
```

Requires Node ≥ 18.

## Usage

```
definity-stake <command> [options]

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
```

**Safe by default.** Every command *simulates* the transaction and prints the result. Add `--broadcast` to sign and send for real.

## Examples

```bash
# Find a validator to back
definity-stake validators --query stakecraft

# Dry-run a 1 SOL direct stake (simulates, no funds move)
definity-stake direct-stake \
  --validator BDn3HiXMTym7ZQofWFxDb7ZGQX6GomQzJYKfytTAqd5g --amount 1

# Send it
definity-stake direct-stake \
  --validator BDn3HiXMTym7ZQofWFxDb7ZGQX6GomQzJYKfytTAqd5g --amount 1 --broadcast

# Check what you hold + what's directed
definity-stake balance

# Exit: redeem 5 definSOL back to SOL
definity-stake unstake --amount 5 --broadcast
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
