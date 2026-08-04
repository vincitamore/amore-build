---
name: isda
description: Irreducible Semantic Density Analysis. Decomposes text into seven strata from the seven liberal arts — three Trivium (Grammatica, Dialectica, Rhetorica) plus four Quadrivium (Arithmetica, Geometria, Musica, Astronomia) organized by the Nicomachan-Boethian 2x2 — relative to a stated purpose (telos) and a named retrieval substrate. Each stratum gets a conditional-complexity measure plus a dominant intensity tag (Stock, Implied, Selected, Original). Use when asked to analyze text density, measure originality, check if something could be shorter, assess semantic compression, or plan an edit against a specific telos and substrate. SKIP for plain copyediting, grammar or style fixes, and generic shortening requests that carry no density, compression, or originality framing; SKIP for code-quality passes. NOT /simplify or /code-review (those hunt reuse, efficiency, or bugs in a diff and then edit it) — ISDA measures telos-relative semantic density across the seven strata and hands back an analysis, it does not rewrite the text.
---

# Irreducible Semantic Density Analysis

Estimate how much of a text is doing irreducible work toward its purpose. Answer three questions in sequence.

First: what is this text trying to do? The *telos*. Second: against what knowledge base is "retrievable" defined? The *substrate*. Third: given telos and substrate, across which of the seven strata does the text's work live, and at what intensity? The *stratum profile*.

All three answers must be explicit before the analysis means anything. Without a stated telos, the framework compresses toward an undefined target. Without a named substrate, it treats every fact as irreducible. Without stratum profiling, it collapses distinct kinds of textual work into a single number.

## §0 SELF-UPDATING

