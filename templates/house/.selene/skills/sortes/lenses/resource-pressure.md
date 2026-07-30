# Lens: resource-pressure

Behavior under slow, full, and large: missing timeouts, unbounded buffers/queues/caches, quadratic growth.

## Questions that fire it

- Which awaited operations have no timeout, and what hangs when they stall?
- What grows without bound if the consumer is slower than the producer?
- What is O(n²)-or-worse here, and what n does production actually see?
