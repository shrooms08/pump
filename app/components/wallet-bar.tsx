"use client";

import { useEffect, useState } from "react";
import { useConnection, useWallet } from "@solana/wallet-adapter-react";
import { WalletMultiButton } from "@solana/wallet-adapter-react-ui";
import { LAMPORTS_PER_SOL } from "@solana/web3.js";

/** Connect button + connected address and live devnet SOL balance. */
export function WalletBar() {
  const { connection } = useConnection();
  const { publicKey } = useWallet();
  const [balance, setBalance] = useState<number | null>(null);
  // The wallet button reflects localStorage (selected wallet) which only exists
  // on the client — render nothing until mounted so SSR and the first client
  // render match (otherwise React reports a hydration error: the "1 error").
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  useEffect(() => {
    if (!publicKey) {
      setBalance(null);
      return;
    }
    let dead = false;
    const load = async () => {
      try {
        const lamports = await connection.getBalance(publicKey, "confirmed");
        if (!dead) setBalance(lamports / LAMPORTS_PER_SOL);
      } catch {
        /* keep last balance; next poll retries */
      }
    };
    void load();
    const id = setInterval(load, 15000);
    return () => {
      dead = true;
      clearInterval(id);
    };
  }, [publicKey, connection]);

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
            {balance === null ? "…" : `${balance.toFixed(3)} SOL`}
            <span className="net">devnet</span>
          </span>
        </div>
      )}
      <WalletMultiButton />
    </div>
  );
}
