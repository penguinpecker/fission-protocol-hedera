"use client";

import Link from "next/link";
import { useAccount, useConnect, useDisconnect } from "wagmi";
import { FissionLogo } from "./FissionLogo";

function shortAddr(addr: string): string {
  return addr.slice(0, 6) + "…" + addr.slice(-4);
}

export function Nav() {
  const { address, isConnected } = useAccount();
  const { connectors, connect } = useConnect();
  const { disconnect } = useDisconnect();
  const injected = connectors[0];

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
          <button
            type="button"
            onClick={() => injected && connect({ connector: injected })}
            className="rounded-[10px] bg-white px-5 py-2 text-[13px] font-semibold text-bg transition hover:opacity-90"
          >
            Connect
          </button>
        )}
      </div>
    </nav>
  );
}
