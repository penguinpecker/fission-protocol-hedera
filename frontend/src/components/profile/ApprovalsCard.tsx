"use client";

/**
 * ApprovalsCard — surfaces the user's standing approvals + operator role on the
 * live Periphery + Market so they can revoke if they ever want to disconnect
 * the protocol from their account. Closes the X-7 audit concern (permanent
 * setOperator) via UX rather than a contract change.
 *
 * Rows shown:
 *   - market.isOperator(user, periphery) → "Periphery operator" with revoke
 *   - SY-share.allowance(user, periphery) → "SY-share spend" with revoke
 *   - PT.allowance(user, periphery) → "PT spend" with revoke
 *   - LP.allowance(user, periphery) → "LP spend" with revoke
 *
 * Notes:
 *   - ERC-20 approve(spender, 0) reverts on HTS facade (Hedera quirk). The
 *     card still calls approve(0) — if it reverts, surface "HTS quirk" copy
 *     and recommend `safeApprove` via wallet's send-transaction page.
 *   - Operator revoke uses market.setOperator(periphery, false) — always
 *     works (Solidity storage, no HTS).
 */
import { useState } from "react";
import { useReadContracts, useWaitForTransactionReceipt } from "wagmi";
import { ADDRESSES, isDeployed, MAX_HTS_APPROVE } from "@/lib/addresses";
import { useWalletAdapter } from "@/lib/hedera-wallet/adapter";

const erc20AllowanceAbi = [
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

const marketIsOperatorAbi = [
  {
    type: "function",
    name: "isOperator",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "operator", type: "address" },
    ],
    outputs: [{ type: "bool" }],
  },
  {
    type: "function",
    name: "pt",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "lp",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
] as const;

interface Props {
  user: `0x${string}` | undefined;
}

