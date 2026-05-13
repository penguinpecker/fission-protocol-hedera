"use client";

/**
 * MintSyForm — lifted from the previous TradeCard "mint" branch on the
 * market detail page. Prefers the FissionZap one-tx HBAR → SY path; falls
 * back to the explicit USDC + WHBAR deposit path when the zap address is
 * not configured for this environment.
 *
 * Used inline on the market overview as a collapsible "Need SY first?"
 * callout (LP/PT/YT all require SY as an input).
 */
import { useState } from "react";
import { useReadContracts, useWaitForTransactionReceipt } from "wagmi";
import { parseUnits } from "viem";
import { erc20Abi } from "@/lib/abis";
import { ADDRESSES, HEDERA_TOKENS, USDC_DECIMALS, WHBAR_DECIMALS, isDeployed } from "@/lib/addresses";
import { AssociationGate } from "@/components/AssociationGate";
import { useWalletAdapter } from "@/lib/hedera-wallet/adapter";
import { formatBigInt } from "@/hooks/useMarkets";

interface MintFormProps {
  sy: `0x${string}`;
  syShare: `0x${string}`;
  user: `0x${string}` | undefined;
}

export function MintSyForm({ sy, syShare, user }: MintFormProps) {
  if (isDeployed(ADDRESSES.fissionZap)) {
    return <ZapMintForm sy={sy} syShare={syShare} user={user} />;
  }
  return <LegacyMintForm sy={sy} syShare={syShare} user={user} />;
}

function ZapMintForm({ sy, syShare, user }: MintFormProps) {
  return (
    <AssociationGate
      requiredTokens={[syShare, HEDERA_TOKENS.WHBAR]}
      tokenLabels={["SY share token", "WHBAR"]}
      reason="needed to receive SY shares and reclaim leftover WHBAR"
    >
      <ZapMintFormInner sy={sy} user={user} />
    </AssociationGate>
  );
}

function ZapMintFormInner({ sy, user }: { sy: `0x${string}`; user: `0x${string}` | undefined }) {
  const adapter = useWalletAdapter();
  const [txHash, setTxHash] = useState<`0x${string}` | undefined>(undefined);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const useWagmiReceipt = adapter.mode === "evm";
  const { isLoading: isConfirming, isSuccess: isConfirmed } = useWaitForTransactionReceipt({
    hash: useWagmiReceipt ? txHash : undefined,
    query: { enabled: useWagmiReceipt },
  });
  const isConfirmedFinal = useWagmiReceipt ? isConfirmed : !!txHash;
  const isConfirmingFinal = useWagmiReceipt ? isConfirming : false;
  const [hbar, setHbar] = useState("");
  const [hbarError, setHbarError] = useState<string | null>(null);

  let userHbarN = 0;
  try {
    const n = parseFloat(hbar);
    if (Number.isFinite(n) && n > 0) userHbarN = n;
  } catch {
    /* keep 0 */
  }

  const onZap = async () => {
    if (!user || userHbarN <= 0) return;
    setHbarError(null);
    setIsSubmitting(true);
    try {
      const { txHash: hash } = await adapter.write({
        kind: "zapHbarToSy",
        zap: ADDRESSES.fissionZap,
        sy,
        receiver: user,
        hbarIn: userHbarN,
      });
      setTxHash(hash as `0x${string}`);
    } catch (e) {
      setHbarError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsSubmitting(false);
    }
  };

  const resetWrite = () => {
    setTxHash(undefined);
    setHbarError(null);
  };

  const tooSmall = userHbarN > 0 && userHbarN < 1;
  const isPending = isSubmitting || adapter.isWritePending;

  return (
    <div className="rounded-2xl border border-border bg-bgCard p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <div className="text-[10px] font-semibold uppercase tracking-[2px] text-textDim">
          Mint SY from HBAR
        </div>
        <span className="rounded-full bg-success/10 px-2 py-0.5 font-mono text-[9px] font-semibold uppercase tracking-[1.5px] text-success">
          One tx
        </span>
      </div>

      <p className="mb-3 text-[12px] leading-relaxed text-textSec">
        Pay HBAR. The zap wraps half to WHBAR, swaps the other half to USDC on SaucerSwap V3, and deposits both into the SY. Net cost: your HBAR + ~5 HBAR for the V3 NPM fee.
      </p>

      <label className="mb-3 block">
        <span className="mb-1.5 flex items-center justify-between text-xs text-textSec">
          <span>HBAR to commit</span>
          <span className="font-mono text-[11px] text-textDim">+5 HBAR NPM fee</span>
        </span>
        <input
          type="number"
          value={hbar}
          onChange={(e) => setHbar(e.target.value)}
          placeholder="0.00"
          inputMode="decimal"
          className={`w-full rounded-[10px] border bg-bgInput px-4 py-3.5 font-mono text-base text-text outline-none transition ${
            tooSmall ? "border-warning/60 focus:border-warning" : "border-border focus:border-borderHover"
          }`}
        />
        {tooSmall && (
          <span className="mt-1 block text-[11px] font-medium text-warning">
            Tiny amounts get eaten by the 5 HBAR NPM fee — commit ≥1 HBAR.
          </span>
        )}
        {hbarError && (
          <span className="mt-1 block text-[11px] font-medium text-error">
            {hbarError.slice(0, 200)}
          </span>
        )}
      </label>

      <button
        type="button"
        disabled={!user || userHbarN === 0 || isPending || isConfirmingFinal}
        onClick={onZap}
        className="w-full rounded-[10px] bg-white px-7 py-3.5 text-sm font-semibold text-bg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {!user
          ? "Connect wallet"
          : userHbarN === 0
            ? "Enter HBAR amount"
            : isPending
              ? "Sign in HashPack…"
              : isConfirmingFinal
                ? "Waiting for confirmation…"
                : `Mint SY with ${hbar} HBAR`}
      </button>

      {isConfirmedFinal && txHash && (
        <div className="mt-3 rounded-lg border border-success/30 bg-success/10 px-3 py-2.5 text-[12px] leading-relaxed text-success">
          <div className="font-semibold">Mint confirmed.</div>
          <div className="mt-1 break-all font-mono text-[10px] text-success/80">
            tx: {txHash.slice(0, 18)}…{txHash.slice(-8)}
          </div>
          <div className="mt-1.5 flex gap-3">
            <a
              href={`https://hashscan.io/mainnet/transaction/${txHash}`}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-2 hover:text-text"
            >
              View on HashScan
            </a>
            <button
              type="button"
              onClick={() => {
                resetWrite();
                setHbar("");
              }}
              className="underline underline-offset-2 hover:text-text"
            >
              Mint another
            </button>
          </div>
        </div>
      )}

      <p className="mt-2 text-[10px] leading-relaxed text-textDim">
        One HashPack popup. Slippage is left wide on the underlying V3 swap and LP add.
      </p>
    </div>
  );
}

