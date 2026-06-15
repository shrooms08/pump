"use client";

import { useEffect, useMemo, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { Connection, LAMPORTS_PER_SOL, PublicKey, type ParsedAccountData } from "@solana/web3.js";

// Real mode operates on MAINNET (FlashTrade real perp lives there). Read the
// player's mainnet SOL + USDC from a mainnet RPC so the bar reflects the funds
// real mode actually uses. The game/ER path is untouched — it stays on the
// devnet provider (useConnection / NEXT_PUBLIC_SOLANA_RPC) used elsewhere.
const MAINNET_RPC = process.env.NEXT_PUBLIC_MAINNET_RPC || "https://api.mainnet-beta.solana.com";
const USDC_MINT = new PublicKey("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");

/** Connect button + address + live balance. Devnet SOL by default; in real mode,
 *  mainnet SOL + USDC (and the network label flips to mainnet). */
export function WalletBar({ realMode = false }: { realMode?: boolean }) {
  const { connection } = useConnection(); // shared devnet provider
  const { publicKey } = useWallet();
  const mainnet = useMemo(() => new Connection(MAINNET_RPC, "confirmed"), []);
  const [sol, setSol] = useState<number | null>(null);
  const [usdc, setUsdc] = useState<number | null>(null);
  // The wallet button reflects localStorage (selected wallet) which only exists
  // on the client — render nothing until mounted so SSR and the first client
  // render match (otherwise React reports a hydration error: the "1 error").
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!publicKey) {
      setSol(null);
      setUsdc(null);
      return;
    }
    let dead = false;
    // Clear immediately on a network/account switch so a stale value from the
    // OTHER network can never be shown under the wrong badge (e.g. devnet SOL
    // lingering under the mainnet label if the mainnet read is slow/blocked).
    setSol(null);
    setUsdc(null);
    const conn = realMode ? mainnet : connection;
    const load = async () => {
      try {
        const lamports = await conn.getBalance(publicKey, "confirmed");
        if (!dead) setSol(lamports / LAMPORTS_PER_SOL);
      } catch {
        /* keep last balance; next poll retries */
      }
      if (!realMode) {
        if (!dead) setUsdc(null);
        return;
      }
      try {
        const res = await conn.getParsedTokenAccountsByOwner(publicKey, { mint: USDC_MINT });
        const total = res.value.reduce(
          (sum, a) => sum + ((a.account.data as ParsedAccountData).parsed?.info?.tokenAmount?.uiAmount ?? 0),
          0,
        );
        if (!dead) setUsdc(total);
      } catch {
        /* keep last USDC; next poll retries */
      }
    };
    void load();
    const id = setInterval(load, 15000);
    return () => {
      dead = true;
      clearInterval(id);
    };
  }, [publicKey, connection, mainnet, realMode]);

  const addr = publicKey ? `${publicKey.toBase58().slice(0, 4)}…${publicKey.toBase58().slice(-4)}` : null;

  // Match SSR markup until mounted to avoid a hydration mismatch.
  if (!mounted) {
    return <div className="wallet-bar" suppressHydrationWarning />;
  }

  return (
    <div className="wallet-bar">
      {addr && (
        <div className="wallet-meta">
          <span className="addr">{addr}</span>
          <span className="bal">
            {sol === null ? "…" : `${sol.toFixed(3)} SOL`}
            {realMode && usdc !== null && ` · ${usdc.toFixed(2)} USDC`}
            <span className="net">{realMode ? "mainnet" : "devnet"}</span>
          </span>
        </div>
      )}
      <WalletMultiButton />
    </div>
  );
}
