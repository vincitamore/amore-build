# Lens: mutation-visibility

Hidden side effects: functions mutating their inputs, shared references escaping, caches going stale on mutation.

## Questions that fire it

- Which functions mutate arguments the caller still holds?
- Where does a returned reference alias internal state the module will mutate later?
- Which caches/memos assume the underlying data never changes — and who changes it?
