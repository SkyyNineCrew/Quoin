import type { Metadata } from "next";
import { Inter } from "next/font/google";
import { Instrument_Serif } from "next/font/google";
import "./globals.css";

const inter = Inter({
  subsets: ["latin"],
  display: "swap",
});

const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
    weight: "400",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Quoin — Trusted construction cost intelligence.",
  description:
    "Quoin helps clients compare quantity surveyors, benchmark rates, and seal estimates on the Stellar Network.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.className} ${instrumentSerif.className} h-full antialiased`}>
      <body className="min-h-full flex flex-col">{children}</body>
    </html>
  );
}
