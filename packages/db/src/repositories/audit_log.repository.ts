import type { Kysely } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import type { Database, AuditLogsTable } from '../types.js';

export type AuditLog = AuditLogsTable;

export interface CreateAuditLogInput {
  id?: string;
  actor_id: string;
  actor_type: 'USER' | 'SERVICE_ACCOUNT' | 'SYSTEM' | string;
  action: string;
  resource_type: string;
  resource_id: string;
  project_id?: string | null;
  diff?: Record<string, any> | string;
  ip_address?: string | null;
  user_agent?: string | null;
  created_at?: string;
}

export class AuditLogRepository {
  constructor(private db: Kysely<Database>) {}

  async create(input: CreateAuditLogInput): Promise<AuditLog> {
    const now = new Date().toISOString();
    const id = input.id || uuidv7();
    const diffStr =
      typeof input.diff === 'object'
        ? JSON.stringify(input.diff)
        : input.diff || '{}';

    const log = {
      id,
      actor_id: input.actor_id,
      actor_type: input.actor_type,
      action: input.action,
      resource_type: input.resource_type,
      resource_id: input.resource_id,
      project_id: input.project_id ?? null,
      diff: diffStr,
      ip_address: input.ip_address ?? null,
      user_agent: input.user_agent ?? null,
      created_at: input.created_at ?? now,
    };

    await this.db.insertInto('audit_logs').values(log).execute();
    return (await this.findById(id))!;
  }

  async findById(id: string): Promise<AuditLog | undefined> {
    return await this.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
  }

  async findByResource(resourceType: string, resourceId: string): Promise<AuditLog[]> {
    return await this.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('resource_type', '=', resourceType)
      .where('resource_id', '=', resourceId)
      .orderBy('created_at', 'desc')
      .execute();
  }

  async findByActor(actorId: string): Promise<AuditLog[]> {
    return await this.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('actor_id', '=', actorId)
      .orderBy('created_at', 'desc')
      .execute();
  }

  async findByProject(projectId: string): Promise<AuditLog[]> {
    return await this.db
      .selectFrom('audit_logs')
      .selectAll()
      .where('project_id', '=', projectId)
      .orderBy('created_at', 'desc')
      .execute();
  }
}
