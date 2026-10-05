import { getServerSession } from 'next-auth/next';
import { Space_Grotesk, JetBrains_Mono } from 'next/font/google';
import type { ReactNode } from 'react';
import { getAuthOptions } from '../src/auth';
import { AppShell } from '../src/components/app-shell';
import './globals.css';

const spaceGrotesk = Space_Grotesk({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
  variable: '--font-display',
});
const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-mono',
});

export const metadata = {
  title: 'Coderexic',
  description: 'Context-aware, agentic pull request review for GitHub.',
  icons: { icon: '/icon.png' },
};

export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }: { children: ReactNode }) {
  const session = await getServerSession(getAuthOptions());

  return (
    <html lang="en" className={`${spaceGrotesk.variable} ${jetbrainsMono.variable}`}>
      <body className="min-h-screen bg-[var(--background)] text-[var(--foreground)] antialiased">
        <AppShell session={session}>{children}</AppShell>
      </body>
    </html>
  );
}