function LegacyMintForm({ sy, syShare, user }: MintFormProps) {
  return (
    <AssociationGate
      requiredTokens={[syShare]}
      tokenLabels={["SY share token"]}
      reason="needed to receive your SY shares"
    >
      <LegacyMintFormInner sy={sy} user={user} />
    </AssociationGate>
  );
}

function LegacyMintFormInner({ sy, user }: { sy: `0x${string}`; user: `0x${string}` | undefined }) {
  const adapter = useWalletAdapter();
  const [isPending, setIsPending] = useState(false);
  const [usdcAmt, setUsdcAmt] = useState("");
  const [whbarAmt, setWhbarAmt] = useState("");

  const reads = useReadContracts({
    contracts: user
      ? [
          { abi: erc20Abi, address: HEDERA_TOKENS.USDC, functionName: "balanceOf", args: [user] } as const,
          { abi: erc20Abi, address: HEDERA_TOKENS.WHBAR, functionName: "balanceOf", args: [user] } as const,
          {
            abi: [
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
            ] as const,
            address: HEDERA_TOKENS.USDC,
            functionName: "allowance",
            args: [user, sy],
          } as const,
          {
            abi: [
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
            ] as const,
            address: HEDERA_TOKENS.WHBAR,
            functionName: "allowance",
            args: [user, sy],
          } as const,
        ]
      : [],
    query: { enabled: !!user },
    allowFailure: true,
  });

  const pluck = <T,>(
    entry: { status: "success"; result: T } | { status: "failure"; error: Error } | undefined,
  ): T | undefined => (entry?.status === "success" ? entry.result : undefined);

  const usdcBal = pluck<bigint>(reads.data?.[0] as never) ?? 0n;
  const whbarBal = pluck<bigint>(reads.data?.[1] as never) ?? 0n;
  const usdcAllow = pluck<bigint>(reads.data?.[2] as never) ?? 0n;
  const whbarAllow = pluck<bigint>(reads.data?.[3] as never) ?? 0n;

  let usdcParsed = 0n;
  let whbarParsed = 0n;
  try {
    if (usdcAmt) usdcParsed = parseUnits(usdcAmt, USDC_DECIMALS);
  } catch {
    /* keep 0 */
  }
  try {
    if (whbarAmt) whbarParsed = parseUnits(whbarAmt, WHBAR_DECIMALS);
  } catch {
    /* keep 0 */
  }

  const needsUsdcApprove = usdcParsed > 0n && usdcAllow < usdcParsed;
  const needsWhbarApprove = whbarParsed > 0n && whbarAllow < whbarParsed;
  const insufficientUsdc = usdcParsed > usdcBal;
  const insufficientWhbar = whbarParsed > whbarBal;
  const ready = usdcParsed > 0n && whbarParsed > 0n && !insufficientUsdc && !insufficientWhbar;

  const setMax = (which: "usdc" | "whbar") => {
    const v = which === "usdc" ? usdcBal : whbarBal;
    const d = which === "usdc" ? USDC_DECIMALS : WHBAR_DECIMALS;
    const div = 10n ** BigInt(d);
    const whole = v / div;
    const frac = v % div;
    const fracStr = frac.toString().padStart(d, "0").replace(/0+$/, "");
    const s = fracStr ? `${whole}.${fracStr}` : `${whole}`;
    if (which === "usdc") setUsdcAmt(s);
    else setWhbarAmt(s);
  };

  const guarded = async (fn: () => Promise<unknown>) => {
    setIsPending(true);
    try {
      await fn();
    } finally {
      setIsPending(false);
    }
  };
  const approveUsdc = () =>
    guarded(() =>
      adapter.write({ kind: "approveErc20", token: HEDERA_TOKENS.USDC, spender: sy, amount: usdcParsed }),
    );
  const approveWhbar = () =>
    guarded(() =>
      adapter.write({ kind: "approveErc20", token: HEDERA_TOKENS.WHBAR, spender: sy, amount: whbarParsed }),
    );
  const deposit = () => {
    if (!user) return;
    const a0Min = (usdcParsed * 95n) / 100n;
    const a1Min = (whbarParsed * 95n) / 100n;
    return guarded(() =>
      adapter.write({
        kind: "depositLiquidity",
        sy,
        amount0: usdcParsed,
        amount1: whbarParsed,
        amount0Min: a0Min,
        amount1Min: a1Min,
        receiver: user,
        minShares: 1n,
        npmHbar: 5,
      }),
    );
  };

  const nextStep = needsUsdcApprove
    ? { label: "Approve USDC", fn: approveUsdc }
    : needsWhbarApprove
      ? { label: "Approve WHBAR", fn: approveWhbar }
      : ready
        ? { label: "Deposit & mint SY", fn: deposit }
        : null;

  return (
    <div className="rounded-2xl border border-border bg-bgCard p-4">
      <div className="mb-3 flex items-baseline justify-between">
        <div className="text-[10px] font-semibold uppercase tracking-[2px] text-textDim">
          Mint SY shares
        </div>
        <a
          href="https://www.saucerswap.finance/swap"
          target="_blank"
          rel="noreferrer"
          className="text-[10px] text-textDim underline underline-offset-2 hover:text-text"
        >
          Need USDC?
        </a>
      </div>

      <p className="mb-3 text-[12px] leading-relaxed text-textSec">
        Deposit USDC + WHBAR. The SY adapter adds them to its V3 NFT and mints fungible SY shares to your wallet.
      </p>

      <MintInput
        label="USDC"
        value={usdcAmt}
        setValue={setUsdcAmt}
        balance={usdcBal}
        decimals={USDC_DECIMALS}
        insufficient={insufficientUsdc}
        onMax={() => setMax("usdc")}
      />
      <MintInput
        label="WHBAR"
        value={whbarAmt}
        setValue={setWhbarAmt}
        balance={whbarBal}
        decimals={WHBAR_DECIMALS}
        insufficient={insufficientWhbar}
        onMax={() => setMax("whbar")}
      />

      <button
        type="button"
        disabled={!user || !nextStep || isPending}
        onClick={() => nextStep?.fn()}
        className="mt-3 w-full rounded-[10px] bg-white px-7 py-3.5 text-sm font-semibold text-bg transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
      >
        {!user
          ? "Connect wallet"
          : isPending
            ? "Confirming…"
            : nextStep
              ? nextStep.label
              : insufficientUsdc || insufficientWhbar
                ? "Insufficient balance"
                : "Enter amounts"}
      </button>
    </div>
  );
}

