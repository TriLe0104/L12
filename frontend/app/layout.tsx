import type { Metadata, Viewport } from "next";
import { Archivo, IBM_Plex_Mono } from "next/font/google";

import "./globals.css";
import { AuthProvider } from "@/lib/auth";
import { RegisterSW } from "./register-sw";

const ui = Archivo({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700", "800"],
  variable: "--font-ui",
  display: "swap",
});

const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "TVM Precision Machining — PO Calendar",
  description: "Purchase order and material scheduling board for the machine shop floor.",
  manifest: "/manifest.webmanifest",
  icons: { icon: "/icons/icon-192.png", apple: "/icons/icon-192.png" },
  appleWebApp: { capable: true, title: "TVM PO", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  themeColor: "#000000",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${ui.variable} ${mono.variable}`}>
      <body>
        <AuthProvider>{children}</AuthProvider>
        <RegisterSW />
      </body>
    </html>
  );
}
