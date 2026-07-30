# Lens: positivity-certificate

Many hard claims are equivalent to the nonnegativity of some object. Instead of attacking the claim, construct the object whose manifest nonnegativity would settle it — a sum of squares, a positive-definite kernel, an energy, a variance.

## Questions that fire it

- Is there a known or constructible reformulation of the target as "some quantity is ≥ 0 for every test input" — and what family of test inputs makes it sharpest?
- Can the quantity be decomposed into visibly nonnegative pieces (squares, norms, probabilities, counts) plus a remainder — and what exactly does the remainder obstruct?
- What is the smallest test case where the desired positivity is checkable outright, and does the certificate found there suggest a general shape?

## Overfire (vice)

- Numerically checking positivity on samples and drifting toward treating that as the certificate (evidence, not proof — keep the ledger honest).
- Forcing positivity language onto claims with no quadratic or averaging structure to host it.
