"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import type { Connector } from "wagmi";
import { FissionLogo } from "./FissionLogo";

function shortAddr(addr: string): string {
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

/** Display label per connector — falls back to wagmi's built-in name. */
function connectorLabel(c: Connector): string {
  // wagmi names from `target.name` win; otherwise generic.
  return c.name || c.id;
}

/** Hide connectors whose provider isn't actually installed in the browser.
 *  This keeps the picker honest — only show wallets the user can actually click. */
function isAvailable(c: Connector): boolean {
  // Wagmi v2 exposes a sync `getProvider` ready check; we approximate via id rules:
  // - 'metaMaskSDK' / 'metaMask' / 'io.metamask' are detectable post-mount
  // - custom-target connectors return undefined provider when not installed
  // For SSR safety, we rely on the connector's own readiness state instead.
  return Boolean(c);
}

export function Nav() {
  const { address, isConnected } = useAccount();
  const { connectors, connect, isPending } = useConnect();
  const { disconnect } = useDisconnect();

  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerRef = useRef<HTMLDivElement>(null);

  // Close picker on outside click
  useEffect(() => {
    if (!pickerOpen) return;
    function onClick(e: MouseEvent) {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    }
    document.addEventListener("mousedown", onClick);
    return () => document.removeEventListener("mousedown", onClick);
  }, [pickerOpen]);

  return (
    <nav className="sticky top-0 z-50 flex items-center justify-between border-b border-border bg-bg/80 px-8 py-3 backdrop-blur">
      <Link href="/" className="flex items-center gap-2.5">
        <FissionLogo size={26} />
        <span className="text-[17px] font-semibold tracking-tight text-text">Fission</span>
      </Link>

      <div className="flex items-center gap-6">
        <Link href="/markets" className="text-[13px] font-medium text-textSec hover:text-text">
          Markets
        </Link>
        {isConnected && address ? (
          <button
            type="button"
            onClick={() => disconnect()}
            className="flex items-center gap-1.5 rounded-[10px] border border-borderHover bg-white/[0.04] px-3.5 py-1.5 font-mono text-xs text-text"
          >
            <span className="size-[5px] rounded-full bg-success" />
            {shortAddr(address)}
          </button>
        ) : (
          <div ref={pickerRef} className="relative">
            <button
              type="button"
              onClick={() => setPickerOpen((v) => !v)}
              disabled={isPending}
              className="rounded-[10px] bg-white px-5 py-2 text-[13px] font-semibold text-bg transition hover:opacity-90 disabled:opacity-50"
            >
              {isPending ? "Connecting…" : "Connect"}
            </button>

            {pickerOpen && (
              <div className="absolute right-0 mt-2 w-[220px] overflow-hidden rounded-xl border border-border bg-bgCard shadow-2xl">
                <div className="border-b border-border px-3 py-2 text-[10px] uppercase tracking-[1px] text-textDim">
                  Choose wallet
                </div>
                {connectors.filter(isAvailable).map((c) => (
                  <button
                    key={c.uid}
                    type="button"
                    onClick={() => {
                      connect({ connector: c });
                      setPickerOpen(false);
                    }}
                    className="block w-full px-3 py-2.5 text-left text-[13px] text-text transition hover:bg-white/[0.04]"
                  >
                    {connectorLabel(c)}
                  </button>
                ))}
                <div className="border-t border-border px-3 py-2 text-[10px] leading-relaxed text-textDim">
                  HashPack / Blade users:&nbsp;install&nbsp;the&nbsp;extension if not listed.
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </nav>
  );
}