This skill is five coupled files: `SKILL.md`, `reference.md`, `theory.md`, `examples.md`, and `isda_preprocess.py`. The vocabulary must stay identical across all five — a term renamed in one and not the others surfaces as a contradiction at the point of use (the intensity ladder was renamed to Stock/Implied/Selected/Original in the prose but the old names lingered in the preprocessor's own output strings). Update triggers, each applied in the SAME change that makes the underlying change:

- Rename a stratum or an intensity-tag term → grep all five files for the old term and update every hit, including the preprocessor's docstring, warning strings, `--help` text, and any output notes.
- Change a formal measure, add, or remove a stratum → update the Seven Strata tables here, the per-stratum formal definitions in `reference.md`, and the treatment in `theory.md`.
- Change the preprocessor's flags or JSON output shape → update the Preprocessing Tool section's invocation line and the Provides / Does-not-provide table here. The canonical, always-current flag reference is `python .amore/skills/isda/isda_preprocess.py --help` (or `skill://isda/isda_preprocess.py`); when the prose and `--help` disagree, `--help` is ground truth and the prose is reconciled to it.
- Add a worked example → add it to `examples.md` and update the References section's example list here.

Defer a change only against a concrete trigger (a named term rename, a flag change), never a calendar bucket. The preprocessor is measurement-only and carries no dynamic state; there is no runtime surface whose values could go stale in the prose.

## Core Concept

ISDA measures telos-relative semantic complexity decomposed across seven strata. The strata come from the Septem Artes Liberales, the seven classical liberal arts, organized via the Nicomachan-Boethian 2x2 classification of discrete versus continuous quantity crossed with at-rest versus in-motion state.

Formally:

```
K_τ(d, t) ≈ Σᵢ wᵢ(t) · Sᵢ(d)
```

where `d` is a document, `t` is the stated task, `Sᵢ` is the stratum-i conditional complexity, and `wᵢ(t)` is the telos-weight for stratum `i` (weights sum to 1). Under unspecified telos the weights are uniform. Under specific telos the weights shift toward the strata that carry the telos-relevant work.

Three consequences follow. Different telos yields different answers: a 5,000-word essay may be bloated for "summarize the thesis" and lean for "teach this to a novice." Different substrates yield different answers: a sentence that looks original against the open web may be near-duplicate of content in your own knowledge base. And novelty is not a seventh stratum; it is a per-stratum intensity tag. A text can be Musica-Original (originated rhythm), Dialectica-Original (originated inference), Astronomia-Original (originated trajectory), or any combination. The intensity ladder reports *where* the origination lives.

## Preprocessing Tool

Run the preprocessor when precision matters:

```bash
python .amore/skills/isda/isda_preprocess.py <file_path> --telos "<task>" --substrate "<kb>" --pretty
```

Asset form: `skill://isda/isda_preprocess.py`. The `--telos` and `--substrate` flags are optional, strongly recommended. They get recorded in output metadata so downstream analysis carries the interpretive frame.

**Philosophy: measurement, not judgment.** The preprocessor provides hard numbers; the analyst supplies the stratum classification and intensity tags. This is ordinary evidence-tier discipline applied to text metrics — tool output is input, not verdict. Absence claims about density carry the same bar as presence claims.

| Provides (facts) | Does not provide (requires judgment) |
|------------------|--------------------------------------|
| Byte, word, sentence, paragraph counts | Stratum-level classification |
| Section detection and per-section rollups | Which intensity tag applies |
| Sentence length distribution (Musica raw feature) | Whether repetition is redundancy or rhetorical device |
| Lexical statistics (TTR, hapax) | Novelty assessment |
| Propositional density estimate (Arithmetica raw feature, CPIDR-style heuristic) | How the stratum interacts with telos |
| Candidates flagged for review | What those candidates mean |

Anchor your analysis with the hard numbers. Do not let them constrain your judgment.

## The Seven Strata

Any text decomposes into seven strata, organized into two groupings.

### Trivium: form (arts of the word)

| # | Stratum | English gloss | Formal measure |
|---|---------|---------------|----------------|
| 1 | **Grammatica** ¹ | sentence-level form | `K(sentence-forms(d) \| G_grammar)` |
| 2 | **Dialectica** | derived inference | `K(claims(d) \| Closure(KB, R))` |
| 3 | **Rhetorica** ² | curatorial decisions | `H(decisions(d) \| Δ)` |

### Quadrivium: substance (arts of number), via the Nicomachan-Boethian 2x2

| # | Stratum | English gloss | Boethian sense | Formal measure |
|---|---------|---------------|----------------|----------------|
| 4 | **Arithmetica** | propositional density | discrete at rest | `\|propositions(d)\|` via CPIDR |
| 5 | **Geometria** | document architecture | continuous at rest | `K(architecture(d) \| G_geometry)` |
| 6 | **Musica** | rhythm and prosody | discrete in motion | `K(prosody(d) \| Π_local)`, local-scale UID |
| 7 | **Astronomia** | argumentative trajectory | continuous in motion | `K(trajectory(d) \| Τ_global)`, global-scale UID |

**Note on the quadrivium 2x2.** The four quadrivium strata are the four cells of a discrete/continuous × at-rest/in-motion classification that Nicomachus of Gerasa makes explicit in *Introduction to Arithmetic* I.2-3 (c. 100 CE) and that Boethius transmits verbatim in *De Institutione Arithmetica* I.1 (c. 500 CE). See `reference.md` and `theory.md` for full historical and formal treatment.

**Note on "in motion".** The rest/motion axis is not kinematic. "At rest" means the measured property is static: a proposition count, a shape whose definition does not require time. "In motion" means the measured property is temporal. In prose, reading-time is the text's motion. Musica measures rhythm at local scale (syllable, clause, sentence); Astronomia measures trajectory at global scale (document). Both are conditional-complexity measures against a Uniform Information Density baseline. See the UID unification section in `theory.md`.

---

*¹ Grammatica footnote: we use Grammatica in the narrow sense of sentence-level form. Medieval usage (Donatus, Isidore, the broader grammatica tradition) covered phonology, morphology, figures of speech, poetics, and literary-ethical criticism, much of which we split into Musica and Rhetorica here. The shrinkage is pragmatic: we preserve the name for the familiar association and narrow its scope to make the seven strata non-overlapping.*

*² Rhetorica substructure: when Rhetorica dominates an analysis, the report can drill down to the classical five canons of rhetoric, **inventio** (discovery of material), **dispositio** (arrangement), **elocutio** (style and diction), **memoria** (the orator's mental treasury), **pronuntiatio** (delivery). These are not separate top-level strata; they are the operational stages of Rhetorica. "Memoria" in the reader-side sense, meaning what the reader already holds, is handled by the substrate parameter that conditions every stratum.*

## The Intensity Ladder

Each stratum carries a dominant intensity tag from a four-level gradient. Novelty is not a seventh stratum; it is a property any stratum can have.

| Level | Name | Meaning | Conditioning |
|---|---|---|---|
| 1 | **Stock** | already in the named substrate | `K(·\|KB)` is small, content is retrievable |
| 2 | **Implied** | in the deductive closure of substrate and inference rules | `K(·\|Closure(KB, R))` is small, content is derivable but not stated |
| 3 | **Selected** | chosen from a visible option space | `H(·\|Δ)`, curatorial decision rather than derivation |
| 4 | **Original** | irreducible against full context | `K(·\|C) ≥ \|·\|`, algorithmic randomness relative to everything |

The progression reads as a path. Stock is what you already had. Implied is what the stock implied. Selected is what you picked from options. Original is what you made from nothing the substrate held. Each stratum gets one tag per analysis, reflecting which intensity dominates.

**Reading the tag grid.** A text where every stratum reads Stock is fully conventional: a well-written textbook passage, a reference document, a standard form letter. A text where one stratum reads Original and the others vary has a specific-origin novelty: Hopkins reads Musica-Original with Dialectica at Implied. A text where multiple strata read Original is doing several kinds of irreducible work at once, which is rare.

**Per-stratum dominant tag, not full matrix.** Intensity gets reported as a single dominant tag per stratum. Seven strata, seven tags per analysis. A full 7x4 cross-tabulation (28 cells) is rejected as output format. Reliability compounds multiplicatively across joint decisions, several cells collapse empirically, and 28 cells overflow working memory. One dominant tag per stratum, seven-row output table.

## The Retrieval Substrate

Arithmetica (propositional density against a substrate) and Dialectica (claims in the deductive closure of substrate plus rules) are defined relative to a named substrate. Three canonical tiers.

| Tier | Substrate | Example | Use when |
|------|-----------|---------|----------|
| Public | Global web, canonical texts, widely-shared priors | "The Pythagorean theorem" | Analyzing public writing, detecting derivativeness |
| Corpus | An organization's or author's knowledge base | "We established this pattern in `knowledge/foo.md`" | Editing against your own prior work |
| Context | Earlier in this document, conversation, or session | "As shown in section 2" | Detecting in-text redundancy |

State the tier explicitly at the start of the analysis.

## Analysis Protocol

### Step 0: state telos and substrate

Before measurement, state explicitly:

- **Telos (t):** what this text is trying to achieve (teach, argue, summarize, specify, persuade, inspire, catalog, transmit, preserve).
- **Substrate:** which of {public, corpus, context} you are evaluating retrievability against, and name the specific substrate.

If the user did not specify, ask. If asking is not possible, infer and state the assumption.

### Step 1: measure raw length and preprocessor features

Total bytes, words, sentences, paragraphs. Run the preprocessor if precision matters. Capture the Musica raw features (sentence length variance, syllable estimate) and the Arithmetica raw features (propositional density estimate).

### Step 2: build the seven-stratum ledger

```
| Stratum | Content summary | Raw bytes | Compressed | Intensity |
|---------|-----------------|-----------|------------|-----------|
| Grammatica  |  |  |  | Stock/Implied/Selected/Original |
| Dialectica  |  |  |  | Stock/Implied/Selected/Original |
| Rhetorica   |  |  |  | Stock/Implied/Selected/Original |
| Arithmetica |  |  |  | Stock/Implied/Selected/Original |
| Geometria   |  |  |  | Stock/Implied/Selected/Original |
| Musica      |  |  |  | Stock/Implied/Selected/Original |
| Astronomia  |  |  |  | Stock/Implied/Selected/Original |
| TOTAL       |  |  |  | (n/a) |
```

### Step 3: encode each stratum

**Grammatica.** Describe the sentence-level form and any compound coinages or unusual syntactic patterns. Compress to a pointer ("standard argumentative essay sentence structure, 20-word average") or a specification for novel cases.

**Dialectica.** Encode derivable claims as `[method](inputs) → output`. Mark irreducible claims (Original intensity) separately. These are the text's originated inferential moves.

**Rhetorica.** Enumerate curatorial decisions with choice-space bits. Note which of the five canons dominates if Rhetorica is load-bearing.

**Arithmetica.** Report propositional density (propositions per word via a CPIDR-style heuristic). Typical ranges: expository prose 0.25-0.35, argumentative prose 0.25-0.30, lyric poetry 0.10-0.15, dense technical writing 0.35-0.50.

**Geometria.** Describe the document-level architecture in minimal notation. Static structure: section hierarchy, paragraph count, layout conventions.

**Musica.** Describe the rhythmic and prosodic structure. Measure deviation from the local-UID baseline: sentence-length variance, rhetorical figures (isocolon, anaphora, chiasmus, tricolon, periodic build, asyndeton), metrical patterns if present. For prose, flag rhetorical figures by location; for verse, mark meter, rhyme scheme, stress patterns.

**Astronomia.** Describe the global trajectory. Measure deviation from the global-UID baseline: does information intensity flow uniformly over document position, or does it peak at specific points? Is the argumentative or narrative arc conventional for the genre or originated by the author? For narrative texts, map the dramatic curve; for argumentative texts, map the thesis-unfolding pattern.

### Step 4: assign intensity tags

For each stratum, ask: against the stated substrate and telos, is the stratum's content at Stock, Implied, Selected, or Original intensity? Apply the conservative discipline. If a move could be retrieved from the substrate, it is Stock. If it could be derived from substrate plus standard rules, it is Implied. If it is a curatorial choice from a visible option space, it is Selected. Only content that survives all three tests is Original.

### Step 5: compute metrics

**Semantic Compression Ratio (SCR):**
```
SCR(d, t) = |d| / K_τ(d, t)
         ≈ |d| / (S₁ + S₂ + S₃ + S₄ + S₅ + S₆ + S₇)_compressed
```

**Novelty Density (ND):** weighted fraction of strata at higher intensity.
```
ND(d, C) = Σᵢ (intensity_weight(Sᵢ) · |Sᵢ|_compressed) / Σᵢ |Sᵢ|_compressed
```
where `intensity_weight` maps Stock → 0.0, Implied → 0.1, Selected → 0.3, Original → 1.0.

**Retrievability Index (RI):** weighted fraction of strata at Stock or Implied intensity.
```
RI(d, KB, R) = Σᵢ (retrievable_weight(Sᵢ) · |Sᵢ|_compressed) / Σᵢ |Sᵢ|_compressed
```
where `retrievable_weight` maps Stock → 1.0, Implied → 0.7, Selected → 0.0, Original → 0.0.

### Step 6: local density rollup

Global metrics lie about uneven texts. Report per-segment density. Segment the text by detected sections, or by equal chunks if no structure. For each segment, report the dominant stratum and intensity. Report the median dominant intensity, the peak stratum, the trough segment, and the range.

### Step 7: compression curve

For each target `L ∈ {280, 800, 2000, 5000}`, extract the `L` highest-intensity bytes (Original first, then Selected, then Implied, then Stock). Check whether the extracted bytes achieve telos `t`. Report the curve.

## Interpretation Guide

### SCR (Semantic Compression Ratio)

The bands below are calibrated for argumentative and original prose: essays, reports, analyses. They do not apply uniformly to expository and pedagogical prose (textbook passages, tutorials, reference documentation), where elaboration is part of the telos. A passage teaching a novice needs many more bytes than the minimum pointer-set identifying the same content against a reference substrate, and that elaboration is correct, not bloat. When the telos is pedagogy, read SCR as a scaffolding ratio, not a bloat indicator.

| Value | Argumentative or originated prose | Expository or pedagogical prose |
|-------|-----------------------------------|----------------------------------|
| < 2 | Extremely dense (Hopkins "Pied Beauty" sits near 1.3) | Aphoristic; likely insufficient for teaching |
| 2-5 | Well-developed, efficient ("The Problem of Defaults" sits near 3.6) | Terse; suitable as reference or reminder |
| 5-10 | Expansive, could be condensed | Well-developed explanatory prose |
| 10-20 | Verbose; core buried in padding | Expansive teaching with examples and motivation |
| > 20 | Severely bloated for an argument | Full introduction with scaffolding, correct for pedagogy ("How Photosynthesis Works" sits near 28) |

Read the number alongside the stated telos and the dominant-intensity profile.

### ND (Novelty Density), read with intensity tags

| Dominant intensity | Meaning |
|---|---|
| Mostly Stock | Fully conventional; the text transmits known content |
| Mostly Implied | Derivative but richly connected; makes known inferences from known substrate |
| Mostly Selected | Curatorial work dominates; value is in arrangement and framing, not new claims or rhythms |
| One stratum Original, others lower | Specific-origin originality; the contribution lives in one stratum |
| Multiple strata Original | Multi-axis originality; the text does several kinds of irreducible work at once. Rare. |

### Stratum profile shapes (common cases)

| Genre | Expected profile |
|---|---|
| Lyric poetry | Musica-Original or Selected, Rhetorica-Selected, Arithmetica-Stock, others vary |
| Textbook passage | Seven Stock |
| Argumentative essay | Dialectica-Selected or Original, Rhetorica-Selected, Musica-Selected, others Stock |
| Research paper | Dialectica-Original, Geometria-Selected or Stock (IMRaD), Arithmetica higher-density, others Stock |
| Legal brief | Grammatica-Selected (long periodic clauses), Geometria-Selected (hierarchical), Dialectica-Original or Implied, others Stock |
| Sacred text translation | Musica-Original (translator's rhythm choices), Rhetorica-Original, others inherit from source |

## Output Template

```
## ISDA Analysis: [Title]

Telos:      [what this text is trying to achieve]
Substrate:  [public / corpus / context], [named substrate]
Raw length: X bytes, X words, X paragraphs
Genre:      [type]

### Stratum Ledger

| Stratum     | Content summary        | Compressed | Intensity |
|-------------|------------------------|------------|-----------|
| Grammatica  | [sentence-level form]  | X B        | Stock/Implied/Selected/Original |
| Dialectica  | [inferences]           | X B        | ... |
| Rhetorica   | [curatorial decisions] | X B        | ... |
| Arithmetica | [propositional density]| X prop/word| ... |
| Geometria   | [architecture]         | X B        | ... |
| Musica      | [prosody, rhythm]      | X B        | ... |
| Astronomia  | [trajectory]           | X B        | ... |

### Global Metrics

| Metric | Value | Interpretation |
|--------|-------|----------------|
| SCR    | X     | [telos-contextualized reading] |
| ND     | X%    | [dominant-intensity reading]    |
| RI     | X%    | [substrate-contextualized]      |

### Local Density (optional, for uneven texts)

[Per-segment dominant stratum and intensity]

### Compression Curve

| Target | Preserves telos? | Which intensity levels fit |
|--------|------------------|---------------------------|
| 280 c  | YES/NO/PARTIAL | Original only |
| 800 c  | YES/NO/PARTIAL | Original plus top Selected |
| 2000 c | YES/NO/PARTIAL | Original, Selected, Implied anchors |
| 5000 c | YES/NO/PARTIAL | All of the above plus Stock scaffolding |

### Key Findings

[2-4 sentences on what the analysis reveals. Always relative to the stated telos and substrate. Name the dominant-intensity profile.]
```

## Caveats

Telos is the biggest variable. Any result without one is ambiguous at best, misleading at worst.

Substrate matters as much as telos. A paragraph is not retrievable; a paragraph against substrate X is.

Intensity tags are per-stratum dominant readings, not full matrices. A 28-cell cross-tabulation is the wrong output format. One dominant tag per stratum.

The Musica and Astronomia unified-UID spine means both temporal strata are measured as deviation from a uniform information-density expectation, at local (prosodic) and global (trajectory) scales. One theoretical framework, two scale instantiations, grounded in Aylett and Turk 2004 (local) and Wilmot and Keller 2020 (global). See `reference.md` section on UID-at-dual-scales.

The Grammatica and Musica boundary can fuzz on metrical texts. Metrical form belongs to Musica; syntactic form belongs to Grammatica. A 14-line lyric's iambic pentameter is Musica; its 14-line-with-volta structure is Grammatica (or Geometria, a single-line-vs-multi-line boundary that is itself fuzzy). Be explicit about where you draw the line.

Rhetorica shrinks the medieval art. Classical rhetorica is the full persuasive enterprise (Cicero's five canons and so on); we use it narrowly for curatorial decisions. The five canons live as internal substructure when Rhetorica dominates.

Cross-stratum interactions exist. Original claims (Dialectica-Original) can retroactively change what is Stock (Arithmetica). The decomposition is approximate, not exact. Name the caveat, report the dominant cell, move on.

`K` and `K_τ` are uncomputable. You are producing principled estimates, not measurements. Say so.

## References

- [[reference.md]]: formal conditional-complexity treatment, Nicomachan-Boethian 2x2 detail, per-stratum formal definitions, UID-at-dual-scales unification.
- [[theory.md]]: consolidated paper with prior-art survey, Solomonoff-Hutter compression-intelligence link, LLM-as-decompressor hypothesis.
- [[examples.md]]: three worked examples. Hopkins "Pied Beauty" (Musica-Original lyric), "The Problem of Defaults" (Dialectica-Original argumentative essay), "How Photosynthesis Works" (seven Stock textbook passage).

## Companions

- [[reference.md]] — the formal spine (conditional-complexity definitions, the Nicomachan-Boethian 2x2, UID-at-dual-scales).
- [[theory.md]] — the long-form theory and prior-art survey.
- [[examples.md]] — worked analyses to calibrate against.
- `isda_preprocess.py` — the measurement tool this skill drives; its `--help` is the canonical flag reference.
- [[skill://sortes]] — diverts attention by external draw; ISDA measures density — the border.

Keep the five files' vocabulary identical; see §0 SELF-UPDATING.
