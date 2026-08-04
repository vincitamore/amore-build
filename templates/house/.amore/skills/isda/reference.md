# ISDA Reference

Formal treatment. Load on demand when SKILL.md's summary is not enough.

## Purpose

This document provides the information-theoretic grounding for the framework, the formal definitions behind each of the seven strata and four intensity levels, the historical primary-source attribution for the Nicomachan-Boethian 2x2, and the honest acknowledgment of where the formalism stops and judgment begins.

## 1. Foundations

### Kolmogorov complexity

For a fixed universal Turing machine `U`, the Kolmogorov complexity of a string `x` is:

```
K(x) = min{|p| : U(p) = x}
```

the length of the shortest program producing `x`. Properties:

- **Invariance:** machine-independent up to an additive constant `O(1)` depending only on the choice of `U`.
- **Incomputability:** no algorithm computes `K(x)` for all `x`.
- **Chain rule:** `K(x, y) = K(x) + K(y | x*) + O(1)`, where `x*` is the shortest program for `x`.
- **Entropy connection:** for computable probability distributions, `E[K(x)] ≈ H(P)`.

### Conditional Kolmogorov complexity

Given auxiliary input `y`, the conditional complexity is:

```
K(x | y) = min{|p| : U(p, y) = x}
```

This is the fundamental quantity for the framework. Every stratum is a conditional complexity against progressively richer auxiliary input.

### What Kolmogorov does not capture

The Random Encyclopedia Problem: 3000 pages of uniformly random letters have higher `K` than a 3000-page encyclopedia, yet the encyclopedia is vastly more useful. Kolmogorov measures generative complexity, not value. Maximum `K` is achieved by pure noise.

The gap this framework closes is not "how hard is this to reproduce?" but "how much of this is doing irreducible work toward a purpose?"

## 2. The Telos-Relative Definition

### The interpretation problem

Kolmogorov complexity is defined for strings, not meanings. The same meaning has many surface forms. Naive answers to "which K do we measure?" fail.

### The telos turn

The framework sidesteps the general interpretation problem by binding meaning to purpose:

```
K_τ(d, t) = min{K(x) : achieves(x, t)}
```

The telos-relative complexity of document `d` for task `t` is the length of the shortest document that accomplishes `t`. This is tractable in a way general semantic complexity is not, because `achieves(x, t)` can be operationalized via task performance, embedding similarity, human judgment, or downstream action success.

### Telos-weighted decomposition

`K_τ` distributes across the seven strata with telos-dependent weights:

```
K_τ(d, t) ≈ Σᵢ wᵢ(t) · Sᵢ(d)
```

with `Σᵢ wᵢ(t) = 1`. Under unspecified telos, `wᵢ = 1/7` (uniform). Under specific telos, weights shift:

| Telos | Dominant strata (high `wᵢ`) |
|---|---|
| Persuade | Rhetorica, Musica, Astronomia |
| Teach | Geometria, Dialectica, Arithmetica |
| Prove | Dialectica, Arithmetica, Grammatica |
| Inspire | Musica, Rhetorica (Inventio-canon dominant), Astronomia |
| Catalog | Arithmetica, Geometria |
| Move emotionally | Musica, Astronomia, Rhetorica |
| Transmit fact | Arithmetica, Dialectica |
| Preserve as artifact | All seven equally; intensity tags shift toward Original |

The weights are a per-analysis specification; the practitioner states the weighting scheme alongside the telos.

### Audience relativity

Semantic complexity varies by reader:

```
K_τ(d, t, reader) = min{K(x) : achieves_for(x, t, reader)}
```

A technical proof is near-zero `K_τ` for a specialist and enormous for a novice. The reader's knowledge state is part of the problem specification, handled via the substrate parameter at every stratum.

## 3. The Nicomachan-Boethian 2x2

The structural spine of the framework is a classical 2x2 classification of the mathematical arts. Unlike most pedagogical frameworks built on historical vocabulary, this one is load-bearing in the primary sources, not a modern retrofit.

### Primary source: Nicomachus of Gerasa

The 2x2 is first made explicit in Nicomachus's *Introduction to Arithmetic* I.2-3 (c. 100 CE), the primary source Boethius translates four hundred years later:

