# Lens: api-contract-drift

Divergence between the declared contract and behavior: types wider/narrower than reality, comments describing v1, docs promising the unimplemented.

## Questions that fire it

- Do the type signatures admit values the body doesn't handle (or forbid values it does)?
- Which comments/docstrings would mislead a caller today?
- What does the README/help text promise that the code no longer does?
