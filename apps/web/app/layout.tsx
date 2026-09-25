import type { ReactNode } from 'react';

export const metadata = {
  title: 'Coderexic',
  description: 'Context-aware, agentic pull request review for GitHub.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
