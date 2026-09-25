import { getServerSession } from 'next-auth/next';
import { redirect } from 'next/navigation';
import { getAuthOptions } from '../../../../../src/auth';
import { ReviewDetail } from './detail';

export default async function ReviewPage({
  params,
}: {
  params: Promise<{ repositoryId: string; jobId: string }>;
}) {
  const session = await getServerSession(getAuthOptions());
  if (!session) redirect('/');
  const { repositoryId, jobId } = await params;

  return <ReviewDetail repositoryId={repositoryId} jobId={jobId} />;
}
