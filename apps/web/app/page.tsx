import { getServerSession } from 'next-auth/next';
import { redirect } from 'next/navigation';
import { getAuthOptions } from '../src/auth';
import { LandingPage } from './landing-page';

export default async function Home() {
  const session = await getServerSession(getAuthOptions());
  if (session) redirect('/dashboard');

  return <LandingPage />;
}
