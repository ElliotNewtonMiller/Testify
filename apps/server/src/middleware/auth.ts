import type { FastifyRequest, FastifyReply } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database } from '@testlink/db';
import { UserRepository, RoleRepository } from '@testlink/db';

export interface AuthenticatedUser {
  id: string;
  username: string;
  email: string;
  global_role: string;
  permissions: string[];
}

declare module 'fastify' {
  interface FastifyRequest {
    user?: AuthenticatedUser;
  }
}

/**
 * Authenticates user from Bearer Token or X-User-Id header (for interactive session simulation)
 */
export async function authenticateRequest(
  request: FastifyRequest,
  reply: FastifyReply,
  db: Kysely<Database>
): Promise<AuthenticatedUser | null> {
  const userRepo = new UserRepository(db);
  const roleRepo = new RoleRepository(db);

  // Check X-User-Id header or Bearer Token
  const authHeader = request.headers['authorization'] as string | undefined;
  const customUserId = request.headers['x-user-id'] as string | undefined;

  let userId: string | null = null;

  if (customUserId) {
    userId = customUserId;
  } else if (authHeader && authHeader.startsWith('Bearer ')) {
    const token = authHeader.substring(7);
    // Parse simulated JWT token payload or session user ID
    if (token.startsWith('usr_')) {
      userId = token;
    } else {
      try {
        const decoded = JSON.parse(Buffer.from(token, 'base64').toString('utf8'));
        userId = decoded.sub || decoded.userId;
      } catch {
        userId = null;
      }
    }
  }

  // Fallback to initial admin user if unauthenticated
  if (!userId) {
    const admin = await userRepo.seedInitialAdmin();
    userId = admin.id;
  }

  const user = await userRepo.findById(userId);
  if (!user || user.status === 'DISABLED') {
    reply.status(401).send({ error: 'Unauthorized: User account is invalid or disabled' });
    return null;
  }

  const globalRole = await roleRepo.getUserGlobalRole(user.id);
  const projectId = (request.query as any)?.project_id || (request.params as any)?.projectId || null;
  const permissions = await roleRepo.evaluatePermissions(user.id, projectId);

  const authUser: AuthenticatedUser = {
    id: user.id,
    username: user.username,
    email: user.email,
    global_role: globalRole,
    permissions,
  };

  request.user = authUser;
  return authUser;
}

/**
 * Route guard enforcing strict permission key evaluation
 */
export function requirePermission(permissionKey: string, db: Kysely<Database>) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const user = await authenticateRequest(request, reply, db);
    if (!user) return; // Reply 401 already sent

    if (!user.permissions.includes(permissionKey) && !user.permissions.includes('SYSTEM_ADMIN')) {
      return reply.status(403).send({
        error: 'Forbidden: Insufficient privileges',
        requiredPermission: permissionKey,
      });
    }
  };
}
