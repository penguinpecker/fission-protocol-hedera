# HashScan UI verification bundles

Each subdirectory contains a `standard-input.json` you can upload to HashScan's manual UI verifier and an `UPLOAD.md` with per-contract steps.

Why this exists: HashScan's auto-verify (Sourcify) can't reproduce Foundry's `via_ir` output bit-for-bit. Manual UI accepts the standard JSON we dump here.

| Contract | Address | Bundle |
|----------|---------|--------|
| ActionRouter | `0x00000000000000000000000000000000009fd993` | [ActionRouter/](ActionRouter/UPLOAD.md) (52 KB JSON) |
| FissionFactory | `0x00000000000000000000000000000000009fb0b3` | [FissionFactory/](FissionFactory/UPLOAD.md) (317 KB JSON) |
| StandardMarketDeployer | `0x00000000000000000000000000000000009fb0af` | [StandardMarketDeployer/](StandardMarketDeployer/UPLOAD.md) (270 KB JSON) |
| RewardsMarketDeployer | `0x00000000000000000000000000000000009fb0b1` | [RewardsMarketDeployer/](RewardsMarketDeployer/UPLOAD.md) (269 KB JSON) |
| SY_SaucerSwapV2LP | `0x00000000000000000000000000000000009fb089` | [SY_SaucerSwapV2LP/](SY_SaucerSwapV2LP/UPLOAD.md) (262 KB JSON) |
| FissionMarketRewards | `0xfa903b938b3bbb0d2836010e5f45edc95fd08a6d` | [FissionMarketRewards/](FissionMarketRewards/UPLOAD.md) (268 KB JSON) |
| FissionZap | `0x00000000000000000000000000000000009fd984` | [FissionZap/](FissionZap/UPLOAD.md) (9 KB JSON) |

Regenerate with: `node scripts/prep-hashscan-verify.mjs` after `forge build`.
