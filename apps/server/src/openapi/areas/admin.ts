import { authedErrors, wrapped, list, NO_CONTENT, FORCE_QUERY, idParams, oneOf, handlerValidated, PERMISSIONS_LIST, CUSTOM_FIELD_TYPES, pageQuery, NEXT_CURSOR } from '../schemas.js';

/**
 * Route schemas for the Admin Panel's routes: users, roles and overrides and the audit log
 * (routes/admin.ts), custom field definitions (routes/customFields.ts) and email settings
 * (routes/emailAdmin.ts). None of them accept API tokens (`TOKEN_NOT_ALLOWED`).
 */

const USERS = ['Admin: users and roles'];
const FIELDS = ['Admin: custom fields'];
const EMAIL = ['Admin: email'];
const AUDIT = ['Admin: audit log'];
const NO_TOKENS = ' Not available to API tokens.';
const GUARD_403: [number, string] =
  [403, 'Missing permission, or an Admin Panel safeguard: `PERMISSION_CEILING` (granting what you don\'t have), `TARGET_OUTRANKS_ACTOR`, `ROLE_OUTRANKS_ACTOR`'];

// ---- Users ----

const projectRoles = {
  type: 'array',
  items: { type: 'object', required: ['project_id'], properties: { project_id: { type: 'string' }, role: { type: ['string', 'null'], description: 'null or "" removes the project role' } } },
};

export const listUsersSchema = {
  tags: USERS,
  summary: 'List users',
  description: 'Every user with their roles, permissions and global overrides. Needs `USER_MANAGE`.' + NO_TOKENS,
  response: { 200: list('users', 'AdminUser', 'The users'), ...authedErrors() },
};

export const createUserSchema = {
  tags: USERS,
  summary: 'Create a user',
  description:
    'Needs `USER_MANAGE`; you can\'t give the new user permissions you don\'t have. `global_role` defaults to Tester. The password must meet the policy (8-100 characters; under 16 it needs a digit, an uppercase letter and a symbol).' + NO_TOKENS,
  body: {
    type: 'object',
    required: ['username', 'email', 'password'],
    properties: {
      username: { type: 'string' },
      email: { type: 'string' },
      password: { type: 'string' },
      global_role: { type: 'string', description: 'A role name from `GET /api/v1/admin/roles`; default Tester. "No Access" limits the user to their project roles.' },
      project_roles: projectRoles,
    },
  },
  response: {
    201: wrapped('user', 'AdminUser', 'Created'),
    ...authedErrors([400, '`PASSWORD_POLICY_VIOLATION`, `UNKNOWN_ROLE`, or a missing field'], GUARD_403, [409, '`USER_EXISTS`: the username or email is taken']),
  },
};

export const updateUserSchema = {
  tags: USERS,
  summary: "Change a user's status",
  description:
    'DISABLED ends their sign-ins and revokes the API tokens they issued; ACTIVE re-enables them and clears a sign-in lock (the Admin Panel\'s "Unlock"). The last active admin can\'t be disabled. Needs `USER_MANAGE`.' + NO_TOKENS,
  params: idParams('userId'),
  body: { type: 'object', required: ['status'], properties: { status: oneOf(['ACTIVE', 'DISABLED']) } },
  response: {
    200: {
      description: 'Changed',
      type: 'object',
      required: ['user'],
      properties: { user: { type: 'object', required: ['id', 'status'], properties: { id: { type: 'string' }, status: { type: 'string' } } } },
    },
    ...authedErrors(400, GUARD_403, 404, [409, '`LAST_ADMIN`']),
  },
};

