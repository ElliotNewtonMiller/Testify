export interface PermissionOverride {
  permission_key: string;
  is_granted: boolean;
}

/**
 * Merges a base permission set (a role's bundle, or the full registry for SYSTEM_ADMIN)
 * with a list of per-user overrides. Overrides always win over the base set: is_granted
 * true adds a key the base set lacks, false removes one even if the base set grants it --
 * including a SYSTEM_ADMIN-derived full set, deliberately, so an override always has final
 * say. When both global and project-scoped overrides apply, pass the project ones last;
 * this function applies overrides in array order, so a later entry for the same key wins.
 */
export function applyPermissionOverrides(
  basePermissions: string[],
  overrides: PermissionOverride[]
): string[] {
  const result = new Set(basePermissions);
  for (const o of overrides) {
    if (o.is_granted) {
      result.add(o.permission_key);
    } else {
      result.delete(o.permission_key);
    }
  }
  return Array.from(result);
}
