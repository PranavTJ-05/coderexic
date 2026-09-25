import { getServerSession } from 'next-auth/next';
import { getAuthOptions } from '../src/auth';
import { RepoList } from './repo-list';

export const dynamic = 'force-dynamic';

export default async function HomePage() {
  const session = await getServerSession(getAuthOptions());

  if (!session) {
    return (
      <main>
        <h1>Coderexic</h1>
        <a href="/api/auth/signin/github">Sign in with GitHub</a>
      </main>
    );
  }

  return (
    <main>
      <h1>Coderexic</h1>
      <p>
        Signed in as {session.user.login} - <a href="/api/auth/signout">Sign out</a>
      </p>
      <h2>Your authorized repositories</h2>
      <RepoList />
    </main>
  );
}
