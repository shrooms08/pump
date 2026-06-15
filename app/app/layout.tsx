import type { Metadata } from "next";
import { Architects_Daughter, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { WalletProviders } from "../components/wallet-providers";

// Hand-drawn "architect" font for labels/headings; clean mono for all numbers
// (prices, PnL, scores) so the trading UI stays instantly legible.
const hand = Architects_Daughter({
  weight: "400",
  subsets: ["latin"],
  variable: "--font-hand",
  display: "swap",
});
const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-num",
  display: "swap",
});

export const metadata: Metadata = {
  title: "PUMP",
  description: "Flappy Bird where the bird's altitude is your live PnL.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className={`${hand.variable} ${mono.variable}`}>
        <WalletProviders>{children}</WalletProviders>
      </body>
    </html>
  );
}
