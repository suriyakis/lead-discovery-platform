import { DrizzleAdapter } from '@auth/drizzle-adapter';
import { and, eq, isNull } from 'drizzle-orm';
import NextAuth from 'next-auth';
import Google from 'next-auth/providers/google';
import { db } from '@/lib/db/client';
import {
  accounts,
  preauthorizedEmails,
  sessions,
  users,
  verificationTokens,
} from '@/lib/db/schema/auth';
import { workspaceMembers, workspaces } from '@/lib/db/schema/workspaces';
import { auditLog } from '@/lib/db/schema/audit';
import type { WorkspaceMemberRole } from '@/lib/db/schema/workspaces';

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
      const email = user.email.toLowerCase().trim();

      // Always update lastSignedInAt; cheap and useful.
      await db
        .update(users)
        .set({ lastSignedInAt: new Date() })
        .where(eq(users.id, user.id));

      // Bootstrap path. The very first sign-in by OWNER_EMAIL is auto-
      // promoted to super_admin + seeded with a personal workspace + lifted
      // out of pending.
      if (isNewUser && ownerEmail !== null && email === ownerEmail) {
        await db
          .update(users)
          .set({
            role: 'super_admin',
            accountStatus: 'active',
            accountStatusUpdatedAt: new Date(),
            accountStatusUpdatedBy: user.id,
          })
          .where(eq(users.id, user.id));

        const [created] = await db
          .insert(workspaces)
          .values({
            name: 'Personal',
            slug: `personal-${crypto.randomUUID().slice(0, 8)}`,
            ownerUserId: user.id,
            // Phase 47: bootstrap workspaces start in onboarding so the
            // first-time sign-in flow walks the operator through setup.
            onboardingStatus: 'pending',
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
        return;
      }

      // Pre-authorize path. New users whose email is on the
      // preauthorized_emails allow-list get lifted to active immediately
      // and dropped into the named workspace at the named role.
      if (isNewUser) {
        const preauth = await db
          .select()
          .from(preauthorizedEmails)
          .where(
            and(
              eq(preauthorizedEmails.email, email),
              isNull(preauthorizedEmails.consumedAt),
            ),
          )
          .limit(1);

        if (preauth[0]) {
          const entry = preauth[0];
          await db
            .update(users)
            .set({
              accountStatus: 'active',
              accountStatusUpdatedAt: new Date(),
              accountStatusUpdatedBy: entry.createdBy ?? null,
            })
            .where(eq(users.id, user.id));

          if (entry.workspaceId) {
            const wsId = BigInt(entry.workspaceId);
            await db
              .insert(workspaceMembers)
              .values({
                workspaceId: wsId,
                userId: user.id,
                role: (entry.role as WorkspaceMemberRole) ?? 'member',
              })
              .onConflictDoNothing();
            await db.insert(auditLog).values({
              workspaceId: wsId,
              userId: entry.createdBy ?? user.id,
              kind: 'user.preauthorize_consumed',
              entityType: 'user',
              entityId: user.id,
              payload: { email, role: entry.role },
            });
          }

          await db
            .update(preauthorizedEmails)
            .set({ consumedAt: new Date() })
            .where(eq(preauthorizedEmails.id, entry.id));
        }
      }
    },
  },
});