export const updateUserRolesSchema = {
  tags: USERS,
  summary: "Change a user's roles",
  description:
    'Changes only what is sent: `global_role`, and/or one entry per project in `project_roles` (a null role removes it). A project role replaces the global role in that project. Needs `USER_MANAGE`.' + NO_TOKENS,
  params: idParams('userId'),
  body: { type: 'object', properties: { global_role: { type: 'string' }, project_roles: projectRoles } },
  response: { 200: wrapped('user', 'AdminUser', 'Changed'), ...authedErrors([400, '`UNKNOWN_ROLE`'], GUARD_403, 404, [409, '`LAST_ADMIN`']) },
};

export const resetPasswordSchema = {
  tags: USERS,
  summary: "Reset a user's password",
  description:
    'Sets a temporary password (generated unless you send one) that they must change at their next sign-in, ends their sign-ins and clears a lock. The generated password is in the response, once. Not for your own account. Needs `USER_MANAGE`.' + NO_TOKENS,
  params: idParams('userId'),
  body: { type: 'object', properties: { password: { type: 'string', description: 'Optional: choose the temporary password (it must meet the policy)' } } },
  response: {
    200: {
      description: 'Reset',
      type: 'object',
      required: ['user', 'sessions_ended'],
      properties: {
        user: { $ref: 'AdminUser#' },
        sessions_ended: { type: 'integer' },
        temporary_password: { type: 'string', description: 'Only when generated; never shown again' },
      },
    },
    ...authedErrors([400, '`CANNOT_RESET_OWN_PASSWORD`, `INVALID_PASSWORD` or `PASSWORD_POLICY_VIOLATION`'], GUARD_403, 404),
  },
};

const overrideScope = { type: 'object', properties: { project_id: { type: 'string', description: 'Overrides for this project; leave out for the global ones' } } };

export const getOverridesSchema = {
  tags: USERS,
  summary: "A user's permission overrides",
  description: 'Overrides grant or take away single permissions, whatever the role says; globally or in one project. Needs `USER_MANAGE`.' + NO_TOKENS,
  params: idParams('userId'),
  querystring: overrideScope,
  response: { 200: list('overrides', 'PermissionOverride', 'The overrides'), ...authedErrors(404) },
};

export const setOverridesSchema = {
  tags: USERS,
  summary: "Replace a user's permission overrides",
  description: 'Replaces every override at one scope (global, or the project in `project_id`). An empty list removes them all. Needs `USER_MANAGE`.' + NO_TOKENS,
  params: idParams('userId'),
  body: {
    type: 'object',
    required: ['overrides'],
    properties: {
      project_id: { type: ['string', 'null'] },
      overrides: { type: 'array', items: { $ref: 'PermissionOverride#' } },
    },
  },
  response: {
    200: {
      description: 'Saved',
      type: 'object',
      required: ['overrides', 'permissions'],
      properties: {
        overrides: { type: 'array', items: { $ref: 'PermissionOverride#' } },
        permissions: { ...PERMISSIONS_LIST, description: "The user's permissions at that scope now" },
      },
    },
    ...authedErrors([400, '`UNKNOWN_PERMISSION_KEY`'], GUARD_403, 404, [409, '`LAST_ADMIN`']),
  },
};

// ---- Roles ----

export const listPermissionsSchema = {
  tags: USERS,
  summary: 'Every permission',
  description: 'The permission keys, what each allows, and the group the Admin Panel shows it in. Any signed-in user.' + NO_TOKENS,
  response: {
    200: {
      description: 'The permissions',
      type: 'object',
      required: ['permissions'],
      properties: {
        permissions: {
          type: 'array',
          items: { type: 'object', required: ['key', 'description', 'module'], properties: { key: { type: 'string' }, description: { type: 'string' }, module: { type: 'string' } } },
        },
      },
    },
    ...authedErrors(),
  },
};

export const listRolesSchema = {
  tags: USERS,
  summary: 'List roles',
  description: 'Every role with its permissions, built-in ones included. Needs `USER_MANAGE`.' + NO_TOKENS,
  response: { 200: list('roles', 'Role', 'The roles'), ...authedErrors() },
};

