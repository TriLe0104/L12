import type { Metadata, Viewport } from "next";
import { Archivo, IBM_Plex_Mono } from "next/font/google";
import Script from "next/script";

import "./globals.css";
import "./scc-theme.css";
import { AuthProvider } from "@/lib/auth";
import { ClawRevealProvider } from "@/components/ClawReveal";
import { ThemeProvider } from "@/lib/ui-theme";
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
  title: "L12 App",
  description: "L12 cluster testing — data halls, racks, and health.",
  manifest: "/manifest.webmanifest",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "32x32" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: "/apple-icon.png",
  },
  appleWebApp: { capable: true, title: "L12 App", statusBarStyle: "black-translucent" },
};

export const viewport: Viewport = {
  themeColor: "#000000",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${ui.variable} ${mono.variable}`} data-theme="meow">
      <body>
        <Script id="ui-theme-boot" strategy="beforeInteractive">
          {`try{var t=localStorage.getItem('l12-ui-theme');if(t==='scc'||t==='meow'){document.documentElement.setAttribute('data-theme',t);document.documentElement.style.colorScheme=t==='scc'?'light':'dark'}}catch(e){}`}
        </Script>
        <ThemeProvider>
          <ClawRevealProvider>
            <AuthProvider>{children}</AuthProvider>
          </ClawRevealProvider>
        </ThemeProvider>
        <RegisterSW />
      </body>
    </html>
  );
}
