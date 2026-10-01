import type { Metadata } from 'next';
import { Inter, JetBrains_Mono } from 'next/font/google';
import './globals.css';
import { BRAND_NAME } from '@/lib/brand';

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

export const metadata: Metadata = {
  title: BRAND_NAME,
  description:
    'Ping the market, keep the echoes that matter. B2B lead discovery, qualification, outreach, and intelligence — with evidence and a learning layer.',
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
