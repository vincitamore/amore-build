# Irreducible Semantic Density Analysis: A Theoretical Framework

*Toward a rigorous theory of telos-relative semantic compression across the seven liberal arts.*

---

## Abstract

A framework for measuring the compressibility of written content relative to a stated purpose (*telos*) and a named retrieval substrate. The framework decomposes any text into seven strata organized via the Nicomachan-Boethian 2x2 classification of the mathematical arts (discrete or continuous quantity, crossed with at-rest or in-motion state) augmented by the three verbal arts of the trivium. Each stratum corresponds to a conditional Kolmogorov complexity against progressively richer context. Each carries a dominant intensity tag drawn from a four-level ladder that applies across all seven strata: **Stock**, **Implied**, **Selected**, **Original**. The central quantity, telos-relative semantic complexity `K_τ(d, t) ≈ Σᵢ wᵢ(t) · Sᵢ(d)`, is a telos-weighted sum of stratum contributions. The framework finesses the general interpretation problem by binding meaning to purpose, and handles the retrieval-substrate dependence by making it an explicit parameter at every stratum. Musica (local prosodic rhythm) and Astronomia (global argumentative trajectory) unify as Uniform Information Density tested at two scales, grounded in Aylett and Turk 2004 (local) and Wilmot and Keller 2020 (global). Arithmetica is grounded in Kintsch-Turner-Greene propositional density operationalized via CPIDR. The deepest claim: the Original level of the intensity ladder, content algorithmically random against full context at a specific stratum, is what justifies a text's existence at that stratum. A text with no Original content at any stratum is a compilation, not a contribution.

---

## Part I: The Kolmogorov Gap

### What Kolmogorov captures

For a fixed universal Turing machine `U`, the Kolmogorov complexity of a string `x` is `K(x) = min{|p| : U(p) = x}`, the length of the shortest program that outputs `x`. Conditional complexity `K(x | y)` extends this: the shortest program producing `x` when `y` is available as auxiliary input. Both quantities are uncomputable in general.

Kolmogorov complexity has deep connections to prediction, compression, and intelligence. Solomonoff showed that optimal sequence prediction corresponds to Bayesian mixture over programs weighted by `2^(-K)`. Hutter's universal intelligence conjecture posits that any sufficiently general agent implements something like Solomonoff induction. Delétang et al. 2023 empirically confirmed a key prediction: Chinchilla, a large language model trained for prediction, compresses ImageNet patches better than PNG. Language models *are* compressors, because the two problems are equivalent under arithmetic coding.

### What Kolmogorov misses

The Random Encyclopedia Problem: 3000 pages of uniformly random letters have higher `K` than a 3000-page encyclopedia, yet the encyclopedia is vastly more useful. Random strings are maximally Kolmogorov-complex (no shorter description exists) and semantically empty.

The gap is this: `K(x)` measures generative complexity, the difficulty of producing `x`. Semantic analysis asks a different question: how much of `x` is doing irreducible work toward a purpose? Random noise is hard to produce and does no work. A cliché is easy to produce and also does no work. Useful text occupies a middle region that Kolmogorov complexity cannot locate, because "useful" is not a property of the string.

Several attempts have been made to bridge this gap. Koppel's *sophistication*, Bennett's *logical depth*, Vereshchagin and Vitányi's *structure function*, Cilibrasi and Vitányi's *Normalized Compression Distance*. All distinguish structured from random information, but structure is not meaning. The root cause: Kolmogorov complexity is defined for strings, not for what strings *do*. To close the gap, we need a notion of complexity relative to purpose.

---

## Part II: The Telos Turn

### The interpretation problem

Kolmogorov complexity is defined for strings. Meaning is not a string. The obvious move, define an equivalence class of strings with the same meaning and take the minimum, pushes the problem around rather than solving it: we have replaced "which `K`" with "which equivalence class."

### The telos resolution

The framework sidesteps the general interpretation problem by binding meaning to purpose:

```
K_τ(d, t) = min{K(x) : achieves(x, t)}
```

The telos-relative complexity of document `d` for task `t` is the length of the shortest document that accomplishes `t`. Two features make it useful.

**It is operationally tractable.** The relation `achieves(x, t)` can be operationalized via task performance, embedding similarity, human judgment, or downstream action success. Each operationalization is adequate for a class of texts and a class of tasks. The practitioner chooses one and states it: not a weakness, but the honest acknowledgment that semantic compression is relative to what one is trying to do.

**It makes the relativity explicit.** Different `t` yields different `K_τ` for the same `d`. A 5,000-word essay may be bloated for "summarize the thesis" and lean for "teach this to someone who has never encountered it." The text is not more or less dense; the question is. ISDA without a stated telos compresses toward an undefined target.

### Telos-weighted decomposition

`K_τ` distributes across the seven strata with telos-dependent weights:

```
K_τ(d, t) ≈ Σᵢ wᵢ(t) · Sᵢ(d)
```

with `Σᵢ wᵢ(t) = 1`. Under unspecified telos, weights are uniform. Under specific telos, the weights shift toward the strata that carry the telos-relevant work:

| Telos | Dominant strata |
|---|---|
| Persuade | Rhetorica, Musica, Astronomia |
| Teach | Geometria, Dialectica, Arithmetica |
| Prove | Dialectica, Arithmetica, Grammatica |
| Inspire | Musica, Rhetorica (Inventio-canon), Astronomia |
| Catalog | Arithmetica, Geometria |
| Move emotionally | Musica, Astronomia, Rhetorica |

