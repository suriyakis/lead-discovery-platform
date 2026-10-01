import { DrizzleAdapter } from '@auth/drizzle-adapter';
import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import { db } from '@/lib/db/client';
import {
  accounts,
  sessions,
  users,
  verificationTokens,
} from '@/lib/db/schema/auth';
import { provisionOnSignIn } from '@/lib/services/workspace-provisioning';

const ownerEmail = process.env.OWNER_EMAIL?.toLowerCase().trim() || null;

export const { handlers, signIn, signOut, auth } = NextAuth({
  adapter: DrizzleAdapter(db, {
    usersTable: users,
    accountsTable: accounts,
    sessionsTable: sessions,
    verificationTokensTable: verificationTokens,
  }),
  session: { strategy: 'database' },
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      // Reasonable defaults: get profile + email. authorization params can
      // be added later if we need offline access for downstream tokens.
    }),
  ],
  callbacks: {
    async session({ session, user }) {
      // The Drizzle adapter returns the full users row as `user`, which
      // includes bigint columns (e.g. activeWorkspaceId). Mutating
      // session.user in place leaves those bigint fields attached, and
      // Next.js's RSC serializer chokes with "Do not know how to
      // serialize a BigInt". Rebuild session.user from primitives
      // explicitly so only JSON-safe fields cross the boundary. The
      // session shape is augmented in src/types/next-auth.d.ts.
      const u = user as {
        id: string;
        name?: string | null;
        email: string;
        image?: string | null;
        emailVerified?: Date | null;
        role?: 'member' | 'super_admin';
        accountStatus?: 'pending' | 'active' | 'suspended' | 'rejected';
      };
      session.user = {
        id: u.id,
        name: u.name ?? null,
        email: u.email,
        image: u.image ?? null,
        emailVerified: u.emailVerified ?? null,
        role: u.role ?? 'member',
        accountStatus: u.accountStatus ?? 'pending',
      };
      return session;
    },
  },
  events: {
    async signIn({ user, isNewUser }) {
      if (!user.id || !user.email) return;
      // Records the sign-in time; a first sign-in also ends up active
      // with a workspace: OWNER_EMAIL bootstrap, a pre-authorisation
      // (the named workspace, or their own one when it names none), or
      // a self-signup Personal workspace. See workspace-provisioning.ts.
      await provisionOnSignIn(
        { id: user.id, email: user.email },
        { isNewUser: isNewUser === true, ownerEmail },
      );
    },
  },
});
