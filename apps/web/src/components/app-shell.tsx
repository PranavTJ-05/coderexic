'use client';

import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import type { Session } from 'next-auth';

/**
 * The landing page (`/`) is a full-bleed marketing page with its own dark
 * brand styling - it can't sit inside the dashboard's header + `max-w-4xl`
 * container without being squeezed into that chrome. Every other route
 * keeps the exact header/nav/container `apps/web/app/layout.tsx` used to
 * render inline, unchanged - this only decides whether to show it.
 */
export function AppShell({ session, children }: { session: Session | null; children: ReactNode }) {
  const pathname = usePathname();
  if (pathname === '/') return <>{children}</>;

  return (
    <>
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
    </>
  );
}