> *"Of quantity, one kind is viewed by itself, having no relation to anything else, as 'even,' 'odd,' 'perfect,' and the like, and the other is relative to something else and is conceived of together with its relationship to another thing, like 'double,' 'greater,' 'smaller,' 'half.' ... The study of absolute quantity is arithmetic; that of relative quantity is music; that of size without motion is geometry; and that of size with motion is astronomy."*
>
> Nicomachus, *Introduction to Arithmetic* I.3 (D'Ooge trans. 1926)

This is the load-bearing passage. Four mathematical sciences mapped to four cells:

|  | at rest | in motion |
|---|---|---|
| **discrete** | Arithmetica (*number in itself*) | Musica (*number in proportion*) |
| **continuous** | Geometria (*magnitude immobile*) | Astronomia (*magnitude mobile*) |

### Transmission: Boethius

Boethius transmits this classification verbatim into the Latin tradition in *De Institutione Arithmetica* I.1 (c. 500 CE), using the Latin vocabulary *multitudo per se*, *multitudo ad aliud*, *magnitudo immobilis*, *magnitudo mobilis*. His treatment is, by his own admission, an adaptation of Nicomachus ("the itinerary, not the footprints").

### Independent attestation: Proclus

Proclus independently attributes the same structure to the Pythagoreans in his *Commentary on the First Book of Euclid's Elements* (5th c.):

> *"The Pythagoreans considered all mathematical science to be divided into four parts: one half they marked off as concerned with quantity, the other half with magnitude; and each of these they posited as twofold. A quantity can be considered in regard to its character by itself or in its relation to another quantity; magnitudes as either stationary or in motion."*
>
> Proclus, *Commentary on Euclid* (Morrow trans. 1970)

Two independent transmission lines (Nicomachus through Boethius through the Latin West; Proclus through Greek commentators) carry the same classification. This is not one author's idiosyncratic schema.

### Aristotelian foundation

Aristotle supplies the philosophical foundation without the 2x2 itself. *Categories* 6 distinguishes discrete quantity (number, speech) from continuous quantity (line, surface, body, time, place). *Metaphysics* Δ.13 gives the numerable and measurable, plurality and magnitude pair. Aristotle provides the discrete and continuous axis. He does not combine it with a rest and motion axis to classify the mathematical sciences. The 2x2 crystallizes in the Pythagorean-Platonic tradition that Nicomachus inherits.

### The ontological caveat on rest and motion

The rest-and-motion axis is not kinematic. In the classical scheme:

- "At rest" means the *object studied* does not require time in its definition. Arithmetic studies numbers (a finished set); geometry studies shapes (a triangle's definition does not include duration).
- "In motion" means the *object studied* has temporal or sequential structure as an essential property. Music studies proportions that unfold through time (rhythm, harmony); astronomy studies regular periodic motion of celestial bodies.

Applied to text analysis, "in motion" means the measured property is temporal or sequential. In prose, the reader's traversal through the text is its "motion": reading-time is the text's temporal dimension. Musica measures rhythm at local scale (syllable, clause, sentence); Astronomia measures trajectory at global scale (document). Both are temporal in the sense the classical tradition meant.

## 4. The Seven Strata: Formal Definitions

Let `d` be a document, `G` its genre context (split into `G_grammar` for sentence-level conventions and `G_geometry` for document-level conventions), `KB` a named retrieval substrate, `R` a set of inference rules, `Π_local` a genre-conditional local-prosodic-expectation distribution, `Τ_global` a genre-conditional global-trajectory-expectation distribution, `Δ` a curatorial decision space, and `C = {G, KB, R, Π_local, Τ_global, Δ}` the full context.

### S₁: Grammatica

```
Grammatica(d, G_grammar) = K(sentence-forms(d) | G_grammar)
```

The conditional complexity of the document's sentence-level form given the genre's grammatical conventions. Captures syntactic templates, sentence length distribution, clause structure, compound coinages, register consistency.

**Scope shrinkage footnote.** Medieval *grammatica* (Donatus, Isidore, Hugh of St. Victor) covered phonology, morphology, syntax, figures of speech, poetics, and literary-ethical criticism, a much broader art than the modern usage. The framework uses Grammatica in the narrow sense of sentence-level form to make the seven strata non-overlapping. Figures of speech belong to Musica; poetics distributes across Musica, Geometria, and Rhetorica. The shrinkage is pragmatic. Alternative narrower classical terms (*phrasis*, *lexis*) are available but cost familiarity.

### S₂: Dialectica

```
Dialectica(d, KB, R) = K(claims(d) | Closure(KB, R))
```

The conditional complexity of the document's claims given the deductive closure of the substrate under the inference rules. Claims in the closure have zero marginal complexity (they follow mechanically); claims outside the closure are irreducible inferential moves. Hugh of St. Victor: *"dialectic is clear-sighted argument which separates the true from the false."* The fit is exact.

### S₃: Rhetorica

```
Rhetorica(d, Δ) = H(decisions(d) | Δ)
```

The Shannon entropy of the document's curatorial decisions given the available decision space `Δ`. Selection from `n` items, ordering of `m` items, choosing from `f` framings: each decision contributes `log₂(|options|)` bits.

**Rhetorica's internal five-canon substructure.** When Rhetorica dominates an analysis, the report can drill down to the classical five canons of rhetoric:

- **Inventio:** discovery or devising of material.
- **Dispositio:** arrangement, ordering.
- **Elocutio:** style, diction, figures of speech.
- **Memoria:** the mental treasury of places, topics, commonplaces, references.
- **Pronuntiatio:** delivery, voicing (intersects Musica for oral or quasi-oral texts).

These are not separate top-level strata. They are the operational sub-stages of Rhetorica, where the classical tradition put them (Cicero, *De Inventione*; Quintilian, *Institutio Oratoria*). The analyst may report "Rhetorica-dominant, with Inventio at Original intensity" when the new curatorial move is in the discovery of new argumentative material rather than its arrangement or style.

**Memoria as substrate parameter.** The reader-side memoria ("what the reader already holds") is handled by the substrate parameter that conditions every stratum. Memoria-as-substrate is not a stratum; it is the KB against which Arithmetica and Dialectica are conditioned. This is the correct structural home for retrievability.

### S₄: Arithmetica

```
Arithmetica(d) = |propositions(d)| via CPIDR
```

The count of atomic propositions the document asserts, divided by total words (propositional density). Operationalized via CPIDR (Brown, Snodgrass, Covington, Herman, Kemper 2008), which approximates Kintsch-Turner-Greene propositional counting from POS tags plus ~40 adjustment rules. CPIDR's agreement with human consensus is r = 0.97, which exceeds the human-to-human baseline of r = 0.82. The inter-rater reliability problem of raw Kintsch hand-coding is solved.

**Why "discrete at rest".** Propositional density is discrete (atomic countable units), at rest (static, not dependent on ordering or dynamics), and foundational (every other stratum presupposes that the text asserts a finite set of claims whose count is well-defined). The Boethian "number in itself" fit is tight, not stretched.

**Orthogonality to Dialectica.** Arithmetica counts the proposition set; Dialectica measures the inferential structure on that set. A text with many unrelated assertions is high-Arithmetica and low-Dialectica; a text with a few premises and a long chain of rigorous derivations is low-Arithmetica and high-Dialectica.

**Orthogonality to Memoria-substrate.** Arithmetica is a property of the text itself (how many propositions it contains). The substrate parameter governs retrievability of those propositions. Different axes.

### S₅: Geometria

```
Geometria(d, G_geometry) = K(architecture(d) | G_geometry)
```

The conditional complexity of the document's architecture (section hierarchy, paragraph count, layout, structural relationships) given the genre's geometric conventions. Captures IMRaD structure in papers, TOC depth in manuals, stanza patterns in verse, sectioning in essays.

**Why "continuous at rest".** Document architecture is extensional (spatial-metaphorical: the text has *extent*), static (not dependent on the reader's traversal order), and describable without time. The Boethian "magnitude immobile" fit is analogical (applying the spatial metaphor to document-space rather than physical-space), and the analogy preserves the static-extension sense cleanly.

### S₆: Musica

```
Musica(d, Π_local) = K(prosody(d) | Π_local)
```

The conditional complexity of the document's prosodic profile given the local-scale UID (Uniform Information Density) null expectation. `prosody(d)` is a time-series of phonological or structural features (stress, syllable duration, sentence length, rhetorical-figure density) over the document's reading sequence. `Π_local` is a learned, genre-conditional distribution of local rhythmic patterns: the UID-smooth baseline.

**Grounding.** Aylett and Turk 2004 ("Smooth Signal Redundancy") and Levy and Jaeger 2007 (UID) provide the information-theoretic framework. Cicero's *De Oratore* 3.173-198 and Quintilian's *Institutio Oratoria* books 5 and 9 provide the two-thousand-year humanistic tradition of formal prose-rhythm measurement via cursus and clausulae. Augustine's *De Musica* I.iv.5 defines musica as *scientia bene modulandi* ("the science of well-measured movement"), the prosodic sense, distinct from the Boethian ratio-theoretic sense, providing the label warrant for using "Musica" as the stratum name.

**Why "discrete in motion".** Local prosodic units (syllables, stresses, metrical feet, rhetorical figures) are discrete countable atoms whose essential property is their temporal sequence. The Boethian "number in proportion" fit is exact in Augustine's reading (*musica = numerus in tempore*, number in time).

**Rhetorical figures as Musica content.** Isocolon, anaphora, chiasmus, climax, periodic build, asyndeton, tricolon: all are compressible as short specifications that generate long local patterns. "Three parallel clauses ascending in length" is a ~50-byte specification that generates a 200-byte stretch of marked prose.

### S₇: Astronomia

```
Astronomia(d, Τ_global) = K(trajectory(d) | Τ_global)
```

The conditional complexity of the document's global trajectory given the genre-conditional global-scale trajectory-expectation distribution. `trajectory(d)` is a time-series of information intensity, argumentative weight, or emotional force over document position. `Τ_global` is a learned distribution of trajectory shapes for the genre: the global UID null expectation.

**Grounding.** Wilmot and Keller 2020 ("Modelling Suspense as Uncertainty Reduction over Neural Representation," ACL) provides the direct formal analog: a per-sentence time-series of surprise and uncertainty reduction computed via a hierarchical neural reader model, validated against human suspense annotations. Schulz, Patrício, and Odijk 2024 ("Narrative Information Theory," NeurIPS Workshop) provides the discrete-state four-quantity decomposition (complexity, pivots, suspense, plot twists). Reagan et al. 2016 ("The emotional arcs of stories," *EPJ Data Science*) provides the empirical landmark (1,327 texts, six canonical shapes). Fudolig et al. 2023 provides the methodological precedent for EMD decomposition of trajectory signals.

**Why "continuous in motion".** Global trajectory is a continuous signal over document position whose essential property is sequential unfolding. The Boethian "magnitude in motion" fit is exact. Astronomia in the classical tradition is regular periodic motion at cosmic scale; global trajectory is information-flow motion at document scale.

**Contribution.** The prior art (Wilmot and Keller, Schulz, Reagan, Fudolig) leaves the genre-conditional prior `Τ_global` implicit or emergent. This framework requires it explicitly, as a named input analogous to the substrate parameter for retrievability. That is the modest, honest originality of the Astronomia stratum; the measurement instrument itself is inherited from the prior-art literature.

## 5. The Intensity Ladder: Formal Definition

The four-level conditioning gradient applies per-stratum:

| Level | Name | Formal definition |
|---|---|---|
| 1 | **Stock** | `K(Sᵢ \| KB)` is small; the stratum's content is retrievable from the named substrate |
| 2 | **Implied** | `K(Sᵢ \| Closure(KB, R))` is small; the content follows mechanically from substrate plus inference rules |
| 3 | **Selected** | `H(Sᵢ \| Δᵢ)`; the content is a curatorial choice from a visible per-stratum option space |
| 4 | **Original** | `K(Sᵢ \| C) ≥ |Sᵢ| - O(1)`; the content is algorithmically random relative to full context |

**Per-stratum dominant tag, not full matrix.** The intensity gets reported as a single dominant tag per stratum. Seven strata, one tag each, seven tags per analysis. A full 7x4 cross-tabulation (28 cells) is rejected because:

1. Reliability compounds multiplicatively across joint stratum-intensity decisions.
2. Empirical cell collapse: at least six of 28 cells are empirically empty for most texts. Arithmetica-Selected (propositional count is not a selection), Arithmetica-Original (originated propositions belong in Dialectica or Inventio-canon), Astronomia-Stock (a fully-predictable trajectory is not "in" the text), Geometria-Original (vanishingly rare outside concrete poetry), Musica-Original outside poetic innovation, Grammatica-Selected collapses into Rhetorica-Selected.
3. The 7x4 matrix exceeds working-memory limits for readers.

**Reading the tags.** A fully conventional text reads seven Stock tags. A text with specific-origin originality reads one or two Original, others lower. A text with multi-axis originality (rare) reads multiple Original.

## 6. Unified UID Spine: Musica and Astronomia at Dual Scales

The framework has a single theoretical backbone for both temporal strata: Uniform Information Density (UID) tested at local and global scales. The quadrivium's classical distinction within the "in motion" half maps onto the modern UID literature's scale distinction.

### The unification

Both `K(prosody(d) | Π_local)` and `K(trajectory(d) | Τ_global)` are instances of the same pattern: conditional Kolmogorov complexity of an information-flow profile against a genre-conditional UID null. The scale of the sampled profile is the only difference:

- **Local UID (Musica):** per-syllable, per-word, per-clause, per-sentence. Captures prose rhythm, meter, rhetorical figures, periodic sentence structure. Grounded in Aylett and Turk 2004 and Levy and Jaeger 2007. Cicero, Quintilian, and the cursus tradition provide the humanistic provenance.

- **Global UID (Astronomia):** per-section, per-chapter, per-percentile of document length. Captures argumentative arc, narrative structure, suspense trajectory, emotional shape. Grounded in Wilmot and Keller 2020 and Schulz et al. 2024. Reagan 2016 and Fudolig 2023 provide empirical landmarks.

A text conforming to genre expectations at both scales has minimal Musica mass and minimal Astronomia mass: rhythmically flat and trajectory-flat (see the "How Photosynthesis Works" example in `examples.md`). A text violating UID at local scale has high Musica (Hopkins's sprung rhythm: Musica-Original). A text violating UID at global scale has high Astronomia (a novel with unconventional pacing, an argument with unusual trajectory).

The two can vary independently. Hopkins is Musica-Original and Astronomia-Implied (the praise-poem trajectory is conventional). A tightly-argued research paper with unusual structure is Musica-Stock and Astronomia-Selected or higher.

### Implication for analysis

When Musica and Astronomia both carry non-Stock intensity, check whether the signals correlate (both rising at the same points) or are independent (peaks at different positions). Correlated peaks indicate a text that uses local rhythm to mark global trajectory points: climactic moments are both prosodically marked and structurally pivotal. Independent peaks indicate a text where local figures and global trajectory do different work.

## 7. Derived Metrics

### Semantic Compression Ratio

```
SCR(d, t) = |d| / K_τ(d, t)
         ≈ |d| / (Grammatica + Dialectica + Rhetorica + Arithmetica + Geometria + Musica + Astronomia)_compressed
```

Interpretation: how much syntactic length exceeds semantic necessity toward telos `t`. Bands are genre-qualified (see SKILL.md); argumentative prose expects 2-5, expository prose legitimately runs 15-30.

### Novelty Density

```
ND(d, C) = Σᵢ (intensity_weight(Sᵢ) · |Sᵢ|_compressed) / Σᵢ |Sᵢ|_compressed
```

where `intensity_weight` maps Stock to 0.0, Implied to 0.1, Selected to 0.3, Original to 1.0. Weighted by stratum compressed size so that dominant-stratum intensity carries more weight in the aggregate.

### Retrievability Index

```
RI(d, KB, R) = Σᵢ (retrievable_weight(Sᵢ) · |Sᵢ|_compressed) / Σᵢ |Sᵢ|_compressed
```

where `retrievable_weight` maps Stock to 1.0, Implied to 0.7, Selected to 0.0, Original to 0.0. Reports the fraction of the document already present in or derivable from the named substrate.

### Telos fidelity

For compression experiments:
```
fidelity(x, d, t) = 1 - semantic_distance(x, d) under task t
```
A candidate compressed version `x` achieves `t` if `fidelity(x, d, t) ≥ θ` for some threshold.

## 8. The Strata as a Pipeline

The seven strata map onto a transformation pipeline. This turns ISDA from a diagnostic into a procedure.

| Role | Strata | Action |
|---|---|---|
| Gatherer | Arithmetica, Memoria-substrate | Identify propositions; replace references with substrate pointers |
| Analyst | Dialectica, Geometria | Mark derivable claims; map document architecture |
| Synthesizer | Rhetorica, Musica | Surface curatorial decisions; measure local rhythmic and prosodic structure |
| Distiller | Astronomia, Inventio-canon | Extract the irreducible trajectory; identify the originated material |

Forward pipeline: compress a text to its minimum telos-preserving form. Reverse pipeline: expand an originated core into a full text via substrate, genre, telos, and desired stratum profile.

## 9. Caveats and Honest Limits

`K` and `K_τ` are uncomputable. The framework produces principled estimates, not measurements. Every reported number is an approximation, typically based on human judgment anchored by preprocessor counts.

Telos is required. Any result without a stated telos is ambiguous at best, misleading at worst.

Substrate is required. Arithmetica density can be computed without a substrate, but Dialectica, RI, and the intensity tags are meaningless without a named KB.

The intensity ladder is per-stratum dominant. A 28-cell matrix is rejected as the output format. Dominant tag per stratum is the correct granularity.

Cross-stratum interactions exist. Original Dialectica claims can retroactively change Arithmetica (once published, the new propositions are in the corpus for the next reader). Musica choices can make certain claims harder to state without their rhythmic form. The decomposition is approximate, not exact. Name the caveat, report the dominant cell, move on.

The Grammatica and Musica boundary fuzzes on metrical texts. Metrical form belongs to Musica; syntactic form belongs to Grammatica. Be explicit about where you draw the line when analyzing verse.

Rhetorica shrinks the medieval art. Classical rhetorica is the full persuasive enterprise; the framework uses it narrowly for curatorial decisions with the five canons as internal sub-stratification when needed.

CPIDR is English-specific. The POS-tag adjustment rules are calibrated on English. Non-English Arithmetica measurement requires a language-independent proxy or per-language CPIDR adaptation. Hebrew, Greek, Latin support remains a limitation.

Astronomia's `K(·)` is approximated by cross-entropy. Wilmot and Keller 2020 uses conditional Shannon cross-entropy, which is computable; true conditional Kolmogorov complexity is not. Astronomia in practice reports the cross-entropy estimate.

`Τ_global` for genre-conditional priors is a placeholder. Full trained reader models per genre are a research program. The current framework uses a "genre-conditional UID null" placeholder: the uniform-information-density expectation at global scale, without a genre-specific reader model.

## 10. Applications

Self-editing. Identify Stock, Implied, and Selected strata as cut-candidates; preserve Original strata. Calibrate to telos.

Compression targets. Generate tweet, paragraph, abstract, or essay versions by walking the compression curve.

Quality assessment. High novelty density relative to genre baseline suggests genuine intellectual work.

Originality analysis. High RI against a named corpus plus a Stock-dominant profile suggests insufficient contribution.

Editorial feedback. "Your Dialectica is Original in paragraphs 1, 3, 5, 7, 9; your Musica is Selected; your Astronomia is Stock; the essay's work lives in the inferential moves, not the rhythm or the arc. Cut the Musica figures if you want to tighten without losing the argument."

Curriculum design. Measure how `K_τ` changes as the assumed reader's substrate grows.

Prompt compression. Treat the prompt as `d`, the desired completion as `t`, minimize `K_τ(prompt, t)` empirically with per-stratum weights reflecting which strata the completion actually needs.

## 11. The Deepest Claim

The Original level of the intensity ladder, content algorithmically random relative to all available context at a specific stratum, is what justifies a text's existence at that stratum. Everything else at lower intensity is scaffolding, elaboration, or apparatus.

Original is per-stratum, not global. A good encyclopedia entry is all-Stock: that is its telos. A lyric poem is Musica-Original. An original argumentative essay is Dialectica-Original. A textbook is all-Stock. A research paper is Dialectica-Original with possibly Geometria-Selected. The classical rhetoric of *inventio* (finding new material) appears as Rhetorica-Original with the Inventio-canon dominant.

A text with zero Original tags across all seven strata is a compilation, not a contribution. This is not a value judgment. Compilations are legitimate and necessary: textbooks, reference documentation, instruction manuals all should be all-Stock. It is an operational criterion. For a text to add something at a given stratum, that stratum's content must be algorithmically random relative to everything already available at that stratum. That portion, however small and in whichever stratum it lives, is what the text is for.

---

*The formal definitions in this document are proposals, not established theorems. They are sharp enough to be useful and honest enough to show where they fail. Treat them as the scaffolding for judgment, not a substitute for it.*
