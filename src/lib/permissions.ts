/**
 * Fixed permission catalogue.
 *
 * Permissions map 1:1 to backend capabilities, so they live in code (not a DB
 * table). Roles reference these keys; a role holding `"*"` has everything.
 */

export interface PermissionDef {
  key: string;
  label: string;
}

export interface PermissionGroup {
  module: string;
  permissions: PermissionDef[];
}

export const PERMISSION_GROUPS: PermissionGroup[] = [
  {
    module: 'Dashboard',
    permissions: [{ key: 'dashboard.view', label: 'View dashboard' }],
  },
  {
    module: 'Brands',
    permissions: [
      { key: 'companies.view', label: 'View' },
      { key: 'companies.create', label: 'Create' },
      { key: 'companies.edit', label: 'Edit' },
      { key: 'companies.delete', label: 'Delete' },
    ],
  },
  {
    module: 'Product Categories',
    permissions: [
      { key: 'categories.view', label: 'View' },
      { key: 'categories.create', label: 'Create' },
      { key: 'categories.edit', label: 'Edit' },
      { key: 'categories.delete', label: 'Delete' },
    ],
  },
  {
    module: 'Customers',
    permissions: [
      { key: 'customers.view', label: 'View' },
      { key: 'customers.create', label: 'Create' },
      { key: 'customers.edit', label: 'Edit' },
      { key: 'customers.delete', label: 'Delete' },
    ],
  },
  {
    module: 'Get Quote',
    permissions: [
      { key: 'jobwork.view', label: 'View quotes' },
      { key: 'jobwork.create', label: 'Create / analyze' },
    ],
  },
  {
    module: 'Users',
    permissions: [
      { key: 'users.view', label: 'View' },
      { key: 'users.create', label: 'Create' },
      { key: 'users.edit', label: 'Edit' },
      { key: 'users.delete', label: 'Delete' },
    ],
  },
  {
    module: 'Roles',
    permissions: [
      { key: 'roles.view', label: 'View' },
      { key: 'roles.create', label: 'Create' },
      { key: 'roles.edit', label: 'Edit' },
      { key: 'roles.delete', label: 'Delete' },
    ],
  },
  {
    module: 'Settings',
    permissions: [
      { key: 'settings.view', label: 'View' },
      { key: 'settings.edit', label: 'Edit' },
    ],
  },
  {
    module: 'Email',
    permissions: [{ key: 'email.send', label: 'Send email' }],
  },
  {
    module: 'API Keys',
    permissions: [
      { key: 'apikeys.view', label: 'View' },
      { key: 'apikeys.edit', label: 'Manage' },
    ],
  },
];

/** The wildcard permission — grants everything. */
export const WILDCARD = '*';

/** Flat list of every valid permission key. */
export const ALL_PERMISSION_KEYS: string[] = PERMISSION_GROUPS.flatMap((g) =>
  g.permissions.map((p) => p.key),
);

const VALID = new Set<string>([WILDCARD, ...ALL_PERMISSION_KEYS]);

/** True if `key` is a known permission (or the wildcard). */
export function isValidPermission(key: string): boolean {
  return VALID.has(key);
}

/** Whether a set of granted permissions satisfies the required one. */
export function hasPermission(granted: string[], required: string): boolean {
  return granted.includes(WILDCARD) || granted.includes(required);
}

/**
 * A create/edit/delete permission implies the module's `view` permission — you
 * can't act on a page you can't see. Adds the missing `<module>.view` keys.
 */
export function withImpliedViews(perms: string[]): string[] {
  if (perms.includes(WILDCARD)) return perms;
  const set = new Set(perms);
  for (const p of perms) {
    const [moduleKey, action] = p.split('.');
    if (action && action !== 'view') {
      const viewKey = `${moduleKey}.view`;
      if (VALID.has(viewKey)) set.add(viewKey);
    }
  }
  return Array.from(set);
}
