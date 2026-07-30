# Lens: cardinality

0/1/N assumptions: code written for exactly-one that will meet none or many.

## Questions that fire it

- What breaks when the list is empty, when the 'unique' key matches twice, when the singleton is constructed again?
- Which .find() results are used without a null arm?
- What assumes one caller, one instance, one thread, one file — and what enforces that?
