import type { Kysely, Selectable, Insertable, Updateable } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import crypto from 'node:crypto';
import type { Database, UsersTable, UserRolesTable, UserProjectRolesTable } from '../types.js';
import { validatePasswordPolicy } from '../../../core/src/security/passwordPolicy.js';

export type User = Selectable<UsersTable>;
export type NewUser = Insertable<UsersTable>;
export type UserUpdate = Updateable<UsersTable>;

export interface CreateUserInput {
  id?: string;
  username: string;
  email: string;
  password: string;
  global_role?: 'Admin' | 'Test Lead' | 'Tester' | 'Viewer';
  status?: 'ACTIVE' | 'DISABLED';
}

export interface UpdateCredentialsInput {
  userId: string;
  newUsername?: string;
  newEmail?: string;
  newPassword?: string;
}

export function hashPassword(password: string, saltHex?: string): { hash: string; salt: string } {
  const salt = saltHex || crypto.randomBytes(16).toString('hex');
  const derivedKey = crypto.pbkdf2Sync(password, salt, 100000, 64, 'sha512');
  return { hash: derivedKey.toString('hex'), salt };
}

export function verifyPassword(password: string, storedHash: string, salt: string): boolean {
  const { hash } = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(storedHash, 'hex'));
}

export class UserRepository {
  constructor(private db: Kysely<Database>) {}

  /**
   * Seeds initial omnipotent superuser (admin / password) on startup if no users exist.
   */
  async seedInitialAdmin(): Promise<User> {
    const existing = await this.db.selectFrom('users').selectAll().executeTakeFirst();
    if (existing) {
      return existing;
    }

    const now = new Date().toISOString();
    const adminId = '0191c4d0-0000-7000-8000-000000000001';
    const { hash, salt } = hashPassword('password');

    const adminUser: NewUser = {
      id: adminId,
      username: 'admin',
      email: 'admin@testify.local',
      password_hash: `${salt}:${hash}`,
      status: 'ACTIVE',
      created_at: now,
      updated_at: now,
    };

    await this.db.transaction().execute(async (trx) => {
      await trx.insertInto('users').values(adminUser).execute();
      await trx
        .insertInto('user_roles')
        .values({
          id: uuidv7(),
          user_id: adminId,
          role: 'Admin',
          created_at: now,
        })
        .execute();
    });

    return (await this.findById(adminId))!;
  }

  async create(input: CreateUserInput): Promise<User> {
    // Validate password complexity
    const validation = validatePasswordPolicy(input.password);
    if (!validation.valid) {
      throw new Error(`PASSWORD_POLICY_VIOLATION: ${validation.reason}`);
    }

    const now = new Date().toISOString();
    const id = input.id || uuidv7();
    const { hash, salt } = hashPassword(input.password);

    const newUser: NewUser = {
      id,
      username: input.username,
      email: input.email,
      password_hash: `${salt}:${hash}`,
      status: input.status ?? 'ACTIVE',
      created_at: now,
      updated_at: now,
    };

    const globalRole = input.global_role ?? 'Tester';

    await this.db.transaction().execute(async (trx) => {
      await trx.insertInto('users').values(newUser).execute();
      await trx
        .insertInto('user_roles')
        .values({
          id: uuidv7(),
          user_id: id,
          role: globalRole,
          created_at: now,
        })
        .execute();
    });

    return (await this.findById(id))!;
  }

  async findById(id: string): Promise<User | undefined> {
    return await this.db.selectFrom('users').selectAll().where('id', '=', id).executeTakeFirst();
  }

  async findByUsernameOrEmail(identifier: string): Promise<User | undefined> {
    return await this.db
      .selectFrom('users')
      .selectAll()
      .where((eb) => eb.or([eb('username', '=', identifier), eb('email', '=', identifier)]))
      .executeTakeFirst();
  }

  async findAll(): Promise<User[]> {
    return await this.db.selectFrom('users').selectAll().orderBy('created_at', 'asc').execute();
  }

  async updateCredentials(input: UpdateCredentialsInput): Promise<User> {
    const user = await this.findById(input.userId);
    if (!user) {
      throw new Error(`User with ID '${input.userId}' not found`);
    }

    const now = new Date().toISOString();
    const updateData: UserUpdate = { updated_at: now };

    if (input.newUsername) updateData.username = input.newUsername;
    if (input.newEmail) updateData.email = input.newEmail;

    if (input.newPassword) {
      const validation = validatePasswordPolicy(input.newPassword);
      if (!validation.valid) {
        throw new Error(`PASSWORD_POLICY_VIOLATION: ${validation.reason}`);
      }
      const { hash, salt } = hashPassword(input.newPassword);
      updateData.password_hash = `${salt}:${hash}`;
    }

    await this.db.updateTable('users').set(updateData).where('id', '=', input.userId).execute();
    return (await this.findById(input.userId))!;
  }

  async updateStatus(userId: string, status: 'ACTIVE' | 'DISABLED'): Promise<User> {
    const now = new Date().toISOString();
    await this.db.updateTable('users').set({ status, updated_at: now }).where('id', '=', userId).execute();
    return (await this.findById(userId))!;
  }

  async verifyCredentials(identifier: string, password: string): Promise<User | null> {
    const user = await this.findByUsernameOrEmail(identifier);
    if (!user || user.status === 'DISABLED') {
      return null;
    }

    const [salt, storedHash] = user.password_hash.split(':');
    if (!salt || !storedHash) return null;

    const isValid = verifyPassword(password, storedHash, salt);
    return isValid ? user : null;
  }
}