const roleFields = {
  name: { type: 'string', description: 'Unique' },
  description: { type: ['string', 'null'] },
  permission_keys: { type: 'array', items: { type: 'string' }, description: 'Keys from `GET /api/v1/admin/permissions`' },
};

export const createRoleSchema = {
  tags: USERS,
  summary: 'Create a role',
  description: "Needs `USER_MANAGE`; it can't include permissions you don't have." + NO_TOKENS,
  body: { type: 'object', required: ['name', 'permission_keys'], properties: roleFields },
  response: { 201: wrapped('role', 'Role', 'Created'), ...authedErrors([400, '`UNKNOWN_PERMISSION_KEY`'], GUARD_403, [409, '`ROLE_NAME_TAKEN`']) },
};

export const updateRoleSchema = {
  tags: USERS,
  summary: 'Change a role',
  description:
    "Changes only the fields sent; `permission_keys` replaces the role's permissions, for everyone who has it. Nobody holding it may end up with more than you have, and the system can't be left without an admin. Needs `USER_MANAGE`." + NO_TOKENS,
  params: idParams('roleId'),
  body: { type: 'object', properties: roleFields },
  response: { 200: wrapped('role', 'Role', 'Changed'), ...authedErrors([400, '`UNKNOWN_PERMISSION_KEY`'], GUARD_403, 404, [409, '`ROLE_NAME_TAKEN` or `LAST_ADMIN`']) },
};

export const deleteRoleSchema = {
  tags: USERS,
  summary: 'Delete a role',
  description: 'Only a role nobody has (409 `ROLE_IN_USE` says how many do). Built-in roles can be deleted too. Needs `USER_MANAGE`.' + NO_TOKENS,
  params: idParams('roleId'),
  response: { 204: NO_CONTENT, ...authedErrors(GUARD_403, 404, [409, '`ROLE_IN_USE`']) },
};

export const AUDIT_PAGE = { defaultLimit: 100, maxLimit: 500 };

export const auditLogSchema = {
  tags: AUDIT,
  summary: 'Security audit log',
  description:
    'Security entries (sign-in locks, users, roles, tokens, imports, exports, report emails, ...), newest first, a page at a time (`limit`, then `cursor` = the previous `next_cursor` until it is null). ' +
    'With `action`, entries with those actions instead (any action, security or not). Every entry is permanent. Needs `USER_MANAGE`.' +
    NO_TOKENS,
  querystring: {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'Actions, comma-separated, e.g. `API_TOKEN_GENERATED,API_TOKEN_REVOKED`' },
      actor_id: { type: 'string', description: 'Only entries by this user or API token' },
      since: { type: 'string', description: 'Only entries at or after this time (ISO 8601)' },
      ...pageQuery(AUDIT_PAGE.defaultLimit, AUDIT_PAGE.maxLimit),
    },
  },
  response: {
    200: {
      description: 'A page of entries',
      type: 'object',
      required: ['audit_logs', 'next_cursor'],
      properties: {
        audit_logs: {
          type: 'array',
          items: {
            type: 'object',
            required: ['id', 'actor_id', 'actor_type', 'action', 'resource_type', 'resource_id', 'project_id', 'diff', 'ip_address', 'user_agent', 'created_at'],
            properties: {
              id: { type: 'string' },
              actor_id: { type: 'string', description: 'A user id, an API token id, or SYSTEM' },
              actor_type: oneOf(['USER', 'SERVICE_ACCOUNT', 'SYSTEM']),
              action: { type: 'string', description: 'e.g. USER_CREATED, API_TOKEN_REVOKED, DATA_EXPORTED' },
              resource_type: { type: 'string' },
              resource_id: { type: 'string' },
              project_id: { type: ['string', 'null'] },
              diff: { type: 'string', description: 'JSON text: what changed' },
              ip_address: { type: ['string', 'null'] },
              user_agent: { type: ['string', 'null'] },
              created_at: { type: 'string' },
            },
          },
        },
        next_cursor: NEXT_CURSOR,
      },
    },
    ...authedErrors([400, '`INVALID_CURSOR`, or `since` isn\'t a date']),
  },
};

