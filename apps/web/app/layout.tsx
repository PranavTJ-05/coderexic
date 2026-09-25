import { getServerSession } from 'next-auth/next';
import type { ReactNode } from 'react';
import { getAuthOptions } from '../src/auth';
import './globals.css';

export const metadata = {
  title: 'Coderexic',
  description: 'Context-aware, agentic pull request review for GitHub.',
};

export const dynamic = 'force-dynamic';

export default async function RootLayout({ children }: { children: ReactNode }) {
  const session = await getServerSession(getAuthOptions());

  return (
    <html lang="en">
      <body className="min-h-screen bg-[var(--background)] text-[var(--foreground)] antialiased">
        <header className="border-b border-[var(--border)]">
          <div className="mx-auto flex max-w-4xl items-center justify-between px-4 py-3">
            <a href="/" className="text-sm font-semibold">
              Coderexic
            </a>
            {session ? (
              <nav className="flex items-center gap-4 text-sm">
                <a
                  href="/dashboard"
                  className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                >
                  Dashboard
                </a>
                <span className="text-[var(--muted-foreground)]">{session.user.login}</span>
                <a
                  href="/api/auth/signout"
                  className="text-[var(--muted-foreground)] hover:text-[var(--foreground)]"
                >
                  Sign out
                </a>
              </nav>
            ) : (
              <a href="/api/auth/signin/github" className="text-sm font-medium">
                Sign in with GitHub
              </a>
            )}
          </div>
        </header>
        <div className="mx-auto max-w-4xl px-4 py-8">{children}</div>
      </body>
    </html>
  );
}
