export const CUSTOM_FIELD_TYPES = ['TEXT', 'NUMBER', 'CHECKBOX', 'DATE', 'SINGLE_SELECT', 'MULTI_SELECT'] as const;
export type CustomFieldType = (typeof CUSTOM_FIELD_TYPES)[number];

export const CUSTOM_FIELD_ENTITY_TYPES = ['TestCase', 'TestSuite'] as const;
export type CustomFieldEntityType = (typeof CUSTOM_FIELD_ENTITY_TYPES)[number];

/** The typed-column payload `custom_field_values` rows are persisted as -- exactly one of
 * these is non-null per field_type (MULTI_SELECT stores its array in json_value). */
export interface CustomFieldTypedValue {
  string_value: string | null;
  number_value: number | null;
  boolean_value: number | null;
  date_value: string | null;
  json_value: string | null;
}

export interface CustomFieldValidationOptions {
  validationRegex?: string | null;
  options?: Array<{ option_value: string }>;
  isRequired?: boolean;
}

const EMPTY_TYPED_VALUE: CustomFieldTypedValue = {
  string_value: null,
  number_value: null,
  boolean_value: null,
  date_value: null,
  json_value: null,
};

function isEmpty(rawValue: unknown): boolean {
  return rawValue === null || rawValue === undefined || rawValue === '';
}

/**
 * Validates and coerces a raw incoming value (from a JSON request body) against a custom
 * field's type, its option set (for SINGLE_SELECT/MULTI_SELECT), and its validation_regex
 * (for TEXT), returning the typed-column payload to persist. Throws a descriptive,
 * `CODE: message`-prefixed error (matching this codebase's existing throw convention, e.g.
 * role.repository.ts's `UNKNOWN_ROLE:`/`UNKNOWN_PERMISSION_KEY:`) that route layers map to
 * a 422 Problem Details response.
 */
export function parseCustomFieldValue(
  fieldType: CustomFieldType,
  rawValue: unknown,
  opts: CustomFieldValidationOptions = {}
): CustomFieldTypedValue {
  if (isEmpty(rawValue)) {
    if (opts.isRequired) {
      throw new Error('REQUIRED_FIELD_MISSING: this field is required');
    }
    return { ...EMPTY_TYPED_VALUE };
  }

  switch (fieldType) {
    case 'TEXT': {
      if (typeof rawValue !== 'string') {
        throw new Error('INVALID_FIELD_VALUE: expected a string for a TEXT field');
      }
      if (opts.validationRegex) {
        const regex = new RegExp(opts.validationRegex);
        if (!regex.test(rawValue)) {
          throw new Error(`INVALID_FIELD_VALUE: '${rawValue}' does not match the required pattern`);
        }
      }
      return { ...EMPTY_TYPED_VALUE, string_value: rawValue };
    }

    case 'NUMBER': {
      const num = typeof rawValue === 'number' ? rawValue : Number(rawValue);
      if (typeof rawValue === 'boolean' || Array.isArray(rawValue) || !Number.isFinite(num)) {
        throw new Error('INVALID_FIELD_VALUE: expected a finite number for a NUMBER field');
      }
      return { ...EMPTY_TYPED_VALUE, number_value: num };
    }

    case 'CHECKBOX': {
      if (typeof rawValue === 'boolean') {
        return { ...EMPTY_TYPED_VALUE, boolean_value: rawValue ? 1 : 0 };
      }
      if (rawValue === 0 || rawValue === 1) {
        return { ...EMPTY_TYPED_VALUE, boolean_value: rawValue };
      }
      throw new Error('INVALID_FIELD_VALUE: expected a boolean for a CHECKBOX field');
    }

    case 'DATE': {
      if (typeof rawValue !== 'string' || Number.isNaN(Date.parse(rawValue))) {
        throw new Error('INVALID_FIELD_VALUE: expected an ISO-8601 date string for a DATE field');
      }
      return { ...EMPTY_TYPED_VALUE, date_value: rawValue };
    }

    case 'SINGLE_SELECT': {
      if (typeof rawValue !== 'string') {
        throw new Error('INVALID_FIELD_VALUE: expected a single option value for a SINGLE_SELECT field');
      }
      const allowed = new Set((opts.options ?? []).map((o) => o.option_value));
      if (!allowed.has(rawValue)) {
        throw new Error(`INVALID_FIELD_VALUE: '${rawValue}' is not one of this field's configured options`);
      }
      return { ...EMPTY_TYPED_VALUE, string_value: rawValue };
    }

    case 'MULTI_SELECT': {
      if (!Array.isArray(rawValue) || !rawValue.every((v) => typeof v === 'string')) {
        throw new Error('INVALID_FIELD_VALUE: expected an array of option values for a MULTI_SELECT field');
      }
      const allowed = new Set((opts.options ?? []).map((o) => o.option_value));
      for (const v of rawValue) {
        if (!allowed.has(v)) {
          throw new Error(`INVALID_FIELD_VALUE: '${v}' is not one of this field's configured options`);
        }
      }
      return { ...EMPTY_TYPED_VALUE, json_value: JSON.stringify(rawValue) };
    }

    default:
      throw new Error(`UNKNOWN_FIELD_TYPE: '${fieldType}' is not a registered custom field type`);
  }
}

/** Inverse of parseCustomFieldValue: reads a persisted typed-column row back into the
 * single JS value a consumer (a GET response, the frontend) expects. */
export function readCustomFieldValue(fieldType: CustomFieldType, row: CustomFieldTypedValue): unknown {
  switch (fieldType) {
    case 'TEXT':
    case 'SINGLE_SELECT':
      return row.string_value;
    case 'DATE':
      return row.date_value;
    case 'NUMBER':
      return row.number_value;
    case 'CHECKBOX':
      return row.boolean_value === null ? null : row.boolean_value === 1;
    case 'MULTI_SELECT':
      return row.json_value ? JSON.parse(row.json_value) : null;
    default:
      return null;
  }
}
