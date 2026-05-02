import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@nomicfoundation/hardhat-foundry";
import * as dotenv from "dotenv";
dotenv.config({ path: "../.env" });

const KEY = process.env.HEDERA_OPERATOR_KEY ?? "0x" + "11".repeat(32);

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.27",
    settings: {
      optimizer: { enabled: true, runs: 1_000_000 },
      viaIR: true,
      evmVersion: "cancun",
    },
  },
  networks: {
    hederaTestnet: {
      url: process.env.HEDERA_TESTNET_RPC ?? "https://testnet.hashio.io/api",
      accounts: [KEY],
      chainId: 296,
      timeout: 180_000,
    },
    hederaMainnet: {
      url: process.env.HEDERA_MAINNET_RPC ?? "https://mainnet.hashio.io/api",
      accounts: [KEY],
      chainId: 295,
      timeout: 180_000,
    },
  },
  paths: {
    sources: "./src",
    tests: "./test/hardhat",
    cache: "./cache_hardhat",
    artifacts: "./artifacts",
  },
};

export default config;
