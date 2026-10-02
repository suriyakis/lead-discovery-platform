import type { Metadata, Viewport } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { appOrigin } from '@/lib/app-origin';
import { BRAND_COLOURS, BRAND_DESCRIPTION, BRAND_NAME } from '@/lib/brand';

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
  display: 'swap',
});

const jetbrains = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains',
  display: 'swap',
});

// The icons, the manifest and the link-preview card come from Next's file
// conventions in this folder (DS-08): icon.svg and favicon.ico, apple-icon.png,
// manifest.ts and opengraph-image.png (+ .alt.txt), all generated from
// src/lib/brand-mark.ts by `pnpm brand:icons`. metadataBase makes og:image
// absolute on the deployment's own origin.
export const metadata: Metadata = {
  metadataBase: appOrigin(),
  title: BRAND_NAME,
  applicationName: BRAND_NAME,
  description: BRAND_DESCRIPTION,
  appleWebApp: { capable: true, title: BRAND_NAME, statusBarStyle: 'black' },
  openGraph: {
    type: 'website',
    siteName: BRAND_NAME,
    title: BRAND_NAME,
    description: BRAND_DESCRIPTION,
  },
  twitter: { card: 'summary_large_image', title: BRAND_NAME, description: BRAND_DESCRIPTION },
};

// The browser chrome around the app (and the installed app's title bar)
// takes the page colour, so the frame reads as one dark surface.
export const viewport: Viewport = {
  themeColor: BRAND_COLOURS.bg,
  colorScheme: 'dark',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${inter.variable} ${jetbrains.variable}`}>
      <body>{children}</body>
    </html>
  );
}
