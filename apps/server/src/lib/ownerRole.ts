/**
 * ownerRole.ts — A490: the ONE place a role's NAME still decides anything.
 *
 * A role named owner (or admin — onboarding names the owner's role 'Admin') is the business's owner: everything, every
 * branch, never refused. That is who the person IS, not a permission, so it cannot be a key. Every other decision that
 * used to read a role name (manager, supervisor, branch_manager, cashier) reads permissions now.
 */
export const OWNER_ROLE_NAMES: readonly string[] = ['owner', 'admin'];

export function isOwnerRoleName(name: string | null | undefined): boolean {
  return OWNER_ROLE_NAMES.includes(String(name ?? '').trim().toLowerCase());
}
