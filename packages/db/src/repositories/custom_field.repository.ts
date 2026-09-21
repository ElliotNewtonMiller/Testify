import type { Kysely, Updateable } from 'kysely';
import { v7 as uuidv7 } from 'uuid';
import type { Database, CustomFieldDefinitionsTable } from '../types.js';
import {
  CUSTOM_FIELD_TYPES,
  CUSTOM_FIELD_ENTITY_TYPES,
  parseCustomFieldValue,
  readCustomFieldValue,
  type CustomFieldType,
  type CustomFieldEntityType,
} from '@testify/core';

export interface CustomFieldOption {
  id?: string;
  option_label: string;
  option_value: string;
  position?: number;
}

export interface CustomFieldDefinition {
  id: string;
  project_id: string | null;
  entity_type: CustomFieldEntityType;
  name: string;
  field_label: string;
  field_type: CustomFieldType;
  is_required: boolean;
  default_value: string | null;
  validation_regex: string | null;
  options: CustomFieldOption[];
  created_at: string;
  updated_at: string;
}

export interface CreateCustomFieldDefinitionInput {
  id?: string;
  // Omitted/null (default): a global field, exactly today's only behavior. A string scopes
  // the field to that one project -- used by the import wizard's AUTO_CREATE path.
  project_id?: string | null;
  entity_type: CustomFieldEntityType;
  name: string;
  field_label: string;
  field_type: CustomFieldType;
  is_required?: boolean;
  default_value?: string | null;
  validation_regex?: string | null;
  options?: Array<{ option_label: string; option_value: string }>;
}

/** entity_type and field_type are immutable after creation -- changing either would orphan
 * the meaning of any existing values, so they're deliberately not part of this input. */
export interface UpdateCustomFieldDefinitionInput {
  name?: string;
  field_label?: string;
  is_required?: boolean;
  default_value?: string | null;
  validation_regex?: string | null;
  options?: Array<{ option_label: string; option_value: string }>;
}

export type DeleteCustomFieldDefinitionResult =
  | { deleted: true }
  | { deleted: false; blockedByValueCount: number; affectedEntityIds: string[]; fieldLabel?: string };

export interface CustomFieldValueEntry {
  definition: CustomFieldDefinition;
  value: unknown;
}

export class CustomFieldRepository {
  constructor(private db: Kysely<Database>) {}

  /** Kysely doesn't support nesting `.transaction()` calls on an already-open Transaction
   * (e.g. when this repository is constructed with a `trx` handed down from a caller's own
   * `db.transaction().execute(...)`, as apps/server/src/routes/ingestion.ts's execute
   * handler does) -- runs `fn` directly against `this.db` in that case instead of opening a
   * redundant nested transaction, matching this codebase's established fix for the same
   * class of bug (see TestCaseVersionRepository's history). */
  private async runInTransaction<T>(fn: (trx: Kysely<Database>) => Promise<T>): Promise<T> {
    if ((this.db as any).isTransaction) {
      return fn(this.db);
    }
    return this.db.transaction().execute(fn);
  }

  private async attachOptions(definitions: Array<Omit<CustomFieldDefinition, 'options'>>): Promise<CustomFieldDefinition[]> {
    if (definitions.length === 0) return [];

    const optionRows = await this.db
      .selectFrom('custom_field_options')
      .selectAll()
      .where('custom_field_definition_id', 'in', definitions.map((d) => d.id))
      .orderBy('position', 'asc')
      .execute();

    const optionsByDefinitionId = new Map<string, CustomFieldOption[]>();
    for (const row of optionRows) {
      const list = optionsByDefinitionId.get(row.custom_field_definition_id) ?? [];
      list.push({ id: row.id, option_label: row.option_label, option_value: row.option_value, position: row.position });
      optionsByDefinitionId.set(row.custom_field_definition_id, list);
    }

    return definitions.map((d) => ({ ...d, options: optionsByDefinitionId.get(d.id) ?? [] }));
  }

