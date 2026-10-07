import { getServerSession } from 'next-auth/next';
import { redirect } from 'next/navigation';
import { getAuthOptions } from '../src/auth';

/**
 * The marketing site (apps/landing, deployed separately on Vercel) is
 * where a real visitor actually lands - its CTA goes straight to
 * /api/auth/signin/github on this app's own domain. Nobody should be
 * landing on this bare root directly, but if they do: straight into the
 * real flow either way, signed in or not.
 */
export default async function Home() {
  const session = await getServerSession(getAuthOptions());
  redirect(session ? '/dashboard' : '/api/auth/signin/github');
}
