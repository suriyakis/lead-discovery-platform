// Module augmentation for Auth.js session/user shapes.
// We add the platform `role` to `session.user` so client + server code can
// read it without a separate query. The role is populated in the session
// callback in src/lib/auth.ts.

import type { DefaultSession } from 'next-auth';

declare module 'next-auth' {
  interface Session {
    user: {
      id: string;
      role: 'member' | 'super_admin';
    } & DefaultSession['user'];
  }
}
