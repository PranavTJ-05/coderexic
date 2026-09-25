/**
 * Hand-authored, shadcn-style primitives. `shadcn@latest init` needs
 * Tailwind and an import-alias already configured and stops short of doing
 * either for us (verified by actually running it), and this app's
 * conventions use extension-less relative imports rather than a `@/*`
 * alias - so these components are written by hand instead, matching
 * shadcn's visual language (Tailwind utility classes + `cva` variants +
 * `cn()`) without the CLI or its generated file layout.
 */
import { cva, type VariantProps } from 'class-variance-authority';
import type { ButtonHTMLAttributes, HTMLAttributes, ReactNode } from 'react';
import { cn } from '../lib/cn';

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('rounded-lg border border-[var(--border)] bg-[var(--card)] p-4', className)}
      {...props}
    />
  );
}

export function PageHeading({ children }: { children: ReactNode }) {
  return <h1 className="text-2xl font-semibold tracking-tight">{children}</h1>;
}

export function Muted({ children }: { children: ReactNode }) {
  return <p className="text-sm text-[var(--muted-foreground)]">{children}</p>;
}

const buttonVariants = cva(
  'inline-flex items-center justify-center rounded-md px-3 py-2 text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-50',
  {
    variants: {
      variant: {
        primary: 'bg-[var(--primary)] text-[var(--primary-foreground)] hover:opacity-90',
        outline: 'border border-[var(--border)] hover:bg-[var(--muted)]',
        ghost: 'hover:bg-[var(--muted)]',
      },
    },
    defaultVariants: { variant: 'primary' },
  },
);

export function Button({
  variant,
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants>) {
  return <button type="button" className={cn(buttonVariants({ variant }), className)} {...props} />;
}

export function LinkButton({
  href,
  variant,
  className,
  children,
}: { href: string; children: ReactNode } & VariantProps<typeof buttonVariants> & {
    className?: string;
  }) {
  return (
    <a href={href} className={cn(buttonVariants({ variant }), className)}>
      {children}
    </a>
  );
}

const severityVariants = cva(
  'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
  {
    variants: {
      severity: {
        critical: 'bg-red-600/15 text-red-600 dark:text-red-400',
        high: 'bg-orange-500/15 text-orange-600 dark:text-orange-400',
        medium: 'bg-yellow-500/15 text-yellow-700 dark:text-yellow-400',
        low: 'bg-zinc-500/15 text-[var(--muted-foreground)]',
      },
    },
  },
);

export function SeverityBadge({ severity }: { severity: 'critical' | 'high' | 'medium' | 'low' }) {
  return <span className={severityVariants({ severity })}>{severity}</span>;
}

const statusVariants = cva(
  'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium',
  {
    variants: {
      tone: {
        neutral: 'bg-zinc-500/15 text-[var(--muted-foreground)]',
        success: 'bg-[var(--success)]/15 text-[var(--success)]',
        warning: 'bg-[var(--warning)]/15 text-[var(--warning)]',
        destructive: 'bg-[var(--destructive)]/15 text-[var(--destructive)]',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
);

const JOB_STATUS_TONE: Record<string, 'neutral' | 'success' | 'warning' | 'destructive'> = {
  PENDING: 'neutral',
  RUNNING: 'warning',
  SUCCEEDED: 'success',
  FAILED: 'destructive',
  TIMED_OUT: 'destructive',
  CANCELLED: 'neutral',
};

export function StatusBadge({ status }: { status: string }) {
  return (
    <span className={statusVariants({ tone: JOB_STATUS_TONE[status] ?? 'neutral' })}>{status}</span>
  );
}

/**
 * The common "GitHub App user token expired" state (401 from any
 * `/api/*` route - GitHub App user tokens expire after 8h by default,
 * which outlives the next-auth session cookie, so the page otherwise
 * looks signed-in while every data fetch silently fails).
 */
export function SessionExpired() {
  return (
    <EmptyState
      title="GitHub session expired"
      description="Your GitHub sign-in has expired. Sign in again to continue."
      action={<LinkButton href="/api/auth/signin/github">Sign in with GitHub</LinkButton>}
    />
  );
}

export function EmptyState({
  title,
  description,
  action,
}: {
  title: string;
  description: string;
  action?: ReactNode;
}) {
  return (
    <Card className="flex flex-col items-center gap-3 py-10 text-center">
      <p className="font-medium">{title}</p>
      <Muted>{description}</Muted>
      {action}
    </Card>
  );
}
