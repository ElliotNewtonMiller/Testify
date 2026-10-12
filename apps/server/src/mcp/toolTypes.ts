import type { FastifyRequest } from 'fastify';
import type { AuthenticatedUser } from '../middleware/auth.js';

export type JsonSchema = Record<string, unknown>;

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  /** Changes things (the write tools): listed with readOnlyHint false, and audit-logged. */
  write?: { permissions: string[]; destructive?: boolean; idempotent?: boolean };
  run: (args: Record<string, any>, user: AuthenticatedUser, request: FastifyRequest) => Promise<string>;
}

/** A tool's failure, shown to the agent as an error result (isError) with this message. */
export class ToolError extends Error {}

export const json = (value: unknown) => JSON.stringify(value);
