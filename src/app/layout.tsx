import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Signal Works',
  description:
    'Find the right opportunities for the products you sell. Multi-tenant B2B lead discovery, qualification, outreach, and intelligence.',
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