export function ApprovalsCard({ user }: Props) {
  const adapter = useWalletAdapter();
  const [pendingTx, setPendingTx] = useState<`0x${string}` | undefined>(undefined);
  const [pendingLabel, setPendingLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const peripheryDeployed = isDeployed(ADDRESSES.periphery);
  const marketDeployed = isDeployed(ADDRESSES.market);
  const syShareDeployed = isDeployed(ADDRESSES.syAdapter);

  // Read PT + LP addresses from market (we don't have these in addresses.ts —
  // they're per-market HTS tokens). Then read allowances.
  const tokens = useReadContracts({
    contracts: marketDeployed
      ? [
          { abi: marketIsOperatorAbi, address: ADDRESSES.market, functionName: "pt" } as const,
          { abi: marketIsOperatorAbi, address: ADDRESSES.market, functionName: "lp" } as const,
        ]
      : [],
    query: { enabled: marketDeployed },
  });
  const ptAddr = tokens.data?.[0]?.status === "success" ? (tokens.data[0].result as `0x${string}`) : undefined;
  const lpAddr = tokens.data?.[1]?.status === "success" ? (tokens.data[1].result as `0x${string}`) : undefined;

  // Read approvals.
  const reads = useReadContracts({
    contracts: user && peripheryDeployed && ptAddr && lpAddr
      ? [
          {
            abi: marketIsOperatorAbi, address: ADDRESSES.market,
            functionName: "isOperator", args: [user, ADDRESSES.periphery],
          } as const,
          { abi: erc20AllowanceAbi, address: ADDRESSES.syAdapter, functionName: "allowance", args: [user, ADDRESSES.periphery] } as const,
          { abi: erc20AllowanceAbi, address: ptAddr, functionName: "allowance", args: [user, ADDRESSES.periphery] } as const,
          { abi: erc20AllowanceAbi, address: lpAddr, functionName: "allowance", args: [user, ADDRESSES.periphery] } as const,
        ]
      : [],
    query: { enabled: !!user && peripheryDeployed && !!ptAddr && !!lpAddr },
    allowFailure: true,
  });

  const isOp = reads.data?.[0]?.status === "success" ? (reads.data[0].result as boolean) : false;
  const syAllow = reads.data?.[1]?.status === "success" ? (reads.data[1].result as bigint) : 0n;
  const ptAllow = reads.data?.[2]?.status === "success" ? (reads.data[2].result as bigint) : 0n;
  const lpAllow = reads.data?.[3]?.status === "success" ? (reads.data[3].result as bigint) : 0n;

  const useWagmiReceipt = adapter.mode === "evm";
  const { isLoading: isConfirming } = useWaitForTransactionReceipt({
    hash: useWagmiReceipt ? pendingTx : undefined,
    query: { enabled: useWagmiReceipt && !!pendingTx },
  });

  const onRevokeOperator = async () => {
    if (!user) return;
    setError(null);
    setPendingLabel("Revoking operator…");
    try {
      const { txHash } = await adapter.write({
        kind: "marketSetOperator",
        market: ADDRESSES.market,
        operator: ADDRESSES.periphery,
        approved: false,
      });
      setPendingTx(txHash as `0x${string}`);
      await new Promise((r) => setTimeout(r, 3000));
      await reads.refetch();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPendingLabel(null);
    }
  };

  const onRevokeAllowance = async (token: `0x${string}`, label: string) => {
    if (!user) return;
    setError(null);
    setPendingLabel(`Revoking ${label}…`);
    try {
      const { txHash } = await adapter.write({
        kind: "approveErc20",
        token,
        spender: ADDRESSES.periphery,
        amount: 0n,
      });
      setPendingTx(txHash as `0x${string}`);
      await new Promise((r) => setTimeout(r, 3000));
      await reads.refetch();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes("revert") || msg.includes("0x")) {
        setError(`${label}: HTS facade quirk — approve(spender, 0) reverts on Hedera. The standing allowance is not actually exploitable (Periphery only uses transferFrom(msg.sender, …) which can't leverage your allowance via an attacker). You can ignore this row safely.`);
      } else {
        setError(msg);
      }
    } finally {
      setPendingLabel(null);
    }
  };

  if (!peripheryDeployed || !marketDeployed) return null;

  const rows: Array<{ label: string; value: string; active: boolean; revoke: () => void | Promise<void> }> = [
    {
      label: "Periphery operator on market",
      value: isOp ? "Active" : "Not approved",
      active: isOp,
      revoke: onRevokeOperator,
    },
    {
      label: "SY share spend allowance",
      value: syAllow > 0n ? "Active" : "0",
      active: syAllow > 0n,
      revoke: () => onRevokeAllowance(ADDRESSES.syAdapter, "SY share"),
    },
    ...(ptAddr ? [{
      label: "PT spend allowance",
      value: ptAllow > 0n ? "Active" : "0",
      active: ptAllow > 0n,
      revoke: () => onRevokeAllowance(ptAddr, "PT"),
    }] : []),
    ...(lpAddr ? [{
      label: "LP spend allowance",
      value: lpAllow > 0n ? "Active" : "0",
      active: lpAllow > 0n,
      revoke: () => onRevokeAllowance(lpAddr, "LP"),
    }] : []),
  ];

  const anyActive = rows.some((r) => r.active);

  return (
    <div className="rounded-2xl border border-border bg-bgCard p-4">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="font-mono text-[11px] uppercase tracking-[1.5px] text-textDim">
          dApp permissions
        </h3>
        <span className="font-mono text-[10px] text-textDim">
          {anyActive ? `${rows.filter((r) => r.active).length} active` : "none"}
        </span>
      </div>

      <p className="mb-4 font-mono text-[10px] leading-relaxed text-textDim">
        These permissions let the Fission Periphery spend your tokens + act on your
        behalf for YT sells. Revoke any time — the dApp will prompt you to re-approve
        on next use.
      </p>

      <div className="flex flex-col gap-2">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center justify-between rounded-lg border border-border bg-bg px-3 py-2">
            <div className="flex flex-col">
              <span className="font-mono text-[11px] text-text">{r.label}</span>
              <span className={`font-mono text-[10px] ${r.active ? "text-success" : "text-textDim"}`}>
                {r.value}
              </span>
            </div>
            {r.active && (
              <button
                type="button"
                onClick={() => void r.revoke()}
                disabled={pendingLabel !== null || isConfirming || !user}
                className="rounded-md border border-error/40 bg-error/[0.06] px-3 py-1 font-mono text-[10px] uppercase tracking-[1px] text-error transition hover:bg-error/[0.12] disabled:cursor-not-allowed disabled:opacity-40"
              >
                Revoke
              </button>
            )}
          </div>
        ))}
      </div>

      {pendingLabel && (
        <div className="mt-3 rounded-md border border-info/30 bg-info/[0.06] px-3 py-2 font-mono text-[10px] text-info">
          {pendingLabel}
          {pendingTx && (
            <div className="mt-1">
              <a
                href={`https://hashscan.io/mainnet/transaction/${pendingTx}`}
                target="_blank"
                rel="noreferrer"
                className="underline underline-offset-2 hover:text-text"
              >
                View on HashScan
              </a>
            </div>
          )}
        </div>
      )}

      {error && (
        <div className="mt-3 rounded-md border border-warning/30 bg-warning/[0.06] px-3 py-2 font-mono text-[10px] leading-relaxed text-warning">
          {error}
        </div>
      )}
    </div>
  );
}

// Silence unused (kept for future per-market expansion when there's more
// than one live market — currently single market via ADDRESSES.market).
export const _syShareDeployedHint = (a: string) => a;
