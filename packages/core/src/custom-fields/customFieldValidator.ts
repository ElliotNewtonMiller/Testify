import { matchesValidationPattern } from './validationPattern.js';

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
  // An empty array (a MULTI_SELECT with every option deselected) is just as "nothing here"
  // as null/undefined/'' -- without this, a required MULTI_SELECT field could be saved with
  // value: [] (isEmpty(rawValue) would otherwise be false for an array, so the isRequired
  // check below would never fire), silently bypassing the "required fields can't be blank"
  // guarantee this function exists to enforce.
  return rawValue === null || rawValue === undefined || rawValue === '' || (Array.isArray(rawValue) && rawValue.length === 0);
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
        // Time-limited: an admin-written pattern could otherwise backtrack for ages.
        if (!matchesValidationPattern(opts.validationRegex, rawValue)) {
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

/**
 * Coerces a field definition's free-text `default_value` into the same JS-value shape
 * readCustomFieldValue() returns for a persisted row, so a default can be surfaced (read
 * path) or seeded (write path) without a real custom_field_values row existing yet.
 * Deliberately lenient, unlike parseCustomFieldValue() -- default_value is stored as one
 * generic plain-text field regardless of field_type (there's a single "Default Value" text
 * input in the admin UI for every type), so a default that doesn't cleanly coerce for its
 * type (e.g. a non-numeric NUMBER default) is treated as "no usable default" (null) rather
 * than thrown as a validation error.
 */
export function resolveDefaultValue(
  fieldType: CustomFieldType,
  defaultValue: string | null,
  opts: { options?: Array<{ option_value: string }> } = {}
): unknown {
  if (defaultValue === null || defaultValue === '') return null;

  switch (fieldType) {
    case 'TEXT':
      return defaultValue;

    case 'SINGLE_SELECT': {
      const allowed = new Set((opts.options ?? []).map((o) => o.option_value));
      return allowed.has(defaultValue) ? defaultValue : null;
    }

    case 'NUMBER': {
      const num = Number(defaultValue);
      return Number.isFinite(num) ? num : null;
    }

    case 'DATE':
      return Number.isNaN(Date.parse(defaultValue)) ? null : defaultValue;

    case 'CHECKBOX': {
      const normalized = defaultValue.trim().toLowerCase();
      if (normalized === 'true' || normalized === '1') return true;
      if (normalized === 'false' || normalized === '0') return false;
      return null;
    }

    case 'MULTI_SELECT': {
      let parsed: unknown;
      try {
        parsed = JSON.parse(defaultValue);
      } catch {
        return null;
      }
      if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === 'string')) return null;
      const allowed = new Set((opts.options ?? []).map((o) => o.option_value));
      return parsed.every((v) => allowed.has(v)) ? parsed : null;
    }

    default:
      return null;
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
