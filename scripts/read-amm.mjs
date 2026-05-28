import { createPublicClient, http } from "viem";
const chain = { id: 295, name: "Hedera", nativeCurrency: { decimals: 18, symbol: "HBAR", name: "HBAR" }, rpcUrls: { default: { http: ["https://mainnet.hashio.io/api"] } } };
const pub = createPublicClient({ chain, transport: http() });
const abi = [
  { type: "function", name: "ptAmmRewardIndex", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "ytAmmRewardIndex", inputs: [], outputs: [{ type: "uint256" }], stateMutability: "view" },
  { type: "function", name: "lastLnImpliedRate", inputs: [], outputs: [{ type: "int256" }], stateMutability: "view" },
  { type: "function", name: "treasury", inputs: [], outputs: [{ type: "address" }], stateMutability: "view" },
];
const mkt = "0xfecfc0bb57dd668ff37f2a232b208584e5feae53";
const [pt, yt, lr, tr] = await Promise.all([
  pub.readContract({address: mkt, abi, functionName: "ptAmmRewardIndex"}),
  pub.readContract({address: mkt, abi, functionName: "ytAmmRewardIndex"}),
  pub.readContract({address: mkt, abi, functionName: "lastLnImpliedRate"}),
  pub.readContract({address: mkt, abi, functionName: "treasury"}),
]);
console.log("ptAmmRewardIndex:", pt.toString());
console.log("ytAmmRewardIndex:", yt.toString());
console.log("treasury:        ", tr);
console.log("APY:             ", ((Math.exp(Number(lr)/1e18)-1)*100).toFixed(2), "%");
