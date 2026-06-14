import type { Metadata } from "next";
import "./globals.css";
import { WalletProviders } from "../components/wallet-providers";

export const metadata: Metadata = {
  title: "PUMP",
  description: "Flappy Bird where the bird's altitude is your live PnL.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <WalletProviders>{children}</WalletProviders>
      </body>
    </html>
  );
}
