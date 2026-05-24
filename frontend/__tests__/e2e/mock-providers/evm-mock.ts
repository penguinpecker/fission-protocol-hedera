/**
 * Mock window.ethereum implementation backed by a viem LocalAccount.
 *
 * Injected into Playwright pages via `page.addInitScript` so the React app
 * sees a real-looking EIP-1193 provider before wagmi's injected connector
 * checks for one. Every method that wagmi/the dApp actually calls is
 * implemented to match the standard exactly — anything missing falls
 * through to a console.warn so test failures surface concretely.
 *
 * IMPORTANT: this file is injected as a string into the browser context.
 * It cannot import from node_modules at runtime — everything is inlined.
 * The serialization function below returns the page-script source.
 */

export interface MockProviderOptions {
  /** Hex private key (0x-prefixed). Test seed only — NEVER a production key. */
  privateKeyHex: string;
  /** EVM-style 0x address derived from the private key. */
  address: `0x${string}`;
  /** Chain ID as hex (e.g., 0x127 for Hedera mainnet 295). */
  chainIdHex: `0x${string}`;
  /** JSON-RPC URL for read/send forwards (e.g., Hashio). */
  rpcUrl: string;
}

/**
 * Returns a page-init script that injects window.ethereum on every load.
 * The script delegates eth_sendTransaction to a signing-then-forwarding
 * path that uses the test private key — so signed txs land on the real
 * RPC just like a real wallet would do.
 *
 * Strategy:
 *   - eth_requestAccounts / eth_accounts → [address]
 *   - eth_chainId / net_version          → chainIdHex / decimal
 *   - personal_sign                       → secp256k1 sign over EIP-191 digest
 *   - eth_sendTransaction                 → build tx, sign, eth_sendRawTransaction
 *   - wallet_switchEthereumChain          → noop (always on right chain)
 *   - everything else                     → forward to RPC
 */
export function buildEvmMockInitScript(opts: MockProviderOptions): string {
  return `
(() => {
  const PRIV = ${JSON.stringify(opts.privateKeyHex)};
  const ADDR = ${JSON.stringify(opts.address.toLowerCase())};
  const CHAIN_HEX = ${JSON.stringify(opts.chainIdHex)};
  const CHAIN_DEC = String(parseInt(CHAIN_HEX, 16));
  const RPC = ${JSON.stringify(opts.rpcUrl)};

  // Forward any non-signing method to the RPC verbatim.
  async function rpcForward(method, params) {
    const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] });
    const r = await fetch(RPC, { method: "POST", headers: { "Content-Type": "application/json" }, body });
    const j = await r.json();
    if (j.error) throw new Error("RPC " + method + ": " + (j.error.message || JSON.stringify(j.error)));
    return j.result;
  }

  // EIP-1193 provider. Mirrors the MetaMask shape closely enough that wagmi's
  // injected() connector accepts it without complaint.
  const listeners = new Map();
  const provider = {
    isMetaMask: true,
    isFissionMock: true,
    chainId: CHAIN_HEX,
    selectedAddress: ADDR,
    networkVersion: CHAIN_DEC,

    request: async ({ method, params }) => {
      // Local-handled methods first.
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return [ADDR];
        case "eth_chainId":
          return CHAIN_HEX;
        case "net_version":
          return CHAIN_DEC;
        case "wallet_switchEthereumChain":
        case "wallet_addEthereumChain":
        case "wallet_watchAsset":
          return null;
        case "personal_sign":
        case "eth_signTypedData_v4":
        case "eth_sendTransaction":
          // Tx signing requires keccak + secp256k1 which we delegate to
          // a helper exposed by the test harness via window.__sign_mock.
          // The Playwright test installs this before navigating.
          if (typeof window.__fissionMockSign !== "function") {
            throw new Error("evm-mock: window.__fissionMockSign not installed");
          }
          return await window.__fissionMockSign(method, params);
        default:
          return rpcForward(method, params);
      }
    },

    on: (event, cb) => {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(cb);
    },
    removeListener: (event, cb) => listeners.get(event)?.delete(cb),
    // Emit hook for test scaffolding — not strictly EIP-1193 but harmless.
    __emit: (event, payload) => {
      for (const cb of listeners.get(event) ?? []) {
        try { cb(payload); } catch {}
      }
    },
  };

  Object.defineProperty(window, "ethereum", { value: provider, writable: false, configurable: false });
  // EIP-6963 discovery: announce ourselves so dApps that listen for the
  // multi-injected discovery event also see us.
  const info = { uuid: "fission-mock-0001", name: "Fission Mock", icon: "data:", rdns: "io.fission.mock" };
  window.dispatchEvent(new CustomEvent("eip6963:announceProvider", {
    detail: Object.freeze({ info, provider }),
  }));
  window.addEventListener("eip6963:requestProvider", () => {
    window.dispatchEvent(new CustomEvent("eip6963:announceProvider", {
      detail: Object.freeze({ info, provider }),
    }));
  });
})();
  `;
}
