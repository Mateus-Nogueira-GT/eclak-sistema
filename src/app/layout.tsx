import type { Metadata } from "next";
import { Hanken_Grotesk, Newsreader } from "next/font/google";
import "./globals.css";

const inter = Hanken_Grotesk({ variable: "--font-inter", subsets: ["latin"] });
const bodoni = Newsreader({ variable: "--font-bodoni", subsets: ["latin"], weight: ["400", "500"] });

export const metadata: Metadata = {
  title: "ECLAK Viagens",
  description: "Sistema financeiro e operacional da ECLAK Viagens",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="pt-BR" className={`${inter.variable} ${bodoni.variable} antialiased`}>
      <body>{children}</body>
    </html>
  );
}