// ---- Custom field definitions ----

const definitionFields = {
  name: { type: 'string', description: 'Unique per kind (case or suite fields)' },
  field_label: { type: 'string', description: 'Shown in the app' },
  is_required: { type: 'boolean', description: 'A required field needs a usable default (CHECKBOX fields can\'t be required)' },
  default_value: { type: ['string', 'null'], description: 'As text; for MULTI_SELECT a JSON list such as ["a","b"]' },
  validation_regex: { type: ['string', 'null'], description: 'TEXT only: values must match it (at most 500 characters; a check taking over 50 ms is refused)' },
  options: {
    type: 'array',
    description: 'SINGLE_SELECT and MULTI_SELECT: the allowed values. Removing one clears it from every case and suite.',
    items: { type: 'object', required: ['option_label', 'option_value'], properties: { option_label: { type: 'string' }, option_value: { type: 'string' }, position: { type: 'integer' } } },
  },
};

export const listDefinitionsSchema = {
  tags: FIELDS,
  summary: 'List custom fields',
  description: 'Every global custom field (fields made by imports belong to a project and are listed by the import routes). Needs `CUSTOM_FIELD_MANAGE`.' + NO_TOKENS,
  querystring: { type: 'object', properties: { entity_type: oneOf(['TestCase', 'TestSuite'], 'Only fields of this kind.') } },
  response: { 200: list('definitions', 'CustomFieldDefinition', 'The fields'), ...authedErrors() },
};

export const createDefinitionSchema = {
  tags: FIELDS,
  summary: 'Create a custom field',
  description:
    'A global field, shown on every case (or suite) in every project. A default is written into every existing one (`seeded_count` says how many). `entity_type` and `field_type` can\'t change later. Needs `CUSTOM_FIELD_MANAGE`.' + NO_TOKENS,
  body: handlerValidated({
    type: 'object',
    required: ['entity_type', 'name', 'field_label', 'field_type'],
    properties: { entity_type: oneOf(['TestCase', 'TestSuite']), field_type: oneOf(CUSTOM_FIELD_TYPES), ...definitionFields },
  }),
  response: {
    201: {
      description: 'Created',
      type: 'object',
      required: ['definition', 'seeded_count'],
      properties: { definition: { $ref: 'CustomFieldDefinition#' }, seeded_count: { type: 'integer', description: 'Existing cases or suites given the default' } },
    },
    ...authedErrors([400, 'A missing or unknown value, or `INVALID_VALIDATION_PATTERN`'], [409, '`FIELD_NAME_TAKEN`'], [422, '`REQUIRED_FIELD_NEEDS_DEFAULT`']),
  },
};

export const updateDefinitionSchema = {
  tags: FIELDS,
  summary: 'Change a custom field',
  description:
    'Changes only the fields sent. Making a field required fills blank values with the default (`applied_default_count`). Needs `CUSTOM_FIELD_MANAGE`.' + NO_TOKENS,
  params: idParams('id'),
  body: handlerValidated({ type: 'object', properties: definitionFields }),
  response: {
    200: {
      description: 'Changed',
      type: 'object',
      required: ['definition', 'applied_default_count'],
      properties: { definition: { $ref: 'CustomFieldDefinition#' }, applied_default_count: { type: 'integer' } },
    },
    ...authedErrors([400, '`INVALID_VALIDATION_PATTERN`'], 404, [409, '`FIELD_NAME_TAKEN`'], [422, '`REQUIRED_FIELD_NEEDS_DEFAULT`']),
  },
};

