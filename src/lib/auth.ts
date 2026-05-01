import { DrizzleAdapter } from '@auth/drizzle-adapter';
import { eq } from 'drizzle-orm';
import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import { db } from '@/lib/db/client';
import { accounts, sessions, users, verificationTokens } from '@/lib/db/schema/auth';
import { workspaceMembers, workspaces } from '@/lib/db/schema/workspaces';
import { auditLog } from '@/lib/db/schema/audit';

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
      // Inject id and platform role onto session.user for downstream code.
      // The shape is augmented in src/types/next-auth.d.ts.
      session.user.id = user.id;
      // The Drizzle adapter returns the full user row including custom columns.
      const role = (user as { role?: 'member' | 'super_admin' }).role ?? 'member';
      session.user.role = role;
      return session;
    },
  },
  events: {
    async signIn({ user, isNewUser }) {
      if (!user.id || !user.email) return;
      const email = user.email.toLowerCase().trim();

      // Always update lastSignedInAt; cheap and useful.
      await db
        .update(users)
        .set({ lastSignedInAt: new Date() })
        .where(eq(users.id, user.id));

      // Bootstrap path. The very first sign-in by OWNER_EMAIL is auto-promoted
      // to super_admin and seeded with a personal workspace.
      if (isNewUser && ownerEmail !== null && email === ownerEmail) {
        await db.update(users).set({ role: 'super_admin' }).where(eq(users.id, user.id));

        const [created] = await db
          .insert(workspaces)
          .values({
            name: 'Personal',
            slug: `personal-${crypto.randomUUID().slice(0, 8)}`,
            ownerUserId: user.id,
          })
          .returning();

        if (created) {
          await db.insert(workspaceMembers).values({
            workspaceId: created.id,
            userId: user.id,
            role: 'owner',
          });

          await db.insert(auditLog).values({
            workspaceId: created.id,
            userId: user.id,
            kind: 'workspace.bootstrap',
            entityType: 'workspace',
            entityId: String(created.id),
            payload: { reason: 'owner_email_first_login', email },
          });
        }
      }
    },
  },
});