function MintInput({
  label,
  value,
  setValue,
  balance,
  decimals,
  insufficient,
  onMax,
}: {
  label: string;
  value: string;
  setValue: (v: string) => void;
  balance: bigint;
  decimals: number;
  insufficient: boolean;
  onMax: () => void;
}) {
  return (
    <label className="mb-3 block">
      <span className="mb-1.5 flex items-center justify-between text-xs text-textSec">
        <span>{label}</span>
        <span className="font-mono text-[11px] text-textDim">
          Balance: {formatBigInt(balance, decimals, 4)}
          {balance > 0n && (
            <button
              type="button"
              onClick={onMax}
              className="ml-2 rounded border border-borderHover bg-white/[0.04] px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[1px] text-text transition hover:bg-white/[0.08]"
            >
              Max
            </button>
          )}
        </span>
      </span>
      <input
        type="number"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="0.00"
        inputMode="decimal"
        className={`w-full rounded-[10px] border bg-bgInput px-4 py-3 font-mono text-sm text-text outline-none transition ${
          insufficient ? "border-error/60 focus:border-error" : "border-border focus:border-borderHover"
        }`}
      />
      {insufficient && (
        <span className="mt-1 block text-[11px] font-medium text-error">
          Insufficient {label}.
        </span>
      )}
    </label>
  );
}