export const deleteDefinitionSchema = {
  tags: FIELDS,
  summary: 'Delete a custom field',
  description: 'A field with stored values answers 409 `CUSTOM_FIELD_IN_USE` (with the count); `?force=true` deletes it and its values. Needs `CUSTOM_FIELD_MANAGE`.' + NO_TOKENS,
  params: idParams('id'),
  querystring: FORCE_QUERY,
  response: { 204: NO_CONTENT, ...authedErrors(404, [409, '`CUSTOM_FIELD_IN_USE`']) },
};

// ---- Email settings ----

export const getEmailSettingsSchema = {
  tags: EMAIL,
  summary: 'Email settings',
  description: 'The mail server Testify sends report emails through. The password is never returned. Needs `SYSTEM_ADMIN`.' + NO_TOKENS,
  response: { 200: wrapped('settings', 'EmailSettings', 'The settings'), ...authedErrors() },
};

export const putEmailSettingsSchema = {
  tags: EMAIL,
  summary: 'Save email settings',
  description:
    'Replaces the settings: a field left out is cleared, except `smtp_password` (left out keeps it; "" removes it). The password is stored encrypted, so it needs `SECRETS_KEY` on a real database. Needs `SYSTEM_ADMIN`.' + NO_TOKENS,
  body: handlerValidated({
    type: 'object',
    properties: {
      smtp_host: { type: ['string', 'null'], description: 'No host: emails are kept (captured), not sent' },
      smtp_port: { type: ['integer', 'string', 'null'], description: '1-65535' },
      smtp_secure: { type: 'boolean' },
      smtp_user: { type: ['string', 'null'] },
      smtp_password: { type: 'string' },
      from: { type: ['string', 'null'], description: 'An address, optionally "Name <address>"' },
      public_url: { type: ['string', 'null'], description: 'Where links in emails point, e.g. https://testify.example.com' },
    },
  }),
  response: { 200: wrapped('settings', 'EmailSettings', 'Saved'), ...authedErrors([400, '`INVALID_PARAMS` or `SECRETS_KEY_REQUIRED`']) },
};

const sendOutcome = {
  type: 'object',
  required: ['status', 'error'],
  properties: { status: oneOf(['SENT', 'CAPTURED', 'FAILED']), error: { type: ['string', 'null'] } },
};

export const testEmailSchema = {
  tags: EMAIL,
  summary: 'Send a test email',
  description: 'Sends (or, with no mail server, captures) a short email to `to`. Counts toward the 60 emails an hour. Needs `SYSTEM_ADMIN`.' + NO_TOKENS,
  body: handlerValidated({ type: 'object', required: ['to'], properties: { to: { type: 'string' } } }),
  response: {
    200: { description: 'What happened', type: 'object', required: ['email'], properties: { email: sendOutcome } },
    ...authedErrors([400, '`INVALID_PARAMS`: not an email address']),
  },
};

export const lastEmailSchema = {
  tags: EMAIL,
  summary: 'The last email',
  description: 'The last email sent, captured or failed, with its HTML; null if none yet. Needs `SYSTEM_ADMIN`.' + NO_TOKENS,
  response: {
    200: {
      description: 'The last email',
      type: 'object',
      required: ['email'],
      properties: {
        email: {
          type: ['object', 'null'],
          required: ['id', 'project_id', 'schedule_id', 'subject', 'recipients', 'html', 'text_body', 'status', 'error', 'sent_by', 'created_at'],
          properties: {
            id: { type: 'string' },
            project_id: { type: ['string', 'null'] },
            schedule_id: { type: ['string', 'null'] },
            subject: { type: 'string' },
            recipients: { type: 'array', items: { type: 'string' } },
            html: { type: 'string' },
            text_body: { type: 'string' },
            status: oneOf(['SENT', 'CAPTURED', 'FAILED']),
            error: { type: ['string', 'null'] },
            sent_by: { type: ['string', 'null'] },
            created_at: { type: 'string' },
          },
        },
      },
    },
    ...authedErrors(),
  },
};

