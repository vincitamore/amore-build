# Lens: reversibility

What cannot be undone: destructive writes, migrations, sends, deletes — and the missing rollback around them.

## Questions that fire it

- Which operations are irreversible, and what stands between the user/agent and firing them accidentally?
- If this multi-step operation dies at step 3 of 5, what state is left and who cleans it?
- What here should be idempotent-or-transactional and is neither?
