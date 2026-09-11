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
  metadataBase: new URL("https://autobot-profile-host-beta.avgschnook.chatgpt.site"),
  title: "AUTOBOT Profile Host Beta",
  description: "Isolated multi-profile acceptance dashboard for the AUTOBOT owned-event RSVP lab.",
  openGraph: {
    title: "AUTOBOT Profile Host Beta",
    description: "One panel. Independent devices. Exactly one live lease.",
    images: [{ url: "/og.png", width: 1731, height: 909, alt: "AUTOBOT Command Center device network" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "AUTOBOT Profile Host Beta",
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
