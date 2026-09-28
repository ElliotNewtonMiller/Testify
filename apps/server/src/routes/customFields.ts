import type { FastifyInstance } from 'fastify';
import type { Kysely } from 'kysely';
import type { Database } from '@testify/db';
import { CustomFieldRepository, TestCaseRepository, TestSuiteRepository } from '@testify/db';
import {
  CUSTOM_FIELD_TYPES,
  CUSTOM_FIELD_ENTITY_TYPES,
  resolveDefaultValue,
  type CustomFieldEntityType,
  type CustomFieldType,
} from '@testify/core';
import { authenticateRequest, requirePermission } from '../middleware/auth.js';
import { sendCustomFieldInUseError, sendProblemDetails } from '../errors.js';

function isEntityType(value: unknown): value is CustomFieldEntityType {
  return typeof value === 'string' && (CUSTOM_FIELD_ENTITY_TYPES as readonly string[]).includes(value);
}

/**
 * A required field must ship with a usable default, so every already-existing case/suite has
 * a value for it from the moment the field exists (defaults are applied to entities that have
 * no value row yet -- see CustomFieldRepository.getValuesForEntity). Without one, every
 * pre-existing record would instantly be missing a required value. Returns the error message
 * to show, or null when the combination is fine.
 */
function requiredFieldDefaultError(
  isRequired: boolean,
  fieldType: CustomFieldType,
  defaultValue: string | null | undefined,
  options: Array<{ option_value: string }> | undefined
): string | null {
  if (!isRequired) return null;
  if (defaultValue === null || defaultValue === undefined || String(defaultValue).trim() === '') {
    return (
      'A required custom field must have a default value. Existing test cases and suites need an initial ' +
      'value for it, so provide one in the Default Value field (it is applied to every record that has no value yet).'
    );
  }
  if (resolveDefaultValue(fieldType, String(defaultValue), { options }) === null) {
    return `The default value '${defaultValue}' is not valid for a ${fieldType} field, so existing records would still have no value. Provide a valid default value.`;
  }
  return null;
}

/**
 * Global admin-defined custom fields for Test Cases and Test Suites -- a parallel,
 * independent system from routes/ingestion.ts's project-scoped, entity_type
 * 'TestCaseVersion' custom fields created during XML/CSV/JSON import reconciliation.
 * See CustomFieldRepository for why the two never collide (different entity_type values,
 * always-null vs. always-set project_id).
 */
