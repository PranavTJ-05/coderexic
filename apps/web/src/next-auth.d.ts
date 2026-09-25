import type { DefaultSession } from 'next-auth';
import type { DefaultJWT } from 'next-auth/jwt';

declare module 'next-auth' {
  interface Session {
    user: DefaultSession['user'] & {
      id: string;
      login: string;
    };
  }
}

declare module 'next-auth/jwt' {
  interface JWT extends DefaultJWT {
    userId?: string;
    login?: string;
    /** The GitHub App user-to-server token. Never spread onto `Session`. */
    githubAccessToken?: string;
  }
}
