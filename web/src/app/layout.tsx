import type { Metadata, Viewport } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { DataBanner } from "@/components/DataBanner";
import { ThemeSwitch } from "@/components/ThemeSwitch";
import { dark, light, themeBootScript, themeCss } from "@/lib/theme";

import { fontBody, fontNum, fontUi } from "./fonts";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Pit Wall · F1 Strategy Analytics", template: "%s · Pit Wall" },
  description: "Live undercut detection replay dashboard (IISc big-data project).",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: dark.bg },
    { media: "(prefers-color-scheme: light)", color: light.bg },
  ],
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    // data-theme is set before the first paint by the boot script (dark by default; without script the
    // :root tokens are dark), so the client's <html> has an attribute the server markup does not.
    <html lang="en" className={`${fontUi.variable} ${fontBody.variable} ${fontNum.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeBootScript }} />
        {/* Design tokens from src/lib/theme.ts (the same values the contrast tests check). */}
        <style dangerouslySetInnerHTML={{ __html: themeCss }} />
      </head>
      <body>
        <a className="skip-link" href="#main">
          Skip to main content
        </a>
        {/* the data notice belongs to the banner landmark with the top bar (axe "region"; Step 5, finding 18) */}
        <header className="site-head">
          <div className="topbar">
            <Link href="/" className="brand">
              <svg className="brand-mark" viewBox="0 0 12 12" width="12" height="12" aria-hidden="true" focusable="false">
                <rect x="0" y="2" width="4" height="8" />
                <rect x="6" y="2" width="4" height="8" />
              </svg>
              Pit Wall
              <span className="brand-sub">F1 Strategy Analytics</span>
            </Link>
            <ThemeSwitch />
          </div>
          <DataBanner />
        </header>
        <main id="main" tabIndex={-1}>
          {children}
        </main>
        <footer className="site-footer">
          <p>Unofficial project; not associated with the Formula 1 companies.</p>
        </footer>
      </body>
    </html>
  );
}
