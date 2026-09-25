import { getServerSession } from 'next-auth/next';
import { redirect } from 'next/navigation';
import { getAuthOptions } from '../src/auth';
import { PageHeading, Muted, LinkButton } from '../src/components/ui';

export default async function LandingPage() {
  const session = await getServerSession(getAuthOptions());
  if (session) redirect('/dashboard');

  return (
    <main className="flex flex-col gap-6 py-12">
      <PageHeading>Context-aware pull request review</PageHeading>
      <Muted>
        Coderexic reads your dependency graph, not just the diff, before an AI agent reviews a pull
        request - then posts findings as inline GitHub review comments.
      </Muted>
      <div>
        <LinkButton href="/api/auth/signin/github">Sign in with GitHub</LinkButton>
      </div>
    </main>
  );
}
