import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://autobot-command-center.avgschnook.chatgpt.site"),
  title: "AUTOBOT Command Center",
  description: "Optional multi-device orchestration for the AUTOBOT owned-event RSVP lab.",
  openGraph: {
    title: "AUTOBOT Command Center",
    description: "One panel. Independent devices. Exactly one live lease.",
    images: [{ url: "/og.png", width: 1731, height: 909, alt: "AUTOBOT Command Center device network" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "AUTOBOT Command Center",
    description: "One panel. Independent devices. Exactly one live lease.",
    images: ["/og.png"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>{children}</body>
    </html>
  );
}
