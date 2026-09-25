import { getServerSession } from 'next-auth/next';
import { redirect } from 'next/navigation';
import { getAuthOptions } from '../../src/auth';
import { installUrl } from '../../src/install-url';
import { PageHeading } from '../../src/components/ui';
import { DashboardRepoList } from './repo-list';

export default async function DashboardPage() {
  const session = await getServerSession(getAuthOptions());
  if (!session) redirect('/');

  return (
    <main className="flex flex-col gap-6">
      <PageHeading>Your repositories</PageHeading>
      <DashboardRepoList installUrl={installUrl()} />
    </main>
  );
}
