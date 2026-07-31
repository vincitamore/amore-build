# Lens: temporal-ordering

Order-of-events assumptions: init-before-use, TOCTOU, startup/shutdown races, event sequencing.

## Questions that fire it

- What assumes X is initialized/connected/loaded before Y runs — and what enforces that?
- What breaks if this event arrives twice, or the pair arrives reversed?
- Is there a window between 'checked' and 'used' where the fact can rot?
