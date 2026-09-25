import { getServerSession } from 'next-auth/next';
import { redirect } from 'next/navigation';
import { getAuthOptions } from '../../../../src/auth';
import { RepositorySettings } from './settings';

export default async function RepositorySettingsPage({
  params,
}: {
  params: Promise<{ repositoryId: string }>;
}) {
  const session = await getServerSession(getAuthOptions());
  if (!session) redirect('/');
  const { repositoryId } = await params;

  return <RepositorySettings repositoryId={repositoryId} />;
}
