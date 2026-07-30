// A global doc opened from the graph / dashboard / search can offer a one-key jump to the member
// that owns it, with the item already selected — so you act on it where its actions live, instead
// of navigating to the screen and hunting it out of the list. The action logic is NOT duplicated
// here: this only names the owning member + its single-key action legend (for the doc's hint); the
// verbs stay in the members (their regula calls + modals are the single source of truth).

const IS_ABSOLUTE = /^([a-zA-Z]:|\/|\\)/;

export interface DocJumpInfo {
  member: string; // MEMBERS entry to navigate to (must match the shell's member names)
  typeLabel: string;
  actions: string; // the member's single-key action legend, shown as a hint on the doc
}

/**
 * The member + action legend for a doc path, or null if the doc has no lifecycle action surface
 * (knowledge/forge/files) or is an absolute cross-tree path with no owning member. Path-prefix
 * based — org-relative paths only; the members are path-scoped the same way.
 */
export function docJumpInfo(path: string | null | undefined): DocJumpInfo | null {
  if (!path || IS_ABSOLUTE.test(path)) return null;
  switch (path.split('/')[0]) {
    case 'tasks':
      return { member: 'Tasks', typeLabel: 'task', actions: 'c complete · a active · b block · r review · p pause' };
    case 'inbox':
      return { member: 'Inbox', typeLabel: 'inbox item', actions: 'r resolve · m triage · x archive · d delete' };
    case 'reminders':
      return { member: 'Reminders', typeLabel: 'reminder', actions: 'c complete · d dismiss · o ongoing · s snooze' };
    default:
      return null;
  }
}
