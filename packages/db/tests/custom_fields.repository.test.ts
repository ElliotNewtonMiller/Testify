import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Kysely } from 'kysely';
import { createDbClient } from '../src/client.js';
import type { Database } from '../src/types.js';
import * as initialSchema from '../src/migrations/001_initial_schema.js';
import { CustomFieldRepository, ProjectRepository, TestSuiteRepository, TestCaseRepository } from '../src/repositories/index.js';

describe('CustomFieldRepository', () => {
  let db: Kysely<Database>;
  let fieldRepo: CustomFieldRepository;
  let projectRepo: ProjectRepository;
  let suiteRepo: TestSuiteRepository;
  let caseRepo: TestCaseRepository;

  beforeEach(async () => {
    db = createDbClient();
    await initialSchema.up(db);

    fieldRepo = new CustomFieldRepository(db);
    projectRepo = new ProjectRepository(db);
    suiteRepo = new TestSuiteRepository(db);
    caseRepo = new TestCaseRepository(db);
  });

  afterEach(async () => {
    try {
      await initialSchema.down(db);
    } finally {
      await db.destroy();
    }
  });

  async function makeCaseAndSuite() {
    const project = await projectRepo.create({ name: 'CF Proj', prefix: 'CFP' });
    const suite = await suiteRepo.create({ project_id: project.id, name: 'CF Suite' });
    const testCase = await caseRepo.create({
      project_id: project.id,
      test_suite_id: suite.id,
      external_id: 'CFP-1',
      title: 'CF Case',
      priority: 'HIGH',
      execution_type: 'MANUAL',
    });
    return { project, suite, testCase };
  }

  it('createDefinition happy path for each of the 6 field types', async () => {
    const text = await fieldRepo.createDefinition({ entity_type: 'TestCase', name: 'notes_cf', field_label: 'Notes', field_type: 'TEXT' });
    expect(text.field_type).toBe('TEXT');

    const number = await fieldRepo.createDefinition({ entity_type: 'TestCase', name: 'story_points', field_label: 'Story Points', field_type: 'NUMBER' });
    expect(number.field_type).toBe('NUMBER');

    const checkbox = await fieldRepo.createDefinition({ entity_type: 'TestCase', name: 'needs_retest', field_label: 'Needs Retest', field_type: 'CHECKBOX' });
    expect(checkbox.field_type).toBe('CHECKBOX');

    const date = await fieldRepo.createDefinition({ entity_type: 'TestCase', name: 'last_reviewed', field_label: 'Last Reviewed', field_type: 'DATE' });
    expect(date.field_type).toBe('DATE');

    const singleSelect = await fieldRepo.createDefinition({
      entity_type: 'TestSuite',
      name: 'owner_team',
      field_label: 'Owner Team',
      field_type: 'SINGLE_SELECT',
      options: [{ option_label: 'Platform', option_value: 'PLATFORM' }, { option_label: 'Mobile', option_value: 'MOBILE' }],
    });
    expect(singleSelect.options.map((o) => o.option_value)).toEqual(['PLATFORM', 'MOBILE']);

    const multiSelect = await fieldRepo.createDefinition({
      entity_type: 'TestSuite',
      name: 'platforms',
      field_label: 'Affected Platforms',
      field_type: 'MULTI_SELECT',
      options: [{ option_label: 'iOS', option_value: 'IOS' }, { option_label: 'Android', option_value: 'ANDROID' }],
    });
    expect(multiSelect.options).toHaveLength(2);
  });

  it('createDefinition rejects an unknown field_type and an unknown entity_type', async () => {
    await expect(
      fieldRepo.createDefinition({ entity_type: 'TestCase', name: 'x', field_label: 'X', field_type: 'WEIRD' as any })
    ).rejects.toThrow('UNKNOWN_FIELD_TYPE');
    await expect(
      fieldRepo.createDefinition({ entity_type: 'Execution' as any, name: 'y', field_label: 'Y', field_type: 'TEXT' })
    ).rejects.toThrow('UNKNOWN_ENTITY_TYPE');
  });

  it('rejects a duplicate name at global scope for the same entity_type, but allows the same name for a different entity_type', async () => {
    await fieldRepo.createDefinition({ entity_type: 'TestCase', name: 'owner', field_label: 'Owner', field_type: 'TEXT' });
    await expect(
      fieldRepo.createDefinition({ entity_type: 'TestCase', name: 'owner', field_label: 'Owner Again', field_type: 'TEXT' })
    ).rejects.toThrow('FIELD_NAME_TAKEN');

    // Different entity_type, same name -- unaffected.
    const suiteOwner = await fieldRepo.createDefinition({ entity_type: 'TestSuite', name: 'owner', field_label: 'Suite Owner', field_type: 'TEXT' });
    expect(suiteOwner.name).toBe('owner');
  });

  it('a project-scoped definition (simulating ingestion.ts) with the same name is invisible to listDefinitions and does not collide', async () => {
    const { project } = await makeCaseAndSuite();

    // Simulate ingestion.ts's insert: entity_type 'TestCaseVersion', a real project_id.
    await db
      .insertInto('custom_field_definitions')
      .values({
        id: 'ingestion-def-0000-0000-000000000001',
        project_id: project.id,
        entity_type: 'TestCaseVersion',
        name: 'owner',
        field_label: 'Owner (from import)',
        field_type: 'STRING',
        is_required: 0,
        default_value: null,
        validation_regex: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .execute();

    // This feature's global 'TestCase'-scoped field named 'owner' is unaffected.
    const globalOwner = await fieldRepo.createDefinition({ entity_type: 'TestCase', name: 'owner', field_label: 'Owner', field_type: 'TEXT' });
    expect(globalOwner.name).toBe('owner');

    const listed = await fieldRepo.listDefinitions();
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(globalOwner.id);
  });

  it('updateDefinition happy path, including replacing an options list', async () => {
    const created = await fieldRepo.createDefinition({
      entity_type: 'TestCase',
      name: 'severity',
      field_label: 'Severity',
      field_type: 'SINGLE_SELECT',
      options: [{ option_label: 'Low', option_value: 'LOW' }],
    });

    const updated = await fieldRepo.updateDefinition(created.id, {
      field_label: 'Severity Level',
      is_required: true,
      options: [{ option_label: 'Low', option_value: 'LOW' }, { option_label: 'High', option_value: 'HIGH' }],
    });

    expect(updated!.field_label).toBe('Severity Level');
    expect(updated!.is_required).toBe(true);
    expect(updated!.options.map((o) => o.option_value)).toEqual(['LOW', 'HIGH']);
  });

  it('setValue / getValuesForEntity / deleteValue round-trip for a TestCase and a TestSuite', async () => {
    const { suite, testCase } = await makeCaseAndSuite();

    const caseField = await fieldRepo.createDefinition({ entity_type: 'TestCase', name: 'story_points', field_label: 'Story Points', field_type: 'NUMBER' });
    const suiteField = await fieldRepo.createDefinition({ entity_type: 'TestSuite', name: 'owner_team', field_label: 'Owner Team', field_type: 'TEXT' });

    await fieldRepo.setValue(caseField.id, 'TestCase', testCase.id, 5);
    await fieldRepo.setValue(suiteField.id, 'TestSuite', suite.id, 'Platform Team');

    const caseValues = await fieldRepo.getValuesForEntity('TestCase', testCase.id);
    expect(caseValues).toEqual([{ definition: expect.objectContaining({ id: caseField.id }), value: 5 }]);

    const suiteValues = await fieldRepo.getValuesForEntity('TestSuite', suite.id);
    expect(suiteValues).toEqual([{ definition: expect.objectContaining({ id: suiteField.id }), value: 'Platform Team' }]);

    // setValue again on the same (definition, entity) pair updates in place, no duplicate row.
    await fieldRepo.setValue(caseField.id, 'TestCase', testCase.id, 8);
    const afterUpdate = await fieldRepo.getValuesForEntity('TestCase', testCase.id);
    expect(afterUpdate[0].value).toBe(8);
    const rawRows = await db.selectFrom('custom_field_values').selectAll().where('custom_field_definition_id', '=', caseField.id).execute();
    expect(rawRows).toHaveLength(1);

    await fieldRepo.deleteValue(caseField.id, 'TestCase', testCase.id);
    const afterDelete = await fieldRepo.getValuesForEntity('TestCase', testCase.id);
    expect(afterDelete[0].value).toBeNull();
  });

  it('setValue rejects an invalid value via the core validator', async () => {
    const { testCase } = await makeCaseAndSuite();
    const numberField = await fieldRepo.createDefinition({ entity_type: 'TestCase', name: 'points', field_label: 'Points', field_type: 'NUMBER' });
    await expect(fieldRepo.setValue(numberField.id, 'TestCase', testCase.id, 'not-a-number')).rejects.toThrow('INVALID_FIELD_VALUE');
  });

  it('deleteDefinition without force blocks when values exist, with an accurate count, and leaves everything untouched', async () => {
    const { testCase } = await makeCaseAndSuite();
    const field = await fieldRepo.createDefinition({ entity_type: 'TestCase', name: 'notes_cf', field_label: 'Notes', field_type: 'TEXT' });
    await fieldRepo.setValue(field.id, 'TestCase', testCase.id, 'hello');

    const result = await fieldRepo.deleteDefinition(field.id);
    expect(result).toEqual({ deleted: false, blockedByValueCount: 1, affectedEntityIds: [testCase.id], fieldLabel: 'Notes' });

    // Nothing was deleted.
    expect(await fieldRepo.getDefinition(field.id)).toBeDefined();
    const values = await fieldRepo.getValuesForEntity('TestCase', testCase.id);
    expect(values[0].value).toBe('hello');
  });

  it('deleteDefinition with force actually removes the definition, its options, and its values', async () => {
    const { testCase } = await makeCaseAndSuite();
    const field = await fieldRepo.createDefinition({
      entity_type: 'TestCase',
      name: 'severity',
      field_label: 'Severity',
      field_type: 'SINGLE_SELECT',
      options: [{ option_label: 'Low', option_value: 'LOW' }],
    });
    await fieldRepo.setValue(field.id, 'TestCase', testCase.id, 'LOW');

    const result = await fieldRepo.deleteDefinition(field.id, { force: true });
    expect(result).toEqual({ deleted: true });

    expect(await fieldRepo.getDefinition(field.id)).toBeUndefined();
    const optionRows = await db.selectFrom('custom_field_options').selectAll().where('custom_field_definition_id', '=', field.id).execute();
    expect(optionRows).toHaveLength(0);
    const valueRows = await db.selectFrom('custom_field_values').selectAll().where('custom_field_definition_id', '=', field.id).execute();
    expect(valueRows).toHaveLength(0);
  });

  it('deleteDefinition on a definition with no values succeeds immediately, without needing force', async () => {
    const field = await fieldRepo.createDefinition({ entity_type: 'TestCase', name: 'unused', field_label: 'Unused', field_type: 'TEXT' });
    const result = await fieldRepo.deleteDefinition(field.id);
    expect(result).toEqual({ deleted: true });
  });

  it('deleteDefinition on a missing id returns deleted:false with a zero count', async () => {
    const result = await fieldRepo.deleteDefinition('does-not-exist');
    expect(result).toEqual({ deleted: false, blockedByValueCount: 0, affectedEntityIds: [] });
  });
});
