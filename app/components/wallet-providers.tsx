"use client";

import { useMemo } from "react";
import { ConnectionProvider, WalletProvider } from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import { clusterApiUrl } from "@solana/web3.js";
import type { Adapter } from "@solana/wallet-adapter-base";
import "@solana/wallet-adapter-react-ui/styles.css";

/**
 * Devnet wallet context. Phantom / Solflare / Backpack all register through the
 * Wallet Standard, so the adapter list can stay empty — installed wallets show
 * up automatically. Devnet only (the whole project is devnet).
 */
export function WalletProviders({ children }: { children: React.ReactNode }) {
  const endpoint = process.env.NEXT_PUBLIC_SOLANA_RPC || clusterApiUrl("devnet");
  const wallets = useMemo<Adapter[]>(() => [], []);
  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets} autoConnect>
        <WalletModalProvider>{children}</WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}
