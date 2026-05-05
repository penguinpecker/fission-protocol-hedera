# RewardsMarketDeployer — HashScan UI verification

| Field | Value |
|-------|-------|
| Contract address (EVM) | `0x00000000000000000000000000000000009fb0b1` |
| Contract name          | `RewardsMarketDeployer` |
| Compiler               | Solidity `v0.8.27+commit.40a35a09` |
| Optimizer              | enabled, runs = 200 |
| EVM version            | `cancun` |
| viaIR                  | `true` |
| Bytecode hash          | `none` |
| License                | MIT |


## Steps

1. Open HashScan: https://hashscan.io/mainnet/contract/0x00000000000000000000000000000000009fb0b1
2. Click **Verify** → choose **Standard JSON Input**.
3. Compiler version: `v0.8.27+commit.40a35a09` (set the dropdown to match exactly).
4. Contract name: `RewardsMarketDeployer`.
5. **Upload** `audits/hashscan/RewardsMarketDeployer/standard-input.json` (this file's sibling).
6. Constructor args: see "Constructor args" below — paste hex (without 0x) if asked.
7. Submit. HashScan will recompile and match against deployed bytecode.

## Constructor args

Constructor args are NOT included in this bundle — HashScan auto-extracts them from the deployed bytecode tail. If the UI asks anyway, refer to:

- `scripts/deploy-mainnet.mjs` and `scripts/deploy-mainnet-sdk.mjs` for the constructor calls used.
- The transaction hash that created `0x00000000000000000000000000000000009fb0b1` (visible on HashScan) — its input data tail is the abi-encoded args.

## Reproducing locally

```sh
cd contracts && forge build
```

The artifact at `contracts/out/RewardsMarketDeployer.sol/RewardsMarketDeployer.json` is what produced this bundle. The `rawMetadata` field there is the source-of-truth metadata; this bundle is a byte-stable derivation.
