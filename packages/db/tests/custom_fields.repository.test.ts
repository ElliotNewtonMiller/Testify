import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type { Kysely } from 'kysely';
import { createDbClient } from '../src/client.js';
import type { Database } from '../src/types.js';
import { migrateToLatest, migrateDownAll } from '../src/migrations/index.js';
import { CustomFieldRepository, ProjectRepository, TestSuiteRepository, TestCaseRepository } from '../src/repositories/index.js';

describe('CustomFieldRepository', () => {
  let db: Kysely<Database>;
  let fieldRepo: CustomFieldRepository;
  let projectRepo: ProjectRepository;
  let suiteRepo: TestSuiteRepository;
  let caseRepo: TestCaseRepository;

  beforeEach(async () => {
    db = createDbClient();
    await migrateToLatest(db);

    fieldRepo = new CustomFieldRepository(db);
    projectRepo = new ProjectRepository(db);
    suiteRepo = new TestSuiteRepository(db);
    caseRepo = new TestCaseRepository(db);
  });

  afterEach(async () => {
    try {
      await migrateDownAll(db);
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

  it('a project-scoped definition with the same name as a global one is invisible to global listDefinitions() and does not collide', async () => {
    const { project } = await makeCaseAndSuite();

    const projectOwner = await fieldRepo.createDefinition({
      project_id: project.id,
      entity_type: 'TestCase',
      name: 'owner',
      field_label: 'Owner (from import)',
      field_type: 'TEXT',
    });
    expect(projectOwner.project_id).toBe(project.id);

    // This feature's global 'TestCase'-scoped field named 'owner' is unaffected.
    const globalOwner = await fieldRepo.createDefinition({ entity_type: 'TestCase', name: 'owner', field_label: 'Owner', field_type: 'TEXT' });
    expect(globalOwner.name).toBe('owner');
    expect(globalOwner.project_id).toBeNull();

    const listed = await fieldRepo.listDefinitions();
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(globalOwner.id);
  });

  describe('project-scoped definitions', () => {
    it('createDefinition with project_id creates a row invisible to global listDefinitions(), visible to listDefinitions(entityType, projectId) and listVisibleToProject', async () => {
      const { project } = await makeCaseAndSuite();
      const created = await fieldRepo.createDefinition({
        project_id: project.id,
        entity_type: 'TestCase',
        name: 'imported_field',
        field_label: 'Imported Field',
        field_type: 'TEXT',
      });

      expect(await fieldRepo.listDefinitions()).toHaveLength(0);
      const ownList = await fieldRepo.listDefinitions('TestCase', project.id);
      expect(ownList.map((d) => d.id)).toEqual([created.id]);

      const visible = await fieldRepo.listVisibleToProject(project.id, 'TestCase');
      expect(visible.map((d) => d.id)).toEqual([created.id]);
    });

    it('listVisibleToProject returns the union of global and that project\'s own definitions, global first', async () => {
      const { project } = await makeCaseAndSuite();
      const global1 = await fieldRepo.createDefinition({ entity_type: 'TestCase', name: 'zzz_global', field_label: 'Z', field_type: 'TEXT' });
      const projectField = await fieldRepo.createDefinition({
        project_id: project.id,
        entity_type: 'TestCase',
        name: 'aaa_project',
        field_label: 'A',
        field_type: 'TEXT',
      });

      const visible = await fieldRepo.listVisibleToProject(project.id, 'TestCase');
      expect(visible.map((d) => d.id)).toEqual([global1.id, projectField.id]);

      // A different project never sees this project's own field.
      const otherProject = await projectRepo.create({ name: 'Other', prefix: 'OTH' });
      const otherVisible = await fieldRepo.listVisibleToProject(otherProject.id, 'TestCase');
      expect(otherVisible.map((d) => d.id)).toEqual([global1.id]);
    });

    it('a project-scoped field can share a name with a global field, but not with another field in the same project (backed by the DB index, not just the pre-check)', async () => {
      const { project } = await makeCaseAndSuite();
      await fieldRepo.createDefinition({ entity_type: 'TestCase', name: 'dup_name', field_label: 'Global', field_type: 'TEXT' });

      // Sharing a name with the global field is fine.
      await expect(
        fieldRepo.createDefinition({ project_id: project.id, entity_type: 'TestCase', name: 'dup_name', field_label: 'Project', field_type: 'TEXT' })
      ).resolves.toBeDefined();

      // A second field in the SAME project with the same name is rejected.
      await expect(
        fieldRepo.createDefinition({ project_id: project.id, entity_type: 'TestCase', name: 'dup_name', field_label: 'Project 2', field_type: 'TEXT' })
      ).rejects.toThrow(/FIELD_NAME_TAKEN/);

      // The DB-level partial unique index itself rejects it too, bypassing the repo's pre-check.
      await expect(
        db
          .insertInto('custom_field_definitions')
          .values({
            id: 'raw-dup-0000-0000-000000000001',
            project_id: project.id,
            entity_type: 'TestCase',
            name: 'dup_name',
            field_label: 'Raw dup',
            field_type: 'TEXT',
            is_required: 0,
            default_value: null,
            validation_regex: null,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          })
          .execute()
      ).rejects.toThrow();

      // A DIFFERENT project may still use the same name.
      const otherProject = await projectRepo.create({ name: 'Other2', prefix: 'OT2' });
      await expect(
        fieldRepo.createDefinition({ project_id: otherProject.id, entity_type: 'TestCase', name: 'dup_name', field_label: 'Other project', field_type: 'TEXT' })
      ).resolves.toBeDefined();
    });

    it('updateDefinition renaming a project-scoped field re-checks the project scope, not the global one', async () => {
      const { project } = await makeCaseAndSuite();
      await fieldRepo.createDefinition({ entity_type: 'TestCase', name: 'taken_globally', field_label: 'Global', field_type: 'TEXT' });
      const projectField = await fieldRepo.createDefinition({
        project_id: project.id,
        entity_type: 'TestCase',
        name: 'original_name',
        field_label: 'Original',
        field_type: 'TEXT',
      });

      // Renaming to a name only taken globally (not in this project) succeeds.
      const renamed = await fieldRepo.updateDefinition(projectField.id, { name: 'taken_globally' });
      expect(renamed?.name).toBe('taken_globally');
      expect(renamed?.project_id).toBe(project.id);
    });

    it('deleteDefinition can find and delete a project-scoped-by-id definition', async () => {
      const { project } = await makeCaseAndSuite();
      const projectField = await fieldRepo.createDefinition({
        project_id: project.id,
        entity_type: 'TestCase',
        name: 'to_delete',
        field_label: 'To Delete',
        field_type: 'TEXT',
      });

      const result = await fieldRepo.deleteDefinition(projectField.id);
      expect(result.deleted).toBe(true);
      expect(await fieldRepo.getDefinition(projectField.id, project.id)).toBeUndefined();
    });

    it('setValue/getValuesForEntity round-trip identically for a project-scoped field, once given projectId', async () => {
      const { project, testCase } = await makeCaseAndSuite();
      const projectField = await fieldRepo.createDefinition({
        project_id: project.id,
        entity_type: 'TestCase',
        name: 'imported_notes',
        field_label: 'Imported Notes',
        field_type: 'TEXT',
      });

      await fieldRepo.setValue(projectField.id, 'TestCase', testCase.id, 'hello from import', project.id);
      const values = await fieldRepo.getValuesForEntity('TestCase', testCase.id, project.id);
      const entry = values.find((v) => v.definition.id === projectField.id);
      expect(entry?.value).toBe('hello from import');

      // Without projectId, the project-scoped field is invisible (global-only default).
      const globalOnlyValues = await fieldRepo.getValuesForEntity('TestCase', testCase.id);
      expect(globalOnlyValues.find((v) => v.definition.id === projectField.id)).toBeUndefined();
    });
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

  describe('getValuesForEntities (batched sibling of getValuesForEntity, built for export)', () => {
    it('returns the same result as calling getValuesForEntity once per entity, for a mix of set/unset values', async () => {
      const { project, suite } = await makeCaseAndSuite();
      const field = await fieldRepo.createDefinition({ entity_type: 'TestCase', name: 'batch_cf', field_label: 'Batch CF', field_type: 'TEXT' });

      const caseA = await caseRepo.create({ project_id: project.id, test_suite_id: suite.id, external_id: 'CFP-A', title: 'A', priority: 'HIGH', execution_type: 'MANUAL' });
      const caseB = await caseRepo.create({ project_id: project.id, test_suite_id: suite.id, external_id: 'CFP-B', title: 'B', priority: 'HIGH', execution_type: 'MANUAL' });
      const caseC = await caseRepo.create({ project_id: project.id, test_suite_id: suite.id, external_id: 'CFP-C', title: 'C', priority: 'HIGH', execution_type: 'MANUAL' });

      await fieldRepo.setValue(field.id, 'TestCase', caseA.id, 'value-a');
      // caseB left unset; caseC gets a value too
      await fieldRepo.setValue(field.id, 'TestCase', caseC.id, 'value-c');

      const batched = await fieldRepo.getValuesForEntities('TestCase', [caseA.id, caseB.id, caseC.id]);
      expect(batched.size).toBe(3);

      for (const c of [caseA, caseB, caseC]) {
        const individual = await fieldRepo.getValuesForEntity('TestCase', c.id);
        expect(batched.get(c.id)).toEqual(individual);
      }
      expect(batched.get(caseA.id)![0].value).toBe('value-a');
      expect(batched.get(caseB.id)![0].value).toBeNull();
      expect(batched.get(caseC.id)![0].value).toBe('value-c');
    });

    it('returns an empty Map for an empty entityIds array, without querying', async () => {
      const result = await fieldRepo.getValuesForEntities('TestCase', []);
      expect(result.size).toBe(0);
    });

    it('honors projectId to include project-scoped definitions, matching getValuesForEntity', async () => {
      const { project, testCase } = await makeCaseAndSuite();
      const projectField = await fieldRepo.createDefinition({
        project_id: project.id,
        entity_type: 'TestCase',
        name: 'project_scoped_cf',
        field_label: 'Project Scoped',
        field_type: 'TEXT',
      });
      await fieldRepo.setValue(projectField.id, 'TestCase', testCase.id, 'scoped-value', project.id);

      const withProjectId = await fieldRepo.getValuesForEntities('TestCase', [testCase.id], project.id);
      expect(withProjectId.get(testCase.id)!.find((e) => e.definition.id === projectField.id)?.value).toBe('scoped-value');

      const withoutProjectId = await fieldRepo.getValuesForEntities('TestCase', [testCase.id]);
      expect(withoutProjectId.get(testCase.id)!.find((e) => e.definition.id === projectField.id)).toBeUndefined();
    });
  });

  describe('seedDefaultValueForAllEntities', () => {
    it('writes a real row for every pre-existing entity, and later editing the default no longer changes it', async () => {
      const { testCase } = await makeCaseAndSuite();
      const field = await fieldRepo.createDefinition({
        entity_type: 'TestCase',
        name: 'severity',
        field_label: 'Severity',
        field_type: 'TEXT',
        is_required: true,
        default_value: 'Medium',
      });

      const seeded = await fieldRepo.seedDefaultValueForAllEntities(field);
      expect(seeded).toBe(1);
      expect((await fieldRepo.getValuesForEntity('TestCase', testCase.id))[0].value).toBe('Medium');

      // Editing the definition's default afterward must not retroactively change the
      // already-seeded value -- that's the entire point of freezing a real row.
      await fieldRepo.updateDefinition(field.id, { default_value: 'High' });
      expect((await fieldRepo.getValuesForEntity('TestCase', testCase.id))[0].value).toBe('Medium');
    });

    it('is a no-op with no default_value, or a default that does not coerce for the field type', async () => {
      await makeCaseAndSuite();
      const noDefault = await fieldRepo.createDefinition({
        entity_type: 'TestCase',
        name: 'optional_field',
        field_label: 'Optional',
        field_type: 'TEXT',
      });
      expect(await fieldRepo.seedDefaultValueForAllEntities(noDefault)).toBe(0);

      const badDefault = await fieldRepo.createDefinition({
        entity_type: 'TestCase',
        name: 'bad_number',
        field_label: 'Bad Number',
        field_type: 'NUMBER',
        default_value: 'not-a-number',
      });
      expect(await fieldRepo.seedDefaultValueForAllEntities(badDefault)).toBe(0);
    });

    it('seeds every TestSuite (not just TestCase) when entity_type is TestSuite', async () => {
      const { suite } = await makeCaseAndSuite();
      const field = await fieldRepo.createDefinition({
        entity_type: 'TestSuite',
        name: 'owner_team',
        field_label: 'Owner Team',
        field_type: 'TEXT',
        default_value: 'QA',
      });
      expect(await fieldRepo.seedDefaultValueForAllEntities(field)).toBe(1);
      expect((await fieldRepo.getValuesForEntity('TestSuite', suite.id))[0].value).toBe('QA');
    });

    it('scopes seeding to the definition\'s own project for a project-scoped field, not every project', async () => {
      const { project: projectA, testCase: caseA } = await makeCaseAndSuite();
      const projectB = await projectRepo.create({ name: 'CF Proj B', prefix: 'CFPB' });
      const suiteB = await suiteRepo.create({ project_id: projectB.id, name: 'CF Suite B' });
      await caseRepo.create({
        project_id: projectB.id,
        test_suite_id: suiteB.id,
        external_id: 'CFPB-1',
        title: 'CF Case B',
        priority: 'HIGH',
        execution_type: 'MANUAL',
      });

      const scopedField = await fieldRepo.createDefinition({
        project_id: projectA.id,
        entity_type: 'TestCase',
        name: 'scoped_field',
        field_label: 'Scoped',
        field_type: 'TEXT',
        default_value: 'x',
      });
      expect(await fieldRepo.seedDefaultValueForAllEntities(scopedField)).toBe(1);
      expect((await fieldRepo.getValuesForEntity('TestCase', caseA.id, projectA.id))[0].value).toBe('x');
    });
  });

  describe('applyDefaultToBlankValues', () => {
    it('switches an explicit blank value to the default once the field is required with a usable default', async () => {
      const { testCase } = await makeCaseAndSuite();
      const field = await fieldRepo.createDefinition({
        entity_type: 'TestCase',
        name: 'severity_blank',
        field_label: 'Severity',
        field_type: 'SINGLE_SELECT',
        options: [
          { option_label: 'High', option_value: 'High' },
          { option_label: 'Low', option_value: 'Low' },
        ],
      });
      // Explicitly clear the value while the field is still optional -- a real row with
      // all-null typed columns, not "no row at all".
      await fieldRepo.setValue(field.id, 'TestCase', testCase.id, '');
      expect((await fieldRepo.getValuesForEntity('TestCase', testCase.id))[0].value).toBeNull();

      const updated = await fieldRepo.updateDefinition(field.id, { is_required: true, default_value: 'High' });
      const applied = await fieldRepo.applyDefaultToBlankValues(updated!);
      expect(applied).toBe(1);
      expect((await fieldRepo.getValuesForEntity('TestCase', testCase.id))[0].value).toBe('High');
    });

    it('never overwrites an entity that already holds a real, non-blank value; leaves a no-row entity to the live fallback', async () => {
      const { project, suite, testCase } = await makeCaseAndSuite();
      const otherCase = await caseRepo.create({
        project_id: project.id,
        test_suite_id: suite.id,
        external_id: 'CFP-2',
        title: 'CF Case 2',
        priority: 'HIGH',
        execution_type: 'MANUAL',
      });
      const field = await fieldRepo.createDefinition({
        entity_type: 'TestCase',
        name: 'severity_kept',
        field_label: 'Severity',
        field_type: 'SINGLE_SELECT',
        options: [
          { option_label: 'High', option_value: 'High' },
          { option_label: 'Low', option_value: 'Low' },
        ],
      });
      await fieldRepo.setValue(field.id, 'TestCase', testCase.id, 'Low');
      // otherCase is left with no row at all on purpose.

      const updated = await fieldRepo.updateDefinition(field.id, { is_required: true, default_value: 'High' });
      const applied = await fieldRepo.applyDefaultToBlankValues(updated!);
      expect(applied).toBe(0);
      expect((await fieldRepo.getValuesForEntity('TestCase', testCase.id))[0].value).toBe('Low');
      // Never got a row written -- it already reads as the default live via the read-time
      // fallback, exactly like before this method existed.
      expect((await fieldRepo.getValuesForEntity('TestCase', otherCase.id))[0].value).toBe('High');
    });

    it('treats an explicit false CHECKBOX value as non-blank, never touched', async () => {
      const { testCase } = await makeCaseAndSuite();
      const field = await fieldRepo.createDefinition({
        entity_type: 'TestCase',
        name: 'automated_ok',
        field_label: 'Automated OK',
        field_type: 'CHECKBOX',
      });
      await fieldRepo.setValue(field.id, 'TestCase', testCase.id, false);
      const updated = await fieldRepo.updateDefinition(field.id, { default_value: 'true' });
      const applied = await fieldRepo.applyDefaultToBlankValues(updated!);
      expect(applied).toBe(0);
      expect((await fieldRepo.getValuesForEntity('TestCase', testCase.id))[0].value).toBe(false);
    });

    it('treats a MULTI_SELECT value of [] as blank too', async () => {
      const { testCase } = await makeCaseAndSuite();
      const field = await fieldRepo.createDefinition({
        entity_type: 'TestCase',
        name: 'tags_blank',
        field_label: 'Tags',
        field_type: 'MULTI_SELECT',
        options: [
          { option_label: 'A', option_value: 'A' },
          { option_label: 'B', option_value: 'B' },
        ],
      });
      await fieldRepo.setValue(field.id, 'TestCase', testCase.id, []);
      const updated = await fieldRepo.updateDefinition(field.id, { is_required: true, default_value: '["A"]' });
      const applied = await fieldRepo.applyDefaultToBlankValues(updated!);
      expect(applied).toBe(1);
      expect((await fieldRepo.getValuesForEntity('TestCase', testCase.id))[0].value).toEqual(['A']);
    });

    it('is a no-op with no default_value, or a default that does not coerce for the field type', async () => {
      const { testCase } = await makeCaseAndSuite();
      const noDefault = await fieldRepo.createDefinition({
        entity_type: 'TestCase',
        name: 'no_default_blank',
        field_label: 'No Default',
        field_type: 'TEXT',
      });
      await fieldRepo.setValue(noDefault.id, 'TestCase', testCase.id, '');
      expect(await fieldRepo.applyDefaultToBlankValues(noDefault)).toBe(0);

      const badNumber = await fieldRepo.createDefinition({
        entity_type: 'TestCase',
        name: 'bad_number_blank',
        field_label: 'Bad Number',
        field_type: 'NUMBER',
        default_value: 'not-a-number',
      });
      await fieldRepo.setValue(badNumber.id, 'TestCase', testCase.id, '');
      expect(await fieldRepo.applyDefaultToBlankValues(badNumber)).toBe(0);
    });
  });

  describe('updateDefinition: removing a selected option deselects it from real entity values', () => {
    it('SINGLE_SELECT: a case whose value was the removed option is cleared to null', async () => {
      const { testCase } = await makeCaseAndSuite();
      const field = await fieldRepo.createDefinition({
        entity_type: 'TestCase',
        name: 'severity_prune',
        field_label: 'Severity',
        field_type: 'SINGLE_SELECT',
        options: [
          { option_label: 'High', option_value: 'High' },
          { option_label: 'Low', option_value: 'Low' },
        ],
      });
      await fieldRepo.setValue(field.id, 'TestCase', testCase.id, 'Low');
      expect((await fieldRepo.getValuesForEntity('TestCase', testCase.id))[0].value).toBe('Low');

      // Save the definition with only "High" left -- "Low" is gone.
      await fieldRepo.updateDefinition(field.id, { options: [{ option_label: 'High', option_value: 'High' }] });

      expect((await fieldRepo.getValuesForEntity('TestCase', testCase.id))[0].value).toBeNull();
    });

    it('SINGLE_SELECT: a case whose value is unaffected keeps it untouched', async () => {
      const { testCase } = await makeCaseAndSuite();
      const field = await fieldRepo.createDefinition({
        entity_type: 'TestCase',
        name: 'severity_keep',
        field_label: 'Severity',
        field_type: 'SINGLE_SELECT',
        options: [
          { option_label: 'High', option_value: 'High' },
          { option_label: 'Low', option_value: 'Low' },
        ],
      });
      await fieldRepo.setValue(field.id, 'TestCase', testCase.id, 'High');

      await fieldRepo.updateDefinition(field.id, { options: [{ option_label: 'High', option_value: 'High' }] });

      expect((await fieldRepo.getValuesForEntity('TestCase', testCase.id))[0].value).toBe('High');
    });

    it('MULTI_SELECT: removing one selected option keeps the rest (partial prune)', async () => {
      const { testCase } = await makeCaseAndSuite();
      const field = await fieldRepo.createDefinition({
        entity_type: 'TestCase',
        name: 'tags_prune_partial',
        field_label: 'Tags',
        field_type: 'MULTI_SELECT',
        options: [
          { option_label: 'A', option_value: 'A' },
          { option_label: 'B', option_value: 'B' },
          { option_label: 'C', option_value: 'C' },
        ],
      });
      await fieldRepo.setValue(field.id, 'TestCase', testCase.id, ['A', 'B', 'C']);

      // Drop "B" from the options.
      await fieldRepo.updateDefinition(field.id, {
        options: [
          { option_label: 'A', option_value: 'A' },
          { option_label: 'C', option_value: 'C' },
        ],
      });

      expect((await fieldRepo.getValuesForEntity('TestCase', testCase.id))[0].value).toEqual(['A', 'C']);
    });

    it('MULTI_SELECT: removing every selected option clears the value to null', async () => {
      const { testCase } = await makeCaseAndSuite();
      const field = await fieldRepo.createDefinition({
        entity_type: 'TestCase',
        name: 'tags_prune_all',
        field_label: 'Tags',
        field_type: 'MULTI_SELECT',
        options: [
          { option_label: 'A', option_value: 'A' },
          { option_label: 'B', option_value: 'B' },
        ],
      });
      await fieldRepo.setValue(field.id, 'TestCase', testCase.id, ['A']);

      await fieldRepo.updateDefinition(field.id, { options: [{ option_label: 'B', option_value: 'B' }] });

      expect((await fieldRepo.getValuesForEntity('TestCase', testCase.id))[0].value).toBeNull();
    });

    it('works for TestSuite values too, and leaves other definitions/entities alone', async () => {
      const { project, suite } = await makeCaseAndSuite();
      const otherSuite = await suiteRepo.create({ project_id: project.id, name: 'Other Suite' });
      const field = await fieldRepo.createDefinition({
        entity_type: 'TestSuite',
        name: 'owner_prune',
        field_label: 'Owner',
        field_type: 'SINGLE_SELECT',
        options: [
          { option_label: 'QA', option_value: 'QA' },
          { option_label: 'Dev', option_value: 'Dev' },
        ],
      });
      await fieldRepo.setValue(field.id, 'TestSuite', suite.id, 'Dev');
      await fieldRepo.setValue(field.id, 'TestSuite', otherSuite.id, 'QA');

      await fieldRepo.updateDefinition(field.id, { options: [{ option_label: 'QA', option_value: 'QA' }] });

      expect((await fieldRepo.getValuesForEntity('TestSuite', suite.id))[0].value).toBeNull();
      expect((await fieldRepo.getValuesForEntity('TestSuite', otherSuite.id))[0].value).toBe('QA');
    });

    it('does nothing when the update does not touch options at all', async () => {
      const { testCase } = await makeCaseAndSuite();
      const field = await fieldRepo.createDefinition({
        entity_type: 'TestCase',
        name: 'severity_untouched',
        field_label: 'Severity',
        field_type: 'SINGLE_SELECT',
        options: [
          { option_label: 'High', option_value: 'High' },
          { option_label: 'Low', option_value: 'Low' },
        ],
      });
      await fieldRepo.setValue(field.id, 'TestCase', testCase.id, 'Low');

      await fieldRepo.updateDefinition(field.id, { field_label: 'Severity Level' });

      expect((await fieldRepo.getValuesForEntity('TestCase', testCase.id))[0].value).toBe('Low');
    });
  });
});
