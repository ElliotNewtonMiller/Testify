/**
 * Minimal shapes needed to check "are this case's required custom fields satisfied" --
 * deliberately a subset of packages/db's CustomFieldDefinition/CustomFieldValueEntry
 * interfaces (packages/core can't import from packages/db without a circular workspace
 * dependency), so both the case-creation auto-approve gate and the explicit Approve route
 * can share one implementation instead of duplicating this logic.
 */
export interface RequiredFieldDefinitionLike {
  id: string;
  is_required: boolean;
  default_value: string | null;
  field_label: string;
}

export interface FieldValueEntryLike {
  definition: { id: string };
  value: unknown;
}

/**
 * Returns every definition that's required, has no default_value, and has no real value
 * recorded yet -- these are what block both auto-approve-on-create and the explicit Approve
 * action. null/undefined/'' don't count as provided (matching parseCustomFieldValue's own
 * isEmpty semantics), but an explicit `false` does -- getValuesForEntity/readCustomFieldValue
 * already distinguish "never set" (value: null) from "explicitly unchecked" (value: false)
 * for CHECKBOX fields, so a required checkbox someone has actually toggled off is correctly
 * satisfied, not flagged as missing.
 *
 * A required field WITH a default_value is always considered satisfied, even before any
 * value row exists for it -- a default effectively provides the value, so it shouldn't block
 * auto-approve or an explicit approve either.
 *
 * For a brand-new case (nothing in `values` yet), pass an empty array -- every required
 * field with no default will correctly come back as unsatisfied.
 */
export function findUnsatisfiedRequiredFields<D extends RequiredFieldDefinitionLike>(
  definitions: D[],
  values: FieldValueEntryLike[]
): D[] {
  const valueByDefinitionId = new Map(values.map((v) => [v.definition.id, v.value]));
  return definitions.filter((d) => {
    if (!d.is_required) return false;
    if (d.default_value !== null) return false;
    const value = valueByDefinitionId.get(d.id);
    return value === null || value === undefined || value === '';
  });
}
