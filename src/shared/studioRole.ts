/** Logto may return bare role names or organizationId:role. Organization IDs are case sensitive. */
export function hasStudioRole(roles: string[], orgId: string, allowed: readonly string[]): boolean {
  return roles.some(raw => {
    const value = raw.trim();
    const sep = value.lastIndexOf(':');
    return (sep < 0 || value.slice(0, sep) === orgId) && allowed.includes(value.slice(sep + 1).trim().toLowerCase());
  });
}
