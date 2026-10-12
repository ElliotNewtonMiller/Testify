import type { Kysely } from 'kysely';
import type { Database } from '@testify/db';

/** Who recorded something: user ids → usernames, API token ids → "<name> (API token)". */
export async function actorNames(db: Kysely<Database>, ids: Iterable<string | null>): Promise<Map<string, string>> {
  const unique = [...new Set([...ids].filter((id): id is string => Boolean(id)))];
  if (unique.length === 0) return new Map();
  const [users, tokens] = await Promise.all([
    db.selectFrom('users').select(['id', 'username']).where('id', 'in', unique).execute(),
    db.selectFrom('api_tokens').select(['id', 'name']).where('id', 'in', unique).execute(),
  ]);
  const names = new Map<string, string>();
  for (const u of users) names.set(u.id, u.username);
  for (const t of tokens) names.set(t.id, `${t.name} (API token)`);
  return names;
}