export async function registerCustomFieldRoutes(app: FastifyInstance, db: Kysely<Database>, jwtSecret: string) {
  const fieldRepo = new CustomFieldRepository(db);
  const caseRepo = new TestCaseRepository(db);
  const suiteRepo = new TestSuiteRepository(db);

  // ---- Definition CRUD (admin-only, gated by CUSTOM_FIELD_MANAGE) ----

  app.get(
    '/api/v1/admin/custom-fields',
    { preHandler: requirePermission('CUSTOM_FIELD_MANAGE', db, jwtSecret) },
    async (request) => {
      const { entity_type: entityType } = request.query as { entity_type?: string };
      const definitions = await fieldRepo.listDefinitions(isEntityType(entityType) ? entityType : undefined);
      return { definitions };
    }
  );

  app.post(
    '/api/v1/admin/custom-fields',
    { preHandler: requirePermission('CUSTOM_FIELD_MANAGE', db, jwtSecret) },
    async (request, reply) => {
      const activeUser = request.user!;
      const { entity_type: entityType, name, field_label, field_type, is_required, default_value, validation_regex, options } =
        (request.body as any) || {};

      if (!isEntityType(entityType)) {
        return reply.status(400).send({ error: `entity_type must be one of: ${CUSTOM_FIELD_ENTITY_TYPES.join(', ')}` });
      }
      if (!name || typeof name !== 'string' || !field_label || typeof field_label !== 'string') {
        return reply.status(400).send({ error: 'name and field_label (strings) are required' });
      }
      if (!(CUSTOM_FIELD_TYPES as readonly string[]).includes(field_type)) {
        return reply.status(400).send({ error: `field_type must be one of: ${CUSTOM_FIELD_TYPES.join(', ')}` });
      }

      const requiredError = requiredFieldDefaultError(
        Boolean(is_required),
        field_type,
        default_value,
        Array.isArray(options) ? options : undefined
      );
      if (requiredError) {
        return reply.status(422).send({ error: requiredError, code: 'REQUIRED_FIELD_NEEDS_DEFAULT' });
      }

      try {
        const definition = await fieldRepo.createDefinition({
          entity_type: entityType,
          name,
          field_label,
          field_type,
          is_required: Boolean(is_required),
          default_value: default_value ?? null,
          validation_regex: validation_regex ?? null,
          options: Array.isArray(options) ? options : undefined,
        });

        const now = new Date().toISOString();
        await db
          .insertInto('audit_logs')
          .values({
            id: crypto.randomUUID(),
            actor_id: activeUser.id,
            actor_type: 'USER',
            action: 'CUSTOM_FIELD_DEFINITION_CREATED',
            resource_type: 'custom_field_definition',
            resource_id: definition.id,
            diff: JSON.stringify({ entity_type: entityType, name, field_label, field_type }),
            ip_address: '127.0.0.1',
            user_agent: 'TestifyAdminService',
            created_at: now,
          })
          .execute();

        return reply.status(201).send({ definition });
      } catch (err: any) {
        if (err.message?.startsWith('UNKNOWN_ENTITY_TYPE') || err.message?.startsWith('UNKNOWN_FIELD_TYPE')) {
          return reply.status(400).send({ error: err.message });
        }
        if (err.message?.startsWith('FIELD_NAME_TAKEN')) {
          return reply.status(409).send({ error: err.message });
        }
        return reply.status(500).send({ error: err.message || 'Failed to create custom field' });
      }
    }
  );

  app.put(
    '/api/v1/admin/custom-fields/:id',
    { preHandler: requirePermission('CUSTOM_FIELD_MANAGE', db, jwtSecret) },
    async (request, reply) => {
      const activeUser = request.user!;
      const { id } = request.params as { id: string };
      const { name, field_label, is_required, default_value, validation_regex, options } = (request.body as any) || {};

      const existing = await fieldRepo.getDefinition(id);
      if (!existing) {
        return reply.status(404).send({ error: 'Custom field not found' });
      }
      const requiredError = requiredFieldDefaultError(
        is_required !== undefined ? Boolean(is_required) : existing.is_required,
        existing.field_type,
        default_value !== undefined ? default_value : existing.default_value,
        Array.isArray(options) ? options : existing.options
      );
      if (requiredError) {
        return reply.status(422).send({ error: requiredError, code: 'REQUIRED_FIELD_NEEDS_DEFAULT' });
      }

      try {
        const definition = await fieldRepo.updateDefinition(id, {
          name: typeof name === 'string' ? name : undefined,
          field_label: typeof field_label === 'string' ? field_label : undefined,
          is_required: is_required !== undefined ? Boolean(is_required) : undefined,
          default_value: default_value !== undefined ? default_value : undefined,
          validation_regex: validation_regex !== undefined ? validation_regex : undefined,
          options: Array.isArray(options) ? options : undefined,
        });

        if (!definition) {
          return reply.status(404).send({ error: 'Custom field not found' });
        }

        const now = new Date().toISOString();
        await db
          .insertInto('audit_logs')
          .values({
            id: crypto.randomUUID(),
            actor_id: activeUser.id,
            actor_type: 'USER',
            action: 'CUSTOM_FIELD_DEFINITION_UPDATED',
            resource_type: 'custom_field_definition',
            resource_id: id,
            diff: JSON.stringify({ name, field_label, is_required, default_value, validation_regex }),
            ip_address: '127.0.0.1',
            user_agent: 'TestifyAdminService',
            created_at: now,
          })
          .execute();

        return reply.status(200).send({ definition });
      } catch (err: any) {
        if (err.message?.startsWith('FIELD_NAME_TAKEN')) {
          return reply.status(409).send({ error: err.message });
        }
        return reply.status(500).send({ error: err.message || 'Failed to update custom field' });
      }
    }
  );

  // DELETE /api/v1/admin/custom-fields/:id?force=true -- warn-then-confirm delete. Without
  // `force`, a definition with recorded values is left untouched and reported via 409 with
  // the affected count; passing force=true (after the admin confirms) deletes it and all its
  // values for good. Deliberately more permissive than role.repository.ts's deleteRole,
  // which never allows deleting a role that's in use.
  app.delete(
    '/api/v1/admin/custom-fields/:id',
    { preHandler: requirePermission('CUSTOM_FIELD_MANAGE', db, jwtSecret) },
    async (request, reply) => {
      const activeUser = request.user!;
      const { id } = request.params as { id: string };
      const { force } = request.query as { force?: string };

      const result = await fieldRepo.deleteDefinition(id, { force: force === 'true' });
      if (!result.deleted) {
        if (result.blockedByValueCount === 0) {
          return reply.status(404).send({ error: 'Custom field not found' });
        }
        return sendCustomFieldInUseError(reply, id, result.blockedByValueCount, request.url, result.fieldLabel);
      }

      const now = new Date().toISOString();
      await db
        .insertInto('audit_logs')
        .values({
          id: crypto.randomUUID(),
          actor_id: activeUser.id,
          actor_type: 'USER',
          action: 'CUSTOM_FIELD_DEFINITION_DELETED',
          resource_type: 'custom_field_definition',
          resource_id: id,
          diff: JSON.stringify({ forced: force === 'true' }),
          ip_address: '127.0.0.1',
          user_agent: 'TestifyAdminService',
          created_at: now,
        })
        .execute();

      return reply.status(204).send();
    }
  );

  // ---- Value CRUD (Spec-mode curation surface: read is open to any authenticated user,
  // mutation is gated by PLAN_MANAGE, matching every other Spec-mode curation route in
  // testPlanCases.ts) ----

  app.get('/api/v1/test-cases/:caseId/custom-field-values', async (request, reply) => {
    const user = await authenticateRequest(request, reply, db, jwtSecret);
    if (!user) return;

    const { caseId } = request.params as { caseId: string };
    const testCase = await caseRepo.findById(caseId);
    if (!testCase) {
      return reply.status(404).send({ error: 'Test case not found' });
    }

    const values = await fieldRepo.getValuesForEntity('TestCase', caseId, testCase.project_id);
    return { values };
  });

  app.put(
    '/api/v1/test-cases/:caseId/custom-field-values/:definitionId',
    { preHandler: requirePermission('PLAN_MANAGE', db, jwtSecret) },
    async (request, reply) => {
      const { caseId, definitionId } = request.params as { caseId: string; definitionId: string };
      const { value } = (request.body as { value?: unknown }) || {};

      const testCase = await caseRepo.findById(caseId);
      if (!testCase) {
        return reply.status(404).send({ error: 'Test case not found' });
      }

      try {
        const savedValue = await fieldRepo.setValue(definitionId, 'TestCase', caseId, value, testCase.project_id);
        return reply.status(200).send({ value: savedValue });
      } catch (err: any) {
        if (err.message?.startsWith('UNKNOWN_FIELD')) {
          return reply.status(404).send({ error: err.message });
        }
        return sendProblemDetails(reply, {
          code: err.message?.split(':')[0] || 'INVALID_FIELD_VALUE',
          detail: err.message || 'Invalid custom field value',
          instance: request.url,
        });
      }
    }
  );

  app.delete(
    '/api/v1/test-cases/:caseId/custom-field-values/:definitionId',
    { preHandler: requirePermission('PLAN_MANAGE', db, jwtSecret) },
    async (request, reply) => {
      const { caseId, definitionId } = request.params as { caseId: string; definitionId: string };
      const testCase = await caseRepo.findById(caseId);
      if (!testCase) {
        return reply.status(404).send({ error: 'Test case not found' });
      }
      await fieldRepo.deleteValue(definitionId, 'TestCase', caseId);
      return reply.status(204).send();
    }
  );

  app.get('/api/v1/test-suites/:suiteId/custom-field-values', async (request, reply) => {
    const user = await authenticateRequest(request, reply, db, jwtSecret);
    if (!user) return;

    const { suiteId } = request.params as { suiteId: string };
    const suite = await suiteRepo.findById(suiteId);
    if (!suite) {
      return reply.status(404).send({ error: 'Test suite not found' });
    }

    const values = await fieldRepo.getValuesForEntity('TestSuite', suiteId, suite.project_id);
    return { values };
  });

  app.put(
    '/api/v1/test-suites/:suiteId/custom-field-values/:definitionId',
    { preHandler: requirePermission('PLAN_MANAGE', db, jwtSecret) },
    async (request, reply) => {
      const { suiteId, definitionId } = request.params as { suiteId: string; definitionId: string };
      const { value } = (request.body as { value?: unknown }) || {};

      const suite = await suiteRepo.findById(suiteId);
      if (!suite) {
        return reply.status(404).send({ error: 'Test suite not found' });
      }

      try {
        const savedValue = await fieldRepo.setValue(definitionId, 'TestSuite', suiteId, value, suite.project_id);
        return reply.status(200).send({ value: savedValue });
      } catch (err: any) {
        if (err.message?.startsWith('UNKNOWN_FIELD')) {
          return reply.status(404).send({ error: err.message });
        }
        return sendProblemDetails(reply, {
          code: err.message?.split(':')[0] || 'INVALID_FIELD_VALUE',
          detail: err.message || 'Invalid custom field value',
          instance: request.url,
        });
      }
    }
  );

  app.delete(
    '/api/v1/test-suites/:suiteId/custom-field-values/:definitionId',
    { preHandler: requirePermission('PLAN_MANAGE', db, jwtSecret) },
    async (request, reply) => {
      const { suiteId, definitionId } = request.params as { suiteId: string; definitionId: string };
      const suite = await suiteRepo.findById(suiteId);
      if (!suite) {
        return reply.status(404).send({ error: 'Test suite not found' });
      }
      await fieldRepo.deleteValue(definitionId, 'TestSuite', suiteId);
      return reply.status(204).send();
    }
  );
}