This is closer to how editors actually think about cuts. A 5,000-word essay under "persuade" weighting cuts Arithmetica and Grammatica first; the same essay under "prove" weighting cuts Rhetorica and Musica first.

### Audience relativity

Semantic complexity also varies by reader: `K_τ(d, t, reader) = min{K(x) : achieves_for(x, t, reader)}`. A technical proof is near-zero `K_τ` for a specialist and enormous for a novice. The reader's knowledge state is part of the problem specification, handled via the substrate parameter at every stratum.

---

## Part III: The Nicomachan-Boethian 2x2

The structural spine of the framework is a classical 2x2 classification of the mathematical arts. Unlike most pedagogical frameworks built on historical vocabulary, this one is load-bearing in the primary sources, not a modern retrofit.

### The primary source: Nicomachus of Gerasa

Nicomachus's *Introduction to Arithmetic* I.2-3 (c. 100 CE) presents the classification explicitly:

> *"Of quantity, one kind is viewed by itself, having no relation to anything else, as 'even,' 'odd,' 'perfect,' and the like, and the other is relative to something else and is conceived of together with its relationship to another thing, like 'double,' 'greater,' 'smaller,' 'half.' ... The study of absolute quantity is arithmetic; that of relative quantity is music; that of size without motion is geometry; and that of size with motion is astronomy."*
>
> Nicomachus I.3 (D'Ooge trans. 1926)

Four mathematical sciences, four cells, one classification. This is the text Boethius translates into Latin four hundred years later.

### Transmission: Boethius

Boethius's *De Institutione Arithmetica* I.1 (c. 500 CE) transmits the Nicomachan classification verbatim as *multitudo per se* (arithmetic), *multitudo ad aliud* (music), *magnitudo immobilis* (geometry), *magnitudo mobilis* (astronomy). Boethius's own characterization: the four mathematical sciences arise *ex ipsa quantitatis natura* (from the very nature of quantity). The division is structural, not pedagogical convenience. The Latin vocabulary passes into the medieval tradition unchanged and becomes the standard classification for 800 years.

### Independent attestation: Proclus

Proclus independently attributes the same structure to the Pythagoreans in his *Commentary on the First Book of Euclid's Elements* (5th c.):

> *"The Pythagoreans considered all mathematical science to be divided into four parts: one half they marked off as concerned with quantity, the other half with magnitude; and each of these they posited as twofold. A quantity can be considered in regard to its character by itself or in its relation to another quantity; magnitudes as either stationary or in motion."*
>
> Proclus (Morrow trans. 1970)

Two transmission lines (Nicomachus through Boethius; Proclus through Greek commentators) carry the same classification. The 2x2 is the common property of the Pythagorean-Platonic mathematical tradition, not any one author's schema.

### The classification

|  | at rest | in motion |
|---|---|---|
| **discrete** | Arithmetica (*number in itself*) | Musica (*number in proportion*) |
| **continuous** | Geometria (*magnitude immobile*) | Astronomia (*magnitude mobile*) |

### Ontological note on rest and motion

The rest-and-motion axis is not kinematic. In the classical scheme:

- "At rest" means the *object studied* does not require time in its definition (arithmetic studies numbers as finished sets; geometry studies shapes whose definitions are timeless).
- "In motion" means the *object studied* has temporal or sequential structure as an essential property (music studies proportions that unfold through time; astronomy studies regular periodic motion of celestial bodies).

Applied to text analysis, "in motion" means the measured property is temporal or sequential. In prose, the reader's traversal through the text is its "motion": reading-time is the text's temporal dimension. Musica measures rhythm at local scale (syllable, word, clause); Astronomia measures trajectory at global scale (document). Both are "in motion" in the sense the classical tradition meant.

### Applied to text analysis

The four quadrivium strata apply cleanly:

| Cell | Classical sense | Text analog |
|---|---|---|
| Arithmetica (discrete at rest) | number in itself | propositional density: the count of atomic claims the text asserts |
| Geometria (continuous at rest) | magnitude immobile | document architecture: static layout, hierarchy, spatial structure |
| Musica (discrete in motion) | number in proportion | local prosodic rhythm: meter, cadence, rhetorical figures at clause or sentence scale |
| Astronomia (continuous in motion) | magnitude mobile | global trajectory: the arc of information intensity over document position |

All four fits are honest. Read the tradition carefully, and Arithmetica and Astronomia fit their text-analysis roles exactly.

---

## Part IV: The Seven Strata as Conditional Complexity

The seven strata combine the trivium (three verbal arts) with the quadrivium 2x2 (four mathematical arts). Each stratum is a conditional Kolmogorov complexity against progressively richer context.

### Trivium: form axis (arts of the word)

| # | Stratum | Measure |
|---|---|---|
| 1 | **Grammatica** | `K(sentence-forms(d) | G_grammar)` |
| 2 | **Dialectica** | `K(claims(d) | Closure(KB, R))` |
| 3 | **Rhetorica** | `H(decisions(d) | Δ)` |

**Grammatica** captures sentence-level syntactic form conditioned on genre conventions. Compound coinages, unusual syntactic patterns, periodic or loose construction, register choice. A medieval scope shrinkage applies: we narrow *grammatica* from the Donatus-era broad sense (phonology plus morphology plus syntax plus figures of speech plus poetics plus literary-ethical criticism) to sentence-level form only. Figures of speech go to Musica; poetics distributes across Musica, Geometria, and Rhetorica.

**Dialectica** captures derived inference. Claims in the deductive closure of substrate plus rules have zero marginal complexity; claims outside the closure are the text's inferential contribution. Hugh of St. Victor: *"dialectic is clear-sighted argument which separates the true from the false."* The fit is exact.

**Rhetorica** captures curatorial decisions: selection, ordering, framing, emphasis. The five canons of classical rhetoric (*inventio, dispositio, elocutio, memoria, pronuntiatio*) live as internal sub-stratification when Rhetorica dominates. "Memoria" in the reader-side sense (what the reader already holds) is handled by the substrate parameter that conditions every stratum.

### Quadrivium: substance axis (arts of number), via the 2x2

| # | Stratum | Sense | Measure |
|---|---|---|---|
| 4 | **Arithmetica** | discrete at rest | `|propositions(d)|` via CPIDR |
| 5 | **Geometria** | continuous at rest | `K(architecture(d) | G_geometry)` |
| 6 | **Musica** | discrete in motion | `K(prosody(d) | Π_local)`, local UID |
| 7 | **Astronomia** | continuous in motion | `K(trajectory(d) | Τ_global)`, global UID |

### The form-and-substance distinction

The trivium strata describe how content is shaped (form). The quadrivium strata describe what dimensions of substance the content occupies. They are not orthogonal axes in the linear-algebraic sense. Each stratum is a conditional complexity over a different aspect of `d`, with different contexts held fixed. A more honest framing: the two groupings are *projections* of the same document from different sides. The trivium projects onto form; the quadrivium projects onto substance. Both projections cover the whole text; neither is redundant with the other.

The sum-of-strata approximation `K(d) ≈ Σᵢ Sᵢ(d)` holds approximately, with cross-stratum interactions absorbed as `O(1)` error terms. The decomposition is approximate, not exact, and the framework acknowledges this directly rather than claiming formal orthogonality.

---

## Part V: UID at Dual Scales: Musica and Astronomia Unified

The framework has a single theoretical backbone for both "in motion" strata: Uniform Information Density (UID) tested at local and global scales. The quadrivium's classical distinction within the "in motion" half maps onto the modern UID literature's scale distinction, a convergence that was not designed but emerges from reading both traditions carefully.

### Local-scale UID (Musica)

At the local scale, UID claims that fluent speakers distribute information approximately uniformly over time: local information content and local prosodic or syllabic duration are inversely related. Where a word is highly predictable, it gets less duration; where a word is surprising, it gets more duration. The product, local surprisal times local duration, is approximately constant. A measurable hypothesis with twenty years of empirical literature.

**Grounding.** Aylett and Turk 2004 ("Smooth Signal Redundancy"), Levy and Jaeger 2007 ("Speakers optimize information density through syntactic reduction"), Genzel and Charniak 2002. The formal measure:

```
Musica(d, Π_local) = K(prosody(d) | Π_local)
```

where `prosody(d)` is a time-series of phonological or structural features (stress, duration, sentence length, rhetorical-figure density) and `Π_local` is a genre-conditional distribution over local rhythmic patterns: the UID-smooth baseline.

**Humanistic provenance.** Cicero's *De Oratore* 3.173-198 and Quintilian's *Institutio Oratoria* books 5 and 9 provide the two-thousand-year tradition of formal prose-rhythm measurement via cursus and clausulae. Modern digital tools (Spinazzè et al. 2015 DL4Rhetoric; Cambridge Auceps syllabarum; CLTK Latin clausulae module) implement the classical scansion system on Latin corpora.

**Label warrant.** Augustine's *De Musica* I.iv.5 defines musica as *scientia bene modulandi*: the science of well-measured movement. The prosodic sense, distinct from the Boethian ratio-theoretic sense. Choosing "Musica" as the stratum name honors Augustine's reading; the Boethian sense is acknowledged as an alternative interpretive branch.

### Global-scale UID (Astronomia)

At the global scale, UID claims the same thing at document granularity: fluent authors distribute information approximately uniformly over document position. Where a position is highly predictable given what has come before, the text moves through it quickly. Where a position introduces unexpected content, the text dwells, expands, or marks it structurally. The trajectory of information intensity over the document's span is the analog of the prosodic profile at the sentence level.

**Grounding.** Wilmot and Keller 2020 ("Modelling Suspense as Uncertainty Reduction over Neural Representation," ACL) is the direct formal analog. A per-sentence time-series of surprise (backward-looking KL divergence) and uncertainty reduction (forward-looking KL divergence), computed via a hierarchical neural reader model, validated against human suspense annotations with near-human accuracy. The measurement instrument for document-scale information flow.

Schulz, Patrício, and Odijk 2024 ("Narrative Information Theory," NeurIPS Workshop) builds a full four-quantity decomposition: state-entropy for complexity, Jensen-Shannon divergence for pivots, entropy over predicted next states for suspense, JSD(predicted || realized) for plot twists. Astronomia worked out in discrete-state form.

Reagan et al. 2016 ("The emotional arcs of stories are dominated by six basic shapes," *EPJ Data Science*) is the empirical landmark: 1,327 fiction texts, sentiment analysis over text position, six canonical emotional arc shapes identified via SVD. Fudolig et al. 2023 provides the methodological precedent for EMD decomposition of text-position time-series.

The formal measure:

```
Astronomia(d, Τ_global) = K(trajectory(d) | Τ_global)
```

where `trajectory(d)` is a time-series of information intensity over document position and `Τ_global` is a genre-conditional trajectory-expectation distribution.

### The unification

Both `K(prosody(d) | Π_local)` and `K(trajectory(d) | Τ_global)` are instances of the same pattern: conditional Kolmogorov complexity of an information-flow profile against a genre-conditional UID null. The difference is the scale at which the profile is sampled.

- Local (Musica): per-syllable, per-word, per-clause, per-sentence. Captures prose rhythm, meter, rhetorical figures.
- Global (Astronomia): per-section, per-chapter, per-percentile of document length. Captures argumentative arc, narrative structure, suspense trajectory.

A text conforming perfectly to genre expectations at both scales is rhythmically flat and trajectory-flat. A text violating UID at local scale has high Musica (Hopkins). A text violating UID at global scale has high Astronomia (unconventional pacing). The two can vary independently.

The classical quadrivium saw this scale distinction within the "in motion" half two millennia before the information theorists rediscovered it. *Musica = number in proportion at local ratio scale; astronomia = magnitude in motion at cosmic scale.* Same phenomenon, different scales. The framework names this convergence explicitly.

### Contribution in Astronomia

Astronomia-as-trajectory is not a novel concept. It is a synthesis of prior art under a classical frame. The originality claim is modest and honest: the framework requires the genre-conditional prior `Τ_global` explicitly, analogous to how Memoria-as-substrate requires a named KB for retrievability. Wilmot and Keller train on unlabeled short stories; Schulz et al. let genres "emerge" rather than conditioning on them. Making the prior explicit is the architectural contribution; the measurement instrument itself is inherited from the literature.

---

## Part VI: The Intensity Ladder

The framework uses a four-level intensity gradient that applies per-stratum:

| Level | Name | Meaning | Conditioning |
|---|---|---|---|
| 1 | **Stock** | already in the named substrate | `K(·|KB)` is small |
| 2 | **Implied** | in the deductive closure of substrate plus rules | `K(·|Closure(KB, R))` is small |
| 3 | **Selected** | chosen from a visible option space | `H(·|Δ)` captures the choice |
| 4 | **Original** | irreducible against full context | `K(·|C) ≥ |·|`, algorithmic randomness |

### Why orthogonal to stratum

Novelty is not a specific kind of content; it is a property any kind of content can have. A text can have Original Grammatica (Hemingway's declaratives against Victorian periods), Original Dialectica (Gödel's diagonal argument), Original Musica (Hopkins's sprung rhythm), Original Astronomia (Borges's "Garden of Forking Paths"), Original Geometria (concrete poetry), Original Rhetorica (Sebald's indirection).

A framework that collapsed all of these into "high novelty" would miss the point. Each stratum has its own novelty axis, and the analysis reports which dimension the originality lives in. Seven times more expressive than the flat version, and matches how editors actually think. "The argument is standard but the structure is innovative" is a statement the flat version could only express with hand-waving.

### Why per-stratum dominant, not full matrix

A naive implementation would cross-tabulate: seven strata times four intensity levels equals 28 cells, a full stratum-intensity matrix per analysis. This fails on four grounds.

First: reliability compounds multiplicatively. Stratum-boundary disagreement times intensity-boundary disagreement produces 21+ joint decision points per analysis. Multi-dimensional human-coded text frameworks historically struggle with compounding disagreement (Biber MDA in hand-coded form; Coh-Metrix validation challenges).

Second: empirical cell collapse. At least six of 28 cells are empirically empty for most texts. Arithmetica-Selected (propositional count is not a selection), Arithmetica-Original (originated propositions belong in Dialectica or Inventio-canon), Astronomia-Stock (a fully predictable trajectory is not "in" the text), Geometria-Original (vanishingly rare outside concrete poetry), Musica-Original outside poetic innovation, Grammatica-Selected collapses into Rhetorica-Selected.

Third: working-memory overflow. A seven-vector is scannable; a 28-cell matrix with sparse entries is not.

Fourth: clean progression. The Stock-Implied-Selected-Original ladder reads as a creative path. The text moves from what is already stocked, through what is implied by the stock, through what is selected from available options, to what is originated anew.

**The solution:** each stratum gets one dominant intensity tag, yielding a seven-row output table. Verbosity increase is modest. The intensity insight is preserved; the matrix overhead is rejected.

---

## Part VII: Prior Art and Positioning

The framework sits in an active research program. It does not claim originality everywhere; it claims originality at the architectural level: composition of existing measurements under a classical frame with explicit telos-weighting and substrate conditioning.

### Multi-dimensional text analysis

**Coh-Metrix (Graesser, McNamara et al. 2004, 2011)** is the closest living ancestor of multi-stratum text analysis. Factor analysis over 37,520 texts yielded 8 dimensions (reported as 5 major factors: narrativity, syntactic simplicity, word concreteness, referential cohesion, deep cohesion). Coh-Metrix is reader-facing and empirically factor-analyzed; this framework is telos-relative and architecturally derived. Coh-Metrix identifies dimensions empirically; the framework here commits to dimensions a priori based on a classical taxonomy and shows that prior-art measurements at each stratum ground the commitment.

**Biber's Multi-Dimensional Analysis (1988)** is the canonical precedent for multi-dimensional text decomposition. Factor analysis over 67 linguistic features across 481 British English texts, yielding 6-7 register-functional dimensions (Involved or Informational, Narrative or Non-Narrative, Explicit or Situation-Dependent, Overt Persuasion, Abstract or Non-Abstract). Biber validates the multi-dimensional move with register-functional rather than compression-theoretic or classical-art axes.

**Halliday and Ure's lexical density (Ure 1971; Halliday 1985)** measures the lexical-item ratio per clause. Orthogonal to this framework. A useful feature at the Grammatica stratum, not a competing framework.

### Compression-based text analysis

**Normalized Compression Distance (Cilibrasi and Vitányi 2005)** is the Kolmogorov-derived similarity measure that the theoretical anchor lives near. NCD uses real compressors to estimate `K(x|y)`; the per-stratum `K(·|·)` formalisms are the same move at per-stratum granularity. The empirical precedent showing compression-based text analysis is tractable despite `K` being uncomputable.

**Delétang et al. 2023 ("Language Modeling Is Compression")** empirically confirmed the Solomonoff-Hutter prediction: Chinchilla compresses ImageNet patches better than PNG. Language models *are* compressors. This grounds the theoretical framework in recent empirical work.

**Prediction by Partial Matching (Cleary and Witten 1984)** is the forty-year-old deterministic ancestor, a classical compressor in which the suffix index *is* the predictor. The limit case of kNN-LM with an exact-match index recovers PPM with linguistic keys.

### Propositional density

**Kintsch 1974, Kintsch and van Dijk 1978** provide the theoretical foundation for propositional analysis (decomposing text into atomic predicate-argument records). The canonical text-base model for comprehension research.

**CPIDR (Brown, Snodgrass, Covington, Herman, Kemper 2008)** approximates Kintsch-Turner-Greene propositional counting from POS tags plus ~40 adjustment rules. Agreement with human consensus: r = 0.97, exceeding the human-to-human baseline of r = 0.82. CPIDR is open-source, deterministic, production-validated across the Snowdon nun studies (longitudinal Alzheimer prediction), Coh-Metrix, clinical linguistics, and aphasia research. The framework uses CPIDR as the operational definition for Arithmetica.

### Uniform Information Density

**Aylett and Turk 2004, Levy and Jaeger 2007** ground Musica at local scale. Twenty years of empirical literature validating the inverse relationship between local information content and prosodic duration.

**Wilmot and Keller 2020 ("Modelling Suspense as Uncertainty Reduction over Neural Representation," ACL)** is the direct global-scale analog. Per-sentence surprise and uncertainty-reduction time-series from a hierarchical neural reader model, validated against human suspense annotations.

**Schulz, Patrício, and Odijk 2024 ("Narrative Information Theory," NeurIPS Workshop)** builds the full information-theoretic framework for narratives. Four named quantities (complexity, pivots, suspense, plot twists). Discrete-state formulation.

**Reagan et al. 2016 ("The emotional arcs of stories," *EPJ Data Science*)** is the empirical landmark: 1,327 texts, six canonical shapes. Vonnegut-inspired, SVD-validated.

**Fudolig et al. 2023:** ousiometric (power and danger) time-series decomposed via empirical mode decomposition. Methodological precedent for decomposing trajectory signals.

### Classical rhetoric and prose rhythm

**Cicero, *De Oratore* 3.173-198 and *Orator* 204-226:** on cursus and clausulae, the classical formalization of prose rhythm via metrical patterns.

**Quintilian, *Institutio Oratoria* books 5 and 9:** detailed treatment of prose rhythm in forensic and epideictic rhetoric, including the five canons framework for rhetorical production.

**Augustine, *De Musica* I.iv.5:** *musica est scientia bene modulandi*, "music is the science of well-measured movement." The prosodic sense of musica that the framework adopts over the Boethian ratio-theoretic sense.

### Humanistic decomposition

**Roland Barthes, *S/Z* (1970)** is the five-code decomposition of Balzac's *Sarrasine* (hermeneutic, proairetic, semantic, symbolic, cultural). The closest humanistic precedent for decomposing a text into irreducible semantic strata. Barthes is interpretive and non-quantitative; this framework is trying to be both. The instinct that texts decompose into a small number of irreducible strata is not new; Barthes reached it interpretively. This framework adds telos-relativity, compression-theoretic grounding, and the classical taxonomic frame.

### Classical liberal arts revival

**Sister Miriam Joseph, *The Trivium* (1937/2002)** maps the three verbal arts onto thought, expression, communication as a pedagogical philosophy. Joseph does not extend to the quadrivium and does not treat her mapping as a formal text-analysis framework. She provides vocabulary, not method.

**Dorothy Sayers, "The Lost Tools of Learning" (1947)** is the classical Christian education revival manifesto. Same pedagogical rather than analytical framing.

The classical liberal arts vocabulary has been kept alive through this revival tradition; the structural 2x2 application to text analysis is where this framework's synthesis lives.

### Positioning

The trivium-and-quadrivium vocabulary is not novel (Sister Miriam Joseph, Sayers, the classical Christian education movement). The compression-theoretic text analysis approach is not novel (Cilibrasi-Vitányi NCD, Delétang 2023). Multi-dimensional text decomposition is not novel (Biber, Coh-Metrix). UID-based rhythm and trajectory measurement is not novel (Aylett-Turk, Wilmot-Keller, Schulz). Propositional density is not novel (Kintsch, CPIDR).

What is novel is the composition. Seven conditional-complexity strata organized via the Nicomachan-Boethian 2x2, each with an explicit intensity tag drawn from a unified four-level ladder, each conditioned on a named substrate, aggregated under telos-dependent weights, with Musica and Astronomia unified as UID at dual scales. The pieces exist in the prior literature; the architecture is the contribution.

---

## Part VIII: The LLM-as-Decompressor Hypothesis

Large language models perform semantic decompression: they expand compressed representations (prompts) into full outputs (responses). The mapping is direct.

| Component | Role |
|-----------|------|
| Training data | Shared codebook, implicit `KB` |
| Prompt | Compressed specification |
| Output | Decompressed execution |
| Context window | Decompression workspace |

Under this hypothesis:

1. **Prompt engineering is compression optimization.** Finding minimal prompts that expand to desired outputs is equivalent to finding `K_τ(prompt, desired_output)`.
2. **In-context learning is substrate extension.** Examples in the prompt temporarily extend the implicit `KB`.
3. **Pretraining is codebook construction.** The training process builds the shared semantic codebook from corpus statistics.
4. **Fine-tuning is codebook specialization.** Adjusting the implicit `KB` for specific domains.

### Evidence

**Prediction-and-compression equivalence.** Arithmetic coding makes any predictor into a compressor and vice versa. Delétang et al. 2023 confirmed this empirically: LLMs trained purely as predictors compress ImageNet and audio better than specialized codecs.

**Retrieval-as-parameters tradeoff.** RETRO (Borgeaud et al. 2022) and kNN-LM (Khandelwal et al. 2020) show that retrieval can substitute for parametric learning. Direct evidence that LLMs already implement something like `K(x | KB)` internally.

**Prompt compression literature.** LLMLingua (Jiang et al. 2023) achieves 20x prompt compression with minimal task-performance loss. The compressible portion is the Stock and Implied content against the model's training distribution; the irreducible portion is the user's task-specific Original content.

### Per-stratum decomposition of the hypothesis

Under this framework, the LLM-as-decompressor hypothesis decomposes. The LLM compresses and decompresses each stratum differently. Grammatica is highly compressible against training-distribution syntactic conventions. Dialectica is compressible against the model's implicit inference rules. Rhetorica is partially compressible via the model's learned rhetorical patterns. Arithmetica is direct: propositions either compress or they do not. Geometria is compressible against document-format templates. Musica and Astronomia are the hardest; they require the model to learn UID expectations at dual scales, and state-of-the-art models remain weak here.

A conjecture: a model's ability to compress a text at a given stratum is a measure of that stratum's prior-presence in the model's training. Strata where a model compresses well are where the model has absorbed the relevant conventions. Strata where it compresses poorly are where the model has a blind spot. Per-stratum measurement could serve as a diagnostic for model training coverage.

---

## Part IX: Open Questions

### Computability

`K` and `K_τ` are uncomputable. Is `K_τ` any more tractable than `K`? Conjecture: at least as hard, but LLMs provide practical approximations because they *are* empirical semantic compressors. An LLM's ability to rewrite a text at a shorter length while preserving task performance is a noisy estimator of `K_τ`.

### The achieves relation

How do we formally specify `achieves(x, t)`? Options: task-benchmark performance, embedding similarity, human judgment, downstream action success. A cleaner formulation might come from a *telos-specification language* that represents tasks as axiom sets. Compression becomes the problem of finding minimal axiom sets that suffice for task completion.

### Cross-stratum interactions

The seven-stratum decomposition assumes approximate separability, but:

- Original claims (Dialectica-Original) can retroactively change what is Stock (Arithmetica) once published and indexed.
- Curatorial choices (Rhetorica) can make inferences non-obvious (Dialectica).
- Structural choices (Geometria) can carry semantic weight beyond convention.
- Musica choices can make certain claims hard to state without their rhythmic form.

A more rigorous treatment would model stratum interactions as a Bayesian network. The current framework treats the decomposition as approximate and useful, not exact.

### `Τ_global` specification

Wilmot and Keller 2020 train a hierarchical neural reader model on unlabeled short stories. Schulz et al. 2024 let genres "emerge" rather than conditioning explicitly. The framework here requires an explicit genre-conditional prior, but ships with a placeholder ("genre-conditional UID null" at global scale) rather than trained reader models. A further research program would provide per-genre trained readers.

### CPIDR language coverage

CPIDR's POS-tag adjustment rules are English-specific. Hebrew, Greek, Latin, and other languages require either a language-independent proxy or per-language CPIDR adaptation.

### Discrete-state versus continuous-signal Astronomia

Schulz et al. discrete-state formulation is more interpretable (named quantities: complexity, pivots, suspense, plot twists). Wilmot-Keller continuous-signal formulation is more information-dense. The framework defaults to continuous-signal for primary reporting; discrete-state is available as a secondary view.

### Phase transitions

A recent paper (arXiv 2503.00612) identifies phase transitions in semantic compression: a first-order transition between lossless and lossy regimes, and a continuous crossover between extractive and abstractive within the lossy phase. Mapping to the stratum profile:

- Lossless regime → all-Stock profile
- Lossy extractive → Selected-dominant
- Lossy abstractive → Original-dominant

If this mapping holds, the phase boundaries are predictable from embedding dimension, message length, and semantic distance metric. Worth investigating.

---

## Part X: Formal Definitions (Summary)

```
K(x)                = min{|p| : U(p) = x}                            (Kolmogorov)
K(x | y)            = min{|p| : U(p, y) = x}                         (conditional)
K_τ(d, t)           = min{K(x) : achieves(x, t)}                     (telos-relative)
K_τ(d, t)           ≈ Σᵢ wᵢ(t) · Sᵢ(d)                              (telos-weighted)

Grammatica(d, G_g)  = K(sentence-forms(d) | G_grammar)
Dialectica(d,KB,R)  = K(claims(d) | Closure(KB, R))
Rhetorica(d, Δ)     = H(decisions(d) | Δ)       (internal 5-canon substructure)
Arithmetica(d)      = |propositions(d)|         (via CPIDR, Brown et al. 2008)
Geometria(d, G_G)   = K(architecture(d) | G_geometry)
Musica(d, Π_l)      = K(prosody(d) | Π_local)    (local UID)
Astronomia(d, Τ_g)  = K(trajectory(d) | Τ_global) (global UID)

Stock           : K(Sᵢ | KB) small
Implied         : K(Sᵢ | Closure(KB, R)) small
Selected        : H(Sᵢ | Δᵢ) captures the choice
Original        : K(Sᵢ | C) ≥ |Sᵢ| - O(1)

SCR(d, t)           = |d| / K_τ(d, t)
ND(d, C)            = Σᵢ intensity_weight(Sᵢ) · |Sᵢ| / Σᵢ |Sᵢ|
RI(d, KB, R)        = Σᵢ retrievable_weight(Sᵢ) · |Sᵢ| / Σᵢ |Sᵢ|
fidelity(x, d, t)   = 1 - semantic_distance(x, d) under task t
```

---

## Conclusion

Semantic compression is not an extension of Kolmogorov complexity. It is a different question. The Kolmogorov question asks how hard a string is to produce. The semantic question asks how much of a text is doing irreducible work toward a purpose. The first is syntactic and answers "how patterned?"; the second is telos-relative and answers "how much of this is *for*?"

The framework makes five moves. First, it replaces `K(x)` with telos-weighted `K_τ(d, t) ≈ Σᵢ wᵢ(t) · Sᵢ(d)`. Second, it decomposes across seven strata organized via the Nicomachan-Boethian 2x2: three trivium strata (Grammatica, Dialectica, Rhetorica) for form and four quadrivium strata (Arithmetica, Geometria, Musica, Astronomia) for substance. Third, it introduces a per-stratum intensity ladder (Stock, Implied, Selected, Original) so novelty can be reported at whichever stratum it lives. Fourth, it unifies Musica and Astronomia as Uniform Information Density tested at dual scales, a single theoretical backbone instantiated locally (prosody) and globally (trajectory). Fifth, it makes the retrieval substrate and the genre-conditional priors explicit as parameters at every stratum, not implicit as assumptions.

The deepest claim is that the **Original** level of the intensity ladder, content algorithmically random relative to all available context at a specific stratum, is what justifies a text's existence at that stratum. A text with zero Original tags across all seven strata is a compilation, not a contribution. But Original is per-stratum, not global. A good encyclopedia entry is all-Stock (that is its telos). A lyric poem is Musica-Original. An argumentative essay with something new to say is Dialectica-Original. A research paper is Dialectica-Original with Geometria-Selected. A literary innovation like Hopkins or Borges is Original at the stratum of the innovation. The framework's job is to report *where* the Original lives, not just whether any exists.

The framework is exploratory. The formal definitions are proposals, not established theorems. The classical tradition is used honestly: Nicomachus through Boethius, Cicero through Quintilian, Augustine for the Musica label warrant. Not decorative vocabulary. Where the formalism is tight, trust it. Where it is loose, trust your judgment. The goal is not to eliminate judgment but to give it something sharp to rest on.

---

## References

### Kolmogorov complexity and information theory

- **Kolmogorov, A. N.** (1965). "Three approaches to the quantitative definition of information." *Problems of Information Transmission*.
- **Solomonoff, R.** (1964). "A formal theory of inductive inference." *Information and Control*.
- **Hutter, M.** (2005). *Universal Artificial Intelligence*. Springer.
- **Shannon, C. E.** (1948). "A mathematical theory of communication." *Bell System Technical Journal*.
- **Cleary, J. G. and Witten, I. H.** (1984). "Data compression using adaptive coding and partial string matching." *IEEE Transactions on Communications*.
- **Cilibrasi, R. and Vitányi, P.** (2005). "Clustering by compression." *IEEE Transactions on Information Theory*.
- **Delétang, G. et al.** (2023). "Language modeling is compression." arXiv:2309.10668.
- **Khandelwal, U. et al.** (2020). "Generalization through memorization: Nearest neighbor language models." arXiv:1911.00172.
- **Borgeaud, S. et al.** (2022). "Improving language models by retrieving from trillions of tokens." arXiv:2112.04426.
- **Jiang, H. et al.** (2023). "LLMLingua: Compressing prompts for accelerated inference." *EMNLP*.
- **Tishby, N., Pereira, F. C., and Bialek, W.** (2000). "The information bottleneck method." arXiv:physics/0004057.

### Multi-dimensional text analysis

- **Graesser, A., McNamara, D. S., Louwerse, M., Cai, Z.** (2004). "Coh-Metrix: Analysis of text on cohesion and language." *Behavior Research Methods, Instruments, & Computers*.
- **McNamara, D. S., Graesser, A., McCarthy, P. M., Cai, Z.** (2014). *Automated Evaluation of Text and Discourse with Coh-Metrix*. Cambridge.
- **Biber, D.** (1988). *Variation Across Speech and Writing*. Cambridge.
- **Halliday, M. A. K.** (1985). *Spoken and Written Language*. Oxford.
- **Ure, J.** (1971). "Lexical density and register differentiation."

### Propositional density

- **Kintsch, W.** (1974). *The Representation of Meaning in Memory*.
- **Kintsch, W. and van Dijk, T.** (1978). "Toward a model of text comprehension and production." *Psychological Review* 85(5).
- **Turner, A. and Greene, E.** (1977). "The construction of a propositional text base." Institute for the Study of Intellectual Behavior, Tech Report 63.
- **Brown, C., Snodgrass, T., Kemper, S. J., Herman, R. E., Covington, M. A.** (2008). "Automatic measurement of propositional idea density from part-of-speech tagging." *Behavior Research Methods* 40(2). (**CPIDR**)
- **Snowdon, D. A. et al.** (1996). "Linguistic ability in early life and cognitive function and Alzheimer's disease in late life." *JAMA*. (Nun Study)

### Uniform Information Density and prose rhythm

- **Aylett, M. and Turk, A.** (2004). "The smooth signal redundancy hypothesis." *Language and Speech* 47(1).
- **Levy, R. and Jaeger, T. F.** (2007). "Speakers optimize information density through syntactic reduction." *NIPS*.
- **Genzel, D. and Charniak, E.** (2002). "Entropy rate constancy in text." *ACL*.
- **Cicero** (c. 55 BCE). *De Oratore* 3.173-198.
- **Cicero** (46 BCE). *Orator* 204-226.
- **Quintilian** (c. 95 CE). *Institutio Oratoria*, books 5 and 9.
- **Augustine** (387-389 CE). *De Musica*, I.iv.5.
- **Spinazzè, L. et al.** (2015). "Cursus in clausula: an online digital tool for analyzing Latin prose rhythm." *Digital Humanities* conference proceedings.

### Narrative and argumentative trajectory

- **Wilmot, D. and Keller, F.** (2020). "Modelling suspense in short stories as uncertainty reduction over neural representation." *ACL*.
- **Schulz, P., Patrício, C. and Odijk, J.** (2024). "Narrative information theory." *NeurIPS Workshop on Narratology*, arXiv:2411.12907.
- **Reagan, A. J. et al.** (2016). "The emotional arcs of stories are dominated by six basic shapes." *EPJ Data Science*, arXiv:1606.07772.
- **Fudolig, M. I., Alshaabi, T., Cramer, K., Danforth, C. M., Dodds, P. S.** (2023). "A decomposition of book structure through ousiometric fluctuations in cumulative word-time." *Humanities and Social Sciences Communications*, arXiv:2208.09496.
- **Kim, N. W., Bach, B. et al.** (2018). "Visualizing nonlinear narratives with story curves." *IEEE TVCG*.
- **Mann, W. C. and Thompson, S. A.** (1988). "Rhetorical Structure Theory." *Text*.
- **Labov, W.** (1972). "The transformation of experience in narrative syntax." In *Language in the Inner City*.

### Classical mathematical and liberal-arts tradition

- **Nicomachus of Gerasa** (c. 100 CE). *Introduction to Arithmetic* (D'Ooge trans. 1926, Macmillan).
- **Boethius** (c. 500 CE). *De Institutione Arithmetica* (Masi trans. 1983, *Boethian Number Theory*, Rodopi).
- **Boethius** (c. 500 CE). *De Institutione Musica* (Bower trans. 1989, Yale).
- **Proclus** (5th c.). *Commentary on the First Book of Euclid's Elements* (Morrow trans. 1970, Princeton).
- **Isidore of Seville** (c. 630 CE). *Etymologiae*, books I-III.
- **Hugh of St. Victor** (c. 1125 CE). *Didascalicon* (Taylor trans. 1961, Columbia).
- **Augustine** (c. 397 CE). *De Doctrina Christiana*.
- **Cicero**. *De Inventione* I.7 (on *inventio* as discovery of material).
- **Sister Miriam Joseph** (1937, reissued 2002). *The Trivium: The Liberal Arts of Logic, Grammar, and Rhetoric*. Paul Dry Books.
- **Sayers, D.** (1947). "The Lost Tools of Learning."

### Humanistic decomposition

- **Barthes, R.** (1970). *S/Z*. Éditions du Seuil.

---

*This framework is a proposal for the terrain, not a closed theory. Where the formalism is tight, trust it. Where it is loose, trust your judgment. The goal is not to eliminate judgment but to give it something sharp to rest on.*
