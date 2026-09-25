import { getServerSession } from 'next-auth/next';
import { redirect } from 'next/navigation';
import { getAuthOptions } from '../../../src/auth';
import { RepositoryDetail } from './detail';

export default async function RepositoryPage({
  params,
}: {
  params: Promise<{ repositoryId: string }>;
}) {
  const session = await getServerSession(getAuthOptions());
  if (!session) redirect('/');
  const { repositoryId } = await params;

  return <RepositoryDetail repositoryId={repositoryId} />;
}