  private toDefinition(row: CustomFieldDefinitionsTable & { id: string }): Omit<CustomFieldDefinition, 'options'> {
    return {
      id: row.id,
      project_id: row.project_id,
      entity_type: row.entity_type as CustomFieldEntityType,
      name: row.name,
      field_label: row.field_label,
      field_type: row.field_type as CustomFieldType,
      is_required: row.is_required === 1,
      default_value: row.default_value,
      validation_regex: row.validation_regex,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  /** `projectId` omitted/undefined: today's exact behavior, global-only (project_id IS
   * NULL). A string: that project's OWN definitions only, NOT merged with global -- callers
   * wanting "global ∪ project" use listVisibleToProject() below instead. No existing caller
   * passes a second argument, so this is fully backward compatible. */
  async listDefinitions(entityType?: CustomFieldEntityType, projectId?: string | null): Promise<CustomFieldDefinition[]> {
    let query = this.db.selectFrom('custom_field_definitions').selectAll();
    query = projectId === undefined ? query.where('project_id', 'is', null) : query.where('project_id', '=', projectId);
    if (entityType) {
      query = query.where('entity_type', '=', entityType);
    }
    const rows = await query.orderBy('name', 'asc').execute();
    return this.attachOptions(rows.map((r) => this.toDefinition(r)));
  }

  /** Returns the union of a project's own custom field definitions and every global
   * (project_id IS NULL) definition, for the given entity type -- the merge-list lookup the
   * import wizard's "map to existing field" dropdown and the ingestion routes' "is this
   * name already known" checks both need. Global definitions are listed first, then
   * project-scoped ones, both alphabetized. A project-scoped field is allowed to share a
   * name with a global field (they're validated against two separate uniqueness scopes),
   * so "name" is not a safe de-dupe key across this merged list. */
  async listVisibleToProject(projectId: string, entityType?: CustomFieldEntityType): Promise<CustomFieldDefinition[]> {
    let query = this.db
      .selectFrom('custom_field_definitions')
      .selectAll()
      .where((eb) => eb.or([eb('project_id', 'is', null), eb('project_id', '=', projectId)]));
    if (entityType) {
      query = query.where('entity_type', '=', entityType);
    }
    const rows = await query.execute();
    const sorted = rows
      .map((r) => this.toDefinition(r))
      .sort((a, b) => {
        if ((a.project_id === null) !== (b.project_id === null)) return a.project_id === null ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    return this.attachOptions(sorted);
  }

  /** `projectId` omitted/undefined: today's exact behavior, global-only lookup by id. A
   * string widens the lookup to also match that project's own definitions -- needed so
   * setValue() (below) can resolve a project-scoped definition id. */
  async getDefinition(id: string, projectId?: string | null): Promise<CustomFieldDefinition | undefined> {
    let query = this.db.selectFrom('custom_field_definitions').selectAll().where('id', '=', id);
    // null and undefined both mean "global-only, today's exact behavior" -- only an actual
    // project id string widens the lookup to also match that project's own definitions.
    query =
      projectId == null
        ? query.where('project_id', 'is', null)
        : query.where((eb) => eb.or([eb('project_id', 'is', null), eb('project_id', '=', projectId)]));
    const row = await query.executeTakeFirst();
    if (!row) return undefined;
    const [definition] = await this.attachOptions([this.toDefinition(row)]);
    return definition;
  }

  /** Name uniqueness pre-check, scoped by `projectId` (null = global scope, a string = that
   * project's own scope), mirroring role.repository.ts's roleExists/ROLE_NAME_TAKEN
   * convention. The migration's two partial unique indexes back this at the DB level too,
   * as a race-condition safety net -- this check is what produces the friendly error
   * message. */
  private async nameTaken(entityType: CustomFieldEntityType, name: string, projectId: string | null, excludeId?: string): Promise<boolean> {
    let query = this.db
      .selectFrom('custom_field_definitions')
      .select('id')
      .where('entity_type', '=', entityType)
      .where('name', '=', name);
    query = projectId === null ? query.where('project_id', 'is', null) : query.where('project_id', '=', projectId);
    if (excludeId) {
      query = query.where('id', '!=', excludeId);
    }
    const row = await query.executeTakeFirst();
    return Boolean(row);
  }

  async createDefinition(input: CreateCustomFieldDefinitionInput): Promise<CustomFieldDefinition> {
    if (!CUSTOM_FIELD_ENTITY_TYPES.includes(input.entity_type)) {
      throw new Error(`UNKNOWN_ENTITY_TYPE: '${input.entity_type}' is not a registered custom field entity type`);
    }
    if (!CUSTOM_FIELD_TYPES.includes(input.field_type)) {
      throw new Error(`UNKNOWN_FIELD_TYPE: '${input.field_type}' is not a registered custom field type`);
    }
    const scopedProjectId = input.project_id ?? null;
    if (await this.nameTaken(input.entity_type, input.name, scopedProjectId)) {
      const scope = scopedProjectId === null ? 'global' : `project-scoped (project ${scopedProjectId})`;
      throw new Error(`FIELD_NAME_TAKEN: a ${scope} '${input.entity_type}' field named '${input.name}' already exists`);
    }

    const now = new Date().toISOString();
    const id = input.id || uuidv7();

    await this.runInTransaction(async (trx) => {
      await trx
        .insertInto('custom_field_definitions')
        .values({
          id,
          project_id: scopedProjectId,
          entity_type: input.entity_type,
          name: input.name,
          field_label: input.field_label,
          field_type: input.field_type,
          is_required: input.is_required ? 1 : 0,
          default_value: input.default_value ?? null,
          validation_regex: input.validation_regex ?? null,
          created_at: now,
          updated_at: now,
        })
        .execute();

      if (input.options && input.options.length > 0) {
        await trx
          .insertInto('custom_field_options')
          .values(
            input.options.map((o, i) => ({
              id: uuidv7(),
              custom_field_definition_id: id,
              option_label: o.option_label,
              option_value: o.option_value,
              position: i,
            }))
          )
          .execute();
      }
    });

    return (await this.getDefinition(id, scopedProjectId))!;
  }

  async updateDefinition(id: string, input: UpdateCustomFieldDefinitionInput): Promise<CustomFieldDefinition | undefined> {
    const existing = await this.getDefinitionAnyScope(id);
    if (!existing) return undefined;

    if (
      input.name !== undefined &&
      input.name !== existing.name &&
      (await this.nameTaken(existing.entity_type, input.name, existing.project_id, id))
    ) {
      const scope = existing.project_id === null ? 'global' : `project-scoped (project ${existing.project_id})`;
      throw new Error(`FIELD_NAME_TAKEN: a ${scope} '${existing.entity_type}' field named '${input.name}' already exists`);
    }

    const now = new Date().toISOString();

    await this.runInTransaction(async (trx) => {
      const updateData: Updateable<CustomFieldDefinitionsTable> = { updated_at: now };
      if (input.name !== undefined) updateData.name = input.name;
      if (input.field_label !== undefined) updateData.field_label = input.field_label;
      if (input.is_required !== undefined) updateData.is_required = input.is_required ? 1 : 0;
      if (input.default_value !== undefined) updateData.default_value = input.default_value;
      if (input.validation_regex !== undefined) updateData.validation_regex = input.validation_regex;

      await trx.updateTable('custom_field_definitions').set(updateData).where('id', '=', id).execute();

      if (input.options) {
        await trx.deleteFrom('custom_field_options').where('custom_field_definition_id', '=', id).execute();
        if (input.options.length > 0) {
          await trx
            .insertInto('custom_field_options')
            .values(
              input.options.map((o, i) => ({
                id: uuidv7(),
                custom_field_definition_id: id,
                option_label: o.option_label,
                option_value: o.option_value,
                position: i,
              }))
            )
            .execute();
        }
      }
    });

    return this.getDefinitionAnyScope(id);
  }

  /** Fetches a definition by id regardless of scope (global or any project) -- a PK lookup
   * is already maximally specific, so no project_id filter is needed or protective here.
   * Used internally by updateDefinition/deleteDefinition, which must be able to find and
   * act on a project-scoped definition, not just a global one. */
  private async getDefinitionAnyScope(id: string): Promise<CustomFieldDefinition | undefined> {
    const row = await this.db.selectFrom('custom_field_definitions').selectAll().where('id', '=', id).executeTakeFirst();
    if (!row) return undefined;
    const [definition] = await this.attachOptions([this.toDefinition(row)]);
    return definition;
  }

  /**
   * Deletes a field definition. Unlike role.repository.ts's deleteRole (which hard-blocks
   * deletion while a role is in use), a definition with recorded values is only blocked
   * when `force` is not set -- the caller is expected to warn the admin with the returned
   * count and re-call with `force: true` to proceed and permanently discard that data.
   */
  async deleteDefinition(id: string, opts: { force?: boolean } = {}): Promise<DeleteCustomFieldDefinitionResult> {
    const definition = await this.db
      .selectFrom('custom_field_definitions')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!definition) {
      return { deleted: false, blockedByValueCount: 0, affectedEntityIds: [] };
    }

    const valueRows = await this.db
      .selectFrom('custom_field_values')
      .select('entity_id')
      .distinct()
      .where('custom_field_definition_id', '=', id)
      .execute();
    const affectedEntityIds = valueRows.map((r) => r.entity_id);

    if (affectedEntityIds.length > 0 && !opts.force) {
      return { deleted: false, blockedByValueCount: affectedEntityIds.length, affectedEntityIds, fieldLabel: definition.field_label };
    }

    await this.runInTransaction(async (trx) => {
      await trx.deleteFrom('custom_field_values').where('custom_field_definition_id', '=', id).execute();
      await trx.deleteFrom('custom_field_options').where('custom_field_definition_id', '=', id).execute();
      await trx.deleteFrom('custom_field_definitions').where('id', '=', id).execute();
    });

    return { deleted: true };
  }

  /** All custom field values for one case/suite, joined with their definitions, in one
   * round-trip -- for hydrating a case/suite detail pane. `projectId` omitted: global
   * fields only (today's exact behavior). Pass the entity's own project id to also include
   * that project's own definitions (e.g. ones created by the import wizard's AUTO_CREATE
   * path) -- this is what makes an imported field's value actually show up here. */
  async getValuesForEntity(entityType: CustomFieldEntityType, entityId: string, projectId?: string): Promise<CustomFieldValueEntry[]> {
    const definitions = projectId ? await this.listVisibleToProject(projectId, entityType) : await this.listDefinitions(entityType);
    if (definitions.length === 0) return [];

    const valueRows = await this.db
      .selectFrom('custom_field_values')
      .selectAll()
      .where('entity_type', '=', entityType)
      .where('entity_id', '=', entityId)
      .where('custom_field_definition_id', 'in', definitions.map((d) => d.id))
      .execute();
    const valueRowByDefinitionId = new Map(valueRows.map((r) => [r.custom_field_definition_id, r]));

    return definitions.map((definition) => {
      const row = valueRowByDefinitionId.get(definition.id);
      const value = row
        ? readCustomFieldValue(definition.field_type, {
            string_value: row.string_value,
            number_value: row.number_value,
            boolean_value: row.boolean_value,
            date_value: row.date_value,
            json_value: row.json_value,
          })
        : null;
      return { definition, value };
    });
  }

  /** Batched sibling of getValuesForEntity() -- fetches every definition's value for every
   * entity in `entityIds` in one round-trip (one listVisibleToProject/listDefinitions call +
   * one custom_field_values query with entity_id IN (...)), instead of one getValuesForEntity
   * call per entity. Built for export, which needs this across potentially hundreds of cases
   * in a single request. Every entity id always gets an entry in the returned Map (possibly
   * [] if there are no visible definitions), and every definition always gets a
   * CustomFieldValueEntry per entity (value: null if unset), matching getValuesForEntity's
   * per-definition-always-present contract. */
  async getValuesForEntities(
    entityType: CustomFieldEntityType,
    entityIds: string[],
    projectId?: string
  ): Promise<Map<string, CustomFieldValueEntry[]>> {
    if (entityIds.length === 0) return new Map();

    const definitions = projectId ? await this.listVisibleToProject(projectId, entityType) : await this.listDefinitions(entityType);
    if (definitions.length === 0) {
      return new Map(entityIds.map((id) => [id, []]));
    }

    const valueRows = await this.db
      .selectFrom('custom_field_values')
      .selectAll()
      .where('entity_type', '=', entityType)
      .where('entity_id', 'in', entityIds)
      .where('custom_field_definition_id', 'in', definitions.map((d) => d.id))
      .execute();

    const rowByKey = new Map(valueRows.map((r) => [`${r.entity_id}::${r.custom_field_definition_id}`, r]));

    const result = new Map<string, CustomFieldValueEntry[]>();
    for (const entityId of entityIds) {
      result.set(
        entityId,
        definitions.map((definition) => {
          const row = rowByKey.get(`${entityId}::${definition.id}`);
          const value = row
            ? readCustomFieldValue(definition.field_type, {
                string_value: row.string_value,
                number_value: row.number_value,
                boolean_value: row.boolean_value,
                date_value: row.date_value,
                json_value: row.json_value,
              })
            : null;
          return { definition, value };
        })
      );
    }
    return result;
  }

  /** Validates `rawValue` against the definition's field_type/options/validation_regex via
   * @testify/core's parseCustomFieldValue (throwing INVALID_FIELD_VALUE/REQUIRED_FIELD_MISSING
   * on failure), then updates the existing value row for this (definition, entity) pair or
   * inserts a new one -- never accumulating duplicates on repeated edits. `projectId`
   * (optional) widens the internal definition lookup to also match that project's own
   * definitions, not just global ones -- required for writing a value against a
   * project-scoped field (e.g. one created by the import wizard). */
  async setValue(definitionId: string, entityType: CustomFieldEntityType, entityId: string, rawValue: unknown, projectId?: string): Promise<unknown> {
    const definition = await this.getDefinition(definitionId, projectId);
    if (!definition) {
      throw new Error(`UNKNOWN_FIELD: no custom field definition with id '${definitionId}'`);
    }

    const typedValue = parseCustomFieldValue(definition.field_type, rawValue, {
      validationRegex: definition.validation_regex,
      options: definition.options,
      isRequired: definition.is_required,
    });

    const now = new Date().toISOString();
    const existing = await this.db
      .selectFrom('custom_field_values')
      .select('id')
      .where('custom_field_definition_id', '=', definitionId)
      .where('entity_type', '=', entityType)
      .where('entity_id', '=', entityId)
      .executeTakeFirst();

    await this.runInTransaction(async (trx) => {
      if (existing) {
        await trx
          .updateTable('custom_field_values')
          .set({ ...typedValue, updated_at: now })
          .where('id', '=', existing.id)
          .execute();
      } else {
        await trx
          .insertInto('custom_field_values')
          .values({
            id: uuidv7(),
            custom_field_definition_id: definitionId,
            entity_type: entityType,
            entity_id: entityId,
            ...typedValue,
            created_at: now,
            updated_at: now,
          })
          .execute();
      }
    });

    return readCustomFieldValue(definition.field_type, typedValue);
  }

  async deleteValue(definitionId: string, entityType: CustomFieldEntityType, entityId: string): Promise<void> {
    await this.db
      .deleteFrom('custom_field_values')
      .where('custom_field_definition_id', '=', definitionId)
      .where('entity_type', '=', entityType)
      .where('entity_id', '=', entityId)
      .execute();
  }
}
