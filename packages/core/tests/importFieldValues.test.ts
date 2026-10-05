import { describe, it, expect } from 'vitest';
import { collectImportFieldOptions, splitMultiSelectValue, type ParsedSuite } from '../src/index.js';

const suite = (cases: Array<Record<string, string>>, sub: ParsedSuite[] = []): ParsedSuite => ({
  name: 'S',
  node_order: 1,
  sub_suites: sub,
  test_cases: cases.map((cf, i) => ({ title: `c${i}`, custom_fields: cf }) as any),
});

describe('import field options', () => {
  it('splitMultiSelectValue trims, drops empties and duplicates, keeps order', () => {
    expect(splitMultiSelectValue(' ui, api ,, ui,slow ')).toEqual(['ui', 'api', 'slow']);
    expect(splitMultiSelectValue('')).toEqual([]);
  });

  it('collects distinct whole values for SINGLE_SELECT across sub-suites, case-insensitive key', () => {
    const tree = [suite([{ Status: 'N/A' }, { status: 'Done' }], [suite([{ STATUS: 'Done' }, { status: ' To Do ' }, { other: 'x' }])])];
    expect(collectImportFieldOptions(tree, 'status', 'SINGLE_SELECT')).toEqual(['N/A', 'Done', 'To Do']);
  });

  it('splits comma-separated values for MULTI_SELECT', () => {
    const tree = [suite([{ tags: 'ui, api' }, { tags: 'api,slow' }, { tags: '' }])];
    expect(collectImportFieldOptions(tree, 'tags', 'MULTI_SELECT')).toEqual(['ui', 'api', 'slow']);
  });
});
