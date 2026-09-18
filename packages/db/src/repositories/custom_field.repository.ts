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

  /** Always scoped to project_id IS NULL -- this repository never accepts a caller-supplied
   * project_id anywhere, which is the sole enforcement point for "global only" custom fields.
   * Rows created by apps/server/src/routes/ingestion.ts (entity_type 'TestCaseVersion',
   * non-null project_id) are deliberately invisible here -- a separate, parallel system. */
  async listDefinitions(entityType?: CustomFieldEntityType): Promise<CustomFieldDefinition[]> {
    let query = this.db.selectFrom('custom_field_definitions').selectAll().where('project_id', 'is', null);
    if (entityType) {
      query = query.where('entity_type', '=', entityType);
    }
    const rows = await query.orderBy('name', 'asc').execute();
    return this.attachOptions(rows.map((r) => this.toDefinition(r)));
  }

  async getDefinition(id: string): Promise<CustomFieldDefinition | undefined> {
    const row = await this.db
      .selectFrom('custom_field_definitions')
      .selectAll()
      .where('id', '=', id)
      .where('project_id', 'is', null)
      .executeTakeFirst();
    if (!row) return undefined;
    const [definition] = await this.attachOptions([this.toDefinition(row)]);
    return definition;
  }

  /** Global-scope (project_id IS NULL) name uniqueness pre-check, mirroring
   * role.repository.ts's roleExists/ROLE_NAME_TAKEN convention. The migration's partial
   * unique index (WHERE project_id IS NULL) backs this at the DB level too, as a
   * race-condition safety net -- this check is what produces the friendly error message. */
  private async nameTaken(entityType: CustomFieldEntityType, name: string, excludeId?: string): Promise<boolean> {
    let query = this.db
      .selectFrom('custom_field_definitions')
      .select('id')
      .where('project_id', 'is', null)
      .where('entity_type', '=', entityType)
      .where('name', '=', name);
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
    if (await this.nameTaken(input.entity_type, input.name)) {
      throw new Error(`FIELD_NAME_TAKEN: a global '${input.entity_type}' field named '${input.name}' already exists`);
    }

    const now = new Date().toISOString();
    const id = input.id || uuidv7();

    await this.db.transaction().execute(async (trx) => {
      await trx
        .insertInto('custom_field_definitions')
        .values({
          id,
          project_id: null,
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

    return (await this.getDefinition(id))!;
  }

  async updateDefinition(id: string, input: UpdateCustomFieldDefinitionInput): Promise<CustomFieldDefinition | undefined> {
    const existing = await this.getDefinition(id);
    if (!existing) return undefined;

    if (input.name !== undefined && input.name !== existing.name && (await this.nameTaken(existing.entity_type, input.name, id))) {
      throw new Error(`FIELD_NAME_TAKEN: a global '${existing.entity_type}' field named '${input.name}' already exists`);
    }

    const now = new Date().toISOString();

    await this.db.transaction().execute(async (trx) => {
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

    return this.getDefinition(id);
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
      .where('project_id', 'is', null)
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

    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom('custom_field_values').where('custom_field_definition_id', '=', id).execute();
      await trx.deleteFrom('custom_field_options').where('custom_field_definition_id', '=', id).execute();
      await trx.deleteFrom('custom_field_definitions').where('id', '=', id).execute();
    });

    return { deleted: true };
  }

  /** All global custom field values for one case/suite, joined with their definitions, in
   * one round-trip -- for hydrating a case/suite detail pane. */
  async getValuesForEntity(entityType: CustomFieldEntityType, entityId: string): Promise<CustomFieldValueEntry[]> {
    const definitions = await this.listDefinitions(entityType);
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

  /** Validates `rawValue` against the definition's field_type/options/validation_regex via
   * @testify/core's parseCustomFieldValue (throwing INVALID_FIELD_VALUE/REQUIRED_FIELD_MISSING
   * on failure), then updates the existing value row for this (definition, entity) pair or
   * inserts a new one -- never accumulating duplicates on repeated edits. */
  async setValue(definitionId: string, entityType: CustomFieldEntityType, entityId: string, rawValue: unknown): Promise<unknown> {
    const definition = await this.getDefinition(definitionId);
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

    await this.db.transaction().execute(async (trx) => {
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
