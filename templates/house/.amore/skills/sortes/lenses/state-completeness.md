# Lens: state-completeness

State machines, explicit or accidental: unhandled states, illegal transitions, orphan flags.

## Questions that fire it

- Enumerate the states this object can actually be in — which combinations does the code never handle?
- Which transitions are possible in the wild but unrepresented in the handler (a switch with no default carrying meaning)?
- Which boolean pairs encode four states where only three are legal — and where is the fourth rejected?
