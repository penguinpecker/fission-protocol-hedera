"use client";

/**
 * WalletUiProvider — the single, app-wide wallet-connect UI.
 *
 * Renders ONE <WalletPicker> for the whole app and exposes openPicker() via
 * context, so every "Connect Wallet" affordance (Nav chip, hero CTA, …) opens
 * the SAME modal and reads the SAME shared auth/wallet state. That's what keeps
 * the buttons in sync — previously each button held its own auto-sign/redirect
 * refs and its own picker, so their labels could drift ("Signing…" on one,
 * "Sign In" on the other).
 *
 * Auto-sign was intentionally REMOVED: connecting a wallet no longer fires SIWE
 * automatically. After connecting, the user taps "Sign In" explicitly. A
 * post-auth redirect to /markets is armed only when a connect/sign is
 * user-initiated (opening the picker OR clicking Sign In), so a silent session
 * restore never yanks the user off the page they're on.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { usePathname, useRouter } from "next/navigation";
import { useSiweAuth } from "@/hooks/useSiweAuth";
import { WalletPicker } from "@/components/WalletPicker";

interface WalletUiApi {
  /** Open the shared wallet picker (HashPack / MetaMask). */
  openPicker: () => void;
  /** Arm the one-shot post-auth redirect to /markets for a user-initiated sign. */
  armRedirect: () => void;
}

const WalletUiContext = createContext<WalletUiApi | null>(null);

export function useWalletUi(): WalletUiApi {
  const ctx = useContext(WalletUiContext);
  if (!ctx) throw new Error("useWalletUi must be used within <WalletUiProvider>");
  return ctx;
}

export function WalletUiProvider({ children }: { children: ReactNode }) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const { state: auth } = useSiweAuth();
  const router = useRouter();
  const pathname = usePathname() ?? "/";
  // One-shot: armed only on a USER-initiated connect/sign so a passive session
  // restore (auth flips to authenticated on /api/auth/me) never redirects.
  const redirectRef = useRef(false);

  const openPicker = useCallback(() => setPickerOpen(true), []);
  const armRedirect = useCallback(() => {
    redirectRef.current = true;
  }, []);

  useEffect(() => {
    if (auth.status === "authenticated" && redirectRef.current) {
      redirectRef.current = false;
      // /claim runs its own post-redeem redirect; don't yank a user off /markets
      // or /claim the instant they sign in.
      if (!pathname.startsWith("/markets") && !pathname.startsWith("/claim")) {
        router.push("/markets");
      }
    }
  }, [auth.status, pathname, router]);

  return (
    <WalletUiContext.Provider value={{ openPicker, armRedirect }}>
      {children}
      <WalletPicker
        open={pickerOpen}
        onClose={() => setPickerOpen(false)}
        // A wallet was actually picked → arm the redirect for the manual sign
        // that follows. (No auto-sign; the user still taps "Sign In".)
        onConnectStarted={() => {
          redirectRef.current = true;
        }}
      />
    </WalletUiContext.Provider>
  );
}
