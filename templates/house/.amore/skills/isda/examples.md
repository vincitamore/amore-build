# ISDA Worked Examples

Three worked examples of the Irreducible Semantic Density Analysis protocol. Each shows:

1. The full text, so readers can reproduce the analysis.
2. An explicit telos and substrate (step 0).
3. The stratum ledger with Stock, Implied, Selected, or Original intensity tags.
4. Computed metrics with interpretation.
5. Local density rollup.
6. The compression curve.
7. Key findings.

The three examples exercise the framework across its full range. Hopkins's "Pied Beauty" is an 80-word curtal form where Musica is the dominant stratum. "The Problem of Defaults" is a 1,020-word argumentative essay with uneven local density and Dialectica-Original claims. "How Photosynthesis Works" is a 950-word expository passage where every stratum reads Stock, which is the correct result for a textbook doing its job.

Hopkins is public domain (1918 publication, pre-1928 US). The other two texts are original, released under the same license as this repository.

---

## Example 1: Gerard Manley Hopkins, "Pied Beauty" (1877, pub. 1918)

### The text

```
                    Pied Beauty

Glory be to God for dappled things—
   For skies of couple-colour as a brinded cow;
      For rose-moles all in stipple upon trout that swim;
Fresh-firecoal chestnut-falls; finches' wings;
   Landscape plotted and pieced—fold, fallow, and plough;
      And áll trádes, their gear and tackle and trim.

All things counter, original, spare, strange;
   Whatever is fickle, freckled (who knows how?)
      With swift, slow; sweet, sour; adazzle, dim;
He fathers-forth whose beauty is past change:
                                Praise him.
```

Source: Gerard Manley Hopkins, written 1877, first published in *Poems of Gerard Manley Hopkins* (Oxford University Press, 1918). Public domain in the United States. The em dashes are Hopkins's; do not scrub them.

**Raw length:** ~410 bytes, 80 words, 11 lines. A *curtal form*, Hopkins's own three-quarter lyric form.

### Why this test case

Musica-dominant texts stress-test the framework's ability to report rhythm as a first-class property. In prose examples, Musica sits at Selected or Stock. In Hopkins, Musica is the stratum where the text cannot compress at all. Sprung rhythm, compound coinages, alliterative texture: these are not decoration of meaning. They are the meaning. A framework that could not measure this would miss what makes the poem land.

"Pied Beauty" also exercises the intensity ladder cleanly. Almost every stratum sits at a different level: Stock for Arithmetica (the propositions are simple), Selected for Grammatica, Rhetorica, and Geometria (form and framing are conventional choices), Implied for Dialectica and Astronomia (standard theological inference, conventional praise-poem trajectory), Original for Musica (sprung rhythm was historically new prosody).

### Step 0: telos and substrate

Poetry yields different analyses under different telos. Two framings.

**Framing A:** `telos = "transmit the observation that dappled, irregular, mixed things point toward an unchanging source"`; `substrate = public` (English literacy, general cultural awareness, no special theological background).

**Framing B:** `telos = "preserve the literary artifact as a poem, with meter, rhyme, form, and sound"`; `substrate = public` (same).

### Step 1: measurement

| Quantity | Value |
|---|---|
| Total bytes | ~410 |
| Total words | 80 |
| Lines | 11 |
| Stanzas | 2 (6 + 5) |
| Form | Curtal lyric form (Hopkins's own) |
| Meter | Sprung rhythm |

### Step 2: stratum ledger (Framing A, transmit observation)

| Stratum | Content | Compressed | Intensity |
|---|---|---|---|
| **Grammatica** | Asyndetic noun-phrase lists; compound coinages (*couple-colour*, *fresh-firecoal*, *chestnut-falls*, *fathers-forth*); bracketed praise opening and closing | ~30 B | **Selected** |
| **Dialectica** | Implicit inference: (particulars are dappled) → (dappledness is a form of beauty) → (source of dappled forms is unchanging) | ~25 B | **Implied** |
| **Rhetorica** | Praise opening, natural-world list, trades, meta-property (*counter, original, spare, strange*), theological source, closing praise. Curation of seven example domains | ~40 B | **Selected** |
| **Arithmetica** | ~9 propositions (praise God, skies dappled, trout dappled, chestnuts falling, finches' wings, landscape plotted, trades have gear, dappled things are counter or original or fickle, source is past change, praise him). ~0.11 prop/word, sparse density | ~25 B | **Stock** |
| **Geometria** | Curtal lyric form 6+5 architecture (three-quarters of a Petrarchan 14-line form) bracketed by praise formulas | ~20 B | **Selected** |
| **Musica** | Sprung rhythm (stress-based rather than syllable-based meter); alliteration throughout (*couple-colour*, *brinded*, *rose-moles*, *stipple*, *fresh-firecoal*, *fickle, freckled*, *swift, slow*, *sweet, sour*, *fathers-forth*); asyndeton (*swift, slow; sweet, sour; adazzle, dim*); accented syllables marked (*áll trádes*); rhythmic peaks at lines 1, 4, 7, 9 | ~150 B | **Original** |
| **Astronomia** | Trajectory: praise, particular list, meta-property, unchanging source, return to praise. Conventional praise-poem arc (*laudes, exempla, causa, laudes*) | ~30 B | **Implied** |

**Total `K_τ(d, A)` ≈ 320 bytes.** Raw ≈ 410.

### Step 3: metrics (Framing A)

| Metric | Value | Interpretation |
|---|---|---|
| SCR | ~1.3 | Near-minimal. Even for an observation-transmission telos, the poem is close to irreducible. |
| ND | ~0.37 | Novelty concentrated in one stratum (Musica-Original) and dominant there. |
| RI | 0 | Zero retrievable content against a public substrate. The poem references nothing external. |

### Step 4: stratum ledger (Framing B, preserve as artifact)

Under Framing B, nearly every stratum's intensity shifts up. The curatorial choices become Original because the specific word and form choices are load-bearing. Musica stays Original.

| Stratum | Intensity under Framing B |
|---|---|
| Grammatica | **Original** (compound coinages and specific word choices are part of the artifact) |
| Dialectica | **Selected** (the implicit argument structure is chosen, but the argument itself is still standard) |
| Rhetorica | **Original** (which seven domains, in which order, with which emphasis) |
| Arithmetica | **Stock** (the propositions are still simple) |
| Geometria | **Original** (curtal form is itself Hopkins's invention) |
| Musica | **Original** (unchanged) |
| Astronomia | **Selected** (the trajectory is still conventional but the specific unfolding matters) |

**Total `K_τ(d, B)` ≈ 410 bytes,** the text itself. SCR ≈ 1.0. No compression preserves the artifact.

### Step 5: local density rollup (line-level, Framing A)

| Line | Content | Dominant stratum | Intensity |
|---|---|---|---|
| 1 | *Glory be to God for dappled things* | Rhetorica | Selected |
| 2 | *For skies of couple-colour as a brinded cow* | **Musica** | **Original** (*couple-colour, brinded* alliterative cluster) |
| 3 | *For rose-moles all in stipple upon trout that swim* | Musica | Selected |
| 4 | *Fresh-firecoal chestnut-falls; finches' wings* | **Musica** | **Original** (compound coinage density peak) |
| 5 | *Landscape plotted and pieced, fold, fallow, and plough* | Musica | Selected |
| 6 | *And áll trádes, their gear and tackle and trim* | Grammatica | Selected |
| 7 | *All things counter, original, spare, strange* | Dialectica | Implied |
| 8 | *Whatever is fickle, freckled (who knows how?)* | **Musica** | **Original** (alliterative plus rhetorical aside) |
| 9 | *With swift, slow; sweet, sour; adazzle, dim* | **Musica** | **Original** (asyndetic tricolon with antonym pairing) |
| 10 | *He fathers-forth whose beauty is past change* | Dialectica | Implied |
| 11 | *Praise him* | Rhetorica | Selected |

**Rollup:** Musica is the dominant stratum in six of eleven lines and the Original-intensity stratum in four of them. Dialectica dominates only the abstract lines (7, 10) at Implied intensity. The poem's rhythmic peaks sit at the alliterative clusters (lines 2, 4, 8, 9), independent of the inferential peaks (lines 7, 10). Musica and Dialectica operate on different lines. This is the independence test Musica needs. High-Musica content is not just high-Dialectica content relabeled.

### Step 6: compression curve

| Target | Preserves Framing A? | Preserves Framing B? | What fits |
|---|---|---|---|
| 80 c | YES | NO | *"Dappled, counter, original things point to an unchanging source."* |
| 280 c (tweet) | YES | NO | Thesis plus list motif plus praise bracketing. |
| 500-800 c (paragraph) | YES | NO | Paraphrase of rhetorical structure. |
| ~410 c (full poem) | YES | YES | The poem itself. |

Framing A compresses aggressively. The thesis is ~80 characters. Framing B refuses compression.

### Step 7: key findings

Musica is the dominant stratum in six of eleven lines and sits at Original intensity in four. This is the proof of necessity for promoting prose rhythm to a first-class stratum. A framework without Musica would collapse the poem's most important work into "rhetoric" or "style" and miss that its novelty has a specific formal shape: sprung rhythm, alliterative clustering, compound coinage, measurable against a genre-conditional UID-local baseline.

The Musica peaks and the Dialectica peaks occupy different lines. Lines 2, 4, 8, and 9 are high-Musica, Original. Lines 7 and 10 are high-Dialectica, Implied. The two strata measure different things in the same text. "Pied Beauty" passes the independence test a rhythmic stratum needs to pass to be non-redundant with curatorial content.

The intensity ladder exercises all four levels in one poem. Stock (Arithmetica), Implied (Dialectica, Astronomia), Selected (Grammatica, Rhetorica, Geometria), Original (Musica). No other text in this example set exercises the full ladder so cleanly. Any given text can land at different points on different strata.

Telos reframing sharpens further. Framing A compresses aggressively (SCR ≈ 1.3); Framing B refuses compression (SCR ≈ 1.0, no compression target preserves the artifact). Same text, different telos, different answer. Framing A leaves Dialectica at Implied and Arithmetica at Stock. Framing B pushes Grammatica, Rhetorica, and Geometria up to Original because the specific word and form choices become load-bearing.

Astronomia reads Implied, not Original. A praise-poem trajectory (*laudes, exempla, causa, laudes*) is conventional for devotional lyric. The poem's novelty is not in its arc but in its rhythm. Astronomia reporting Implied rather than Original tells the analyst where to look for novelty (Musica, not trajectory) and where the text works within convention (the praise-poem shape).

Arithmetica is Stock and low: ~9 propositions across 80 words, ~0.11 prop/word. Lyric poetry should have low propositional density by construction. Its work is not accumulating claims. The preprocessor confirms this mechanically; the stratum reads Stock because each proposition is simple and derivable.

---

## Example 2: "The Problem of Defaults" (exploratory essay, ~1,020 words)

### The text

```
Every system has defaults: the choice that happens when no choice
is made. A text editor opens to a blank page. A new document has a
particular font. A web form starts with the first field empty. Most
discussions of "user choice" treat defaults as background, passive
settings that users override when they want something different.
This is wrong. Defaults are the strongest choices in a system
because they are the choices no one notices making.

The strength of a default comes from two places. First, most users
never override anything. Surveys of retirement savings plans show
that opt-in versus opt-out enrollment produces participation rates
of roughly 30 percent versus 90 percent, on the same demographic,
with the same financial incentive, holding everything else constant.
The intervention that actually matters is not the education campaign
or the employer match. It is the checkbox's initial state. A default
determines what most people will do, because most people will do
nothing.

Second, defaults carry a kind of implicit endorsement. Users reason,
often without reflection, that the default represents what the
system's designers thought was usually correct. If a website
suggests unchecking a box to opt out of a newsletter, users assume
someone decided that subscribing was typical. When tax software
prefills a deduction, users assume prefilling was not arbitrary.
This reasoning is often wrong. Defaults are set by inertia, by A/B
tests, by legacy constraints, by somebody's best guess five years
ago. The reasoning happens anyway, and it makes the default do work
that no active choice could.

Because defaults are strong, their design carries moral weight out
of proportion to how they are treated. A software company choosing
whether telemetry is on by default, a municipality choosing whether
ballots list candidates alphabetically or randomly, a hospital
choosing whether organ donation is opt-in or opt-out: all of these
are small engineering decisions that determine what most humans do.
Engineers who think of themselves as neutral tool-builders are often
shaping entire populations' behavior through choices they made in a
Tuesday meeting.

The response to this is not "no defaults." A system without defaults
forces every user through every decision, and the effect is not
empowerment. It is paralysis, or avoidance, or a choice made under
frustration that is worse than any default the designer would have
selected. Forms that demand an answer for every field see abandonment
rates that dwarf the complaints about prefilling. Choice is a
resource users have to spend, and asking them to spend it on
questions they do not care about guarantees that they will spend
less of it on questions they do.

So the engineering question is not whether to have defaults, but
which ones to have, and for whom. A good default serves the typical
user's actual interest when averaged over the whole population. Not
the interest they would articulate if asked (users are bad at
articulating interests) but the interest their downstream behavior
reveals. This is measurable but hard. It requires admitting that
the designer is making a paternalistic choice, and then actually
doing the work to make the paternalism competent.

The hardest part is that the population is not homogeneous. A
default that serves 80 percent of users hurts the other 20, and
the shape of that 20 percent matters. If the 20 percent who lose
are already well-served by other parts of the system, the default
is fine. If the 20 percent who lose are the population the system
most needed to protect, the default is a failure. An opt-out policy
works well when most users would want the default anyway; it is
wrong in a population where a minority has reasons the mainstream
designers failed to notice.

The only honest version of default-setting is iterative. Ship the
default. Measure who it serves and who it fails. Adjust. The
adjustment will never reach a population-wide optimum because there
is not one. Treat the default as a living hypothesis about what
most users want, not a settled answer. The engineer's responsibility
is not to get the default right the first time. It is to notice
when it has drifted from serving its population and to fix it before
the drift becomes catastrophic.

There is a further problem: defaults interact. An application with
ten default settings has a thousand combined configurations, most of
which no one has ever tested. Users who override one default but not
the others land in combinations that may never have been exercised
in development. A feature that works fine under the most common
combinations can fail strangely under uncommon ones, and the
debugging trail back to "which default is wrong here" is usually
expensive. The discipline of tracking which combinations are
actually used is older than software. It is the same problem as
tracking which parameters are being swept in a scientific experiment.
It is routinely ignored by teams who think of defaults as one-at-a-
time decisions.

The cure for this, as for the single-default case, is measurement.
Not pre-release testing of every combination (impossible) but
production instrumentation that tells you which combinations users
land in, and how those combinations fare against the goals the
system is supposed to achieve. Systems that do this well feel like
they "just work" because the defaults are being quietly retuned
under the hood in response to evidence. Systems that do not
eventually accumulate configurations that no one who still works
at the company understands.

None of this is visible to users. That is its power and its danger.
The work of default design is invisible labor, and invisible labor
is always underpaid. Engineers who spend a week tuning a default
are often told they should have been building a feature. Engineers
who ship a badly considered default are rarely held accountable
because the failure mode is statistical (a few percent of users
slightly worse off) rather than catastrophic. The incentives are
wrong.

If we took defaults seriously, we would treat them the way we
treat cryptographic parameters: critical, specialized, expensive to
get right, and worth spending disproportionate effort on. We do not
let junior engineers pick hash functions. We should probably not
treat default selection for population-scale systems as something
to be done between two other items on a project manager's checklist.
That we do, and that this is considered normal, is one of the
quieter governance failures of the engineered world.
```

**Raw length:** ~5,800 bytes, ~1,020 words, 11 paragraphs.

### Why this test case

A moderately substantial argumentative essay with a clear thesis, a recognizable rhetorical mode, a mix of established facts and original analytic claims, and enough length to exercise the local-density rollup. It is the kind of writing ISDA was built to interrogate. Not poetry, not documentation, but prose whose value rests on specific claims that have to be separated from their scaffolding. The essay has deliberate structure (thesis, two-part mechanism, stakes, counterobjection, refinement, complication, meta-observation, conclusion) which the paragraph-level rollup should expose.

### Step 0: telos and substrate

Two telos framings.

**Framing A:** `telos = "deliver the central claim about defaults to a policy-interested general reader"`; `substrate = public`.

**Framing B:** `telos = "teach a software engineer to apply the argument in their own system"`; `substrate = public`.

### Step 1: measurement

| Quantity | Value |
|---|---|
| Total bytes | ~5,800 |
| Total words | ~1,020 |
| Paragraphs | 11 |
| Sentences | ~50 |

### Step 2: stratum ledger (Framing A)

| Stratum | Content | Compressed | Intensity |
|---|---|---|---|
| **Grammatica** | Declarative argumentative prose, periodic sentences, ~20-word average length, consistent register | ~30 B | **Stock** |
| **Dialectica** | Five original analytic claims: (1) defaults draw strength from both inaction and implicit endorsement, with the second under-appreciated; (2) no-defaults systems are worse than bad-defaults systems because choice is a resource; (3) iterative measurement is the only honest default-setting method; (4) defaults interact combinatorially and most teams never track combinations; (5) default design is cryptographic-parameter-level critical work | ~1,400 B | **Original** |
| **Rhetorica** | Example selection (retirement, ballot, telemetry, organ donation); ordering (mechanism, stakes, counterobjection, refinement, complication, governance); framing (invisible labor, cryptographic-parameters closing); scope decisions | ~60 B + ~4 bits | **Selected** |
| **Arithmetica** | ~275 propositions via content-word heuristic, ~0.27 prop/word, normal argumentative-essay density | ~15 B | **Stock** |
| **Geometria** | 11 flat paragraphs, single section, linear unfolding. No hierarchy, no sub-sections | ~40 B | **Stock** |
| **Musica** | Rhetorical figures: periodic build in ¶1 ("the choices no one notices making"); tricolon in ¶3 ("by inertia, by A/B tests, by legacy constraints"); triple isocolon of institutional examples in ¶4; tricolon in ¶5 ("paralysis, or avoidance, or a choice"); anaphora in ¶11 ("We do not... We should probably not...") | ~25 B | **Selected** |
| **Astronomia** | Trajectory: thesis, mechanism, stakes, counterobjection, refinement, complication, governance closing. Conventional argumentative-essay arc with a reframing ending | ~40 B | **Selected** |

**Total `K_τ(d, A)` ≈ 1,625 bytes.** Raw ~5,800 bytes.

### Step 3: metrics

| Metric | Framing A | Framing B |
|---|---|---|
| SCR | ~3.6 | ~4.0 |
| ND | ~0.24 | ~0.22 |
| RI | ~0.10 | ~0.10 |
| Musica intensity | Selected | Selected |
| **Dialectica intensity** | **Original** | **Original** |
| Astronomia intensity | Selected | Selected |

Per-stratum intensity tags localize the essay's originality. Dialectica is Original: the five claims are the essay's contribution. Rhetorica, Musica, and Astronomia are Selected: the rhetorical figures, example selection, and argumentative arc are curatorial choices from visible options. Grammatica, Arithmetica, and Geometria are Stock: the essay is conventional in its sentence-level form, its propositional density, and its document architecture.

This is a precise characterization. An editor knows which stratum carries the novelty (Dialectica, not Musica or Astronomia) and therefore where cuts would hurt the most.

### Step 4: local density (paragraph rollup, Framing A)

| ¶ | Role | Dominant stratum and intensity |
|---|---|---|
| 1 | Thesis | Dialectica-Original (the core claim) |
| 2 | Mechanism 1, inaction | Dialectica-Implied (derivation from substrate) |
| 3 | Mechanism 2, implicit endorsement | **Dialectica-Original** (the under-appreciated half) |
| 4 | Stakes, three examples | Rhetorica-Selected |
| 5 | Counterobjection, "choice is a resource" | **Dialectica-Original** |
| 6 | Refinement, good defaults serve downstream interest | Dialectica-Selected |
| 7 | Heterogeneity, who the 20 percent are matters | **Dialectica-Original** |
| 8 | Iterative method | **Dialectica-Original** |
| 9 | Combinatorial interaction | **Dialectica-Original** |
| 10 | Cure, instrumentation | Dialectica-Implied |
| 11 | Governance closing, "cryptographic parameters" | **Rhetorica-Original** (the reframing is new) |

Six of 11 paragraphs are Dialectica-Original. The essay's claim density is high, concentrated in the mechanism-and-prescription paragraphs. Paragraph 11's governance closing reads Rhetorica-Original because the reframing of default design as cryptographic-parameter-level work is a new curatorial move even though the underlying claim (defaults matter) is already established.

### Step 5: compression curve

| Target | Framing A (policy reader) | Framing B (engineer) |
|---|---|---|
| 280 c | PARTIAL | NO |
| 500-800 c | YES | PARTIAL |
| 1,500-2,000 c | YES | YES |
| 5,000 c | YES | YES |

### Step 6: key findings

Dialectica-Original in six of eleven paragraphs. The essay's uneven density is not a stylistic quirk; it is a stratum signature. An editor looking at the rollup knows which paragraphs are cut-candidates (¶4, ¶10) and which are load-bearing (¶1, ¶3, ¶5, ¶7, ¶8, ¶9).

Rhetorica-Original in ¶11. The governance closing reframes the essay's stakes. The underlying claim is established, but the curatorial move of putting default design in the same frame as cryptographic parameters is new. The framework reports this as a precise cell, not as hand-waving about joint novelty.

Musica is Selected, not Original. The rhetorical figures (tricolon, isocolon, anaphora, periodic build) come from a known inventory of rhetorical devices. An essay writer with training uses them; they are not new prosody. Hopkins's sprung rhythm is Musica-Original; a well-placed anaphora is Musica-Selected. The intensity ladder distinguishes these cleanly.

Astronomia is Selected, not Original. The essay's trajectory (thesis, mechanism, stakes, counterobjection, refinement, complication, closing) is a conventional argumentative arc. The novelty lives in the Dialectica content filling that arc, not in the arc itself.

---

## Example 3: "How Photosynthesis Works" (expository passage, ~950 words)

### The text

```
Photosynthesis is the process by which green plants and certain
bacteria convert light energy into chemical energy. In its simplest
summary, the process takes carbon dioxide from the air, water from
the soil, and sunlight from above, and produces glucose (a sugar
that the plant uses for energy and as a building material) and
molecular oxygen as a byproduct. The overall balanced reaction is
commonly written as 6 CO₂ + 6 H₂O + light energy → C₆H₁₂O₆ + 6 O₂.
This single equation summarizes a process that in reality involves
dozens of enzymes, two distinct electron transport chains, and a
cyclic series of chemical reactions among the most studied in all
of biochemistry.

Photosynthesis takes place in chloroplasts, small organelles found
inside the cells of green plants and some other organisms. A
chloroplast contains stacks of membrane-enclosed compartments called
thylakoids. The thylakoid membranes hold the pigment chlorophyll,
which gives leaves their characteristic green color. Chlorophyll
absorbs light most strongly in the red and blue parts of the
spectrum and reflects green, which is why green is what reaches our
eyes. When a chlorophyll molecule absorbs a photon, one of its
electrons is boosted to a higher energy state, and this high-energy
electron is the starting point of everything that follows.

The full process is traditionally divided into two stages, the
light-dependent reactions and the light-independent reactions
(sometimes called the Calvin cycle). The light-dependent reactions
happen in the thylakoid membrane. They use the energy from absorbed
light to split water molecules, releasing oxygen as a byproduct and
transferring the resulting electrons through a chain of protein
complexes. As the electrons pass along the chain, their energy is
used to pump protons across the thylakoid membrane, creating a
proton gradient. The gradient drives an enzyme called ATP synthase,
which makes ATP, the cell's universal energy currency. Meanwhile,
the electrons themselves end up reducing a molecule called NADP⁺
to NADPH, which carries high-energy electrons to the next stage.

The light-independent reactions, or Calvin cycle, take place in
the fluid-filled space of the chloroplast called the stroma. This
stage uses the ATP and NADPH produced in the first stage to convert
atmospheric carbon dioxide into sugar. The key step is the capture
of CO₂ by a molecule called RuBP (ribulose-1,5-bisphosphate), in a
reaction catalyzed by the enzyme RuBisCO, the most abundant enzyme
on Earth. Through a cyclic series of reactions, the carbon atoms
from CO₂ are incorporated into three-carbon molecules that are
eventually assembled into glucose and used to regenerate RuBP so
the cycle can run again. For every three molecules of CO₂ that
enter, the cycle produces one three-carbon sugar, and six turns of
the cycle yield one full glucose molecule.

Photosynthesis is the basis of almost all life on Earth. Plants
store the chemical energy they capture in the form of sugars,
starches, and oils, and this energy flows through food chains as
animals eat plants and other animals eat the plant-eaters. The
oxygen released as a byproduct accumulates in the atmosphere, where
it supports the aerobic respiration that most living organisms
depend on, including humans. Over geological time, the oxygen
content of Earth's atmosphere rose from essentially zero to its
present level of about twenty-one percent largely because of
photosynthetic organisms, an event biologists call the Great
Oxygenation Event. Fossil fuels (coal, oil, and natural gas) are
also downstream of photosynthesis, representing ancient plant
matter that was buried and chemically transformed over hundreds of
millions of years.

Different organisms perform photosynthesis using variations on
the basic scheme. Most land plants use what is called C3
photosynthesis, in which the Calvin cycle fixes carbon directly
from atmospheric CO₂. A smaller number of plants (corn, sugarcane,
and many desert species) use C4 photosynthesis, in which CO₂ is
first captured into a four-carbon compound and then shuttled to
specialized cells where the Calvin cycle runs. C4 photosynthesis
is more efficient in hot, dry conditions because it concentrates
CO₂ near RuBisCO and reduces wasteful side reactions with oxygen.
A third variant, CAM photosynthesis, is used by cacti and other
succulents; these plants open their stomata only at night to
capture CO₂ and then close them during the day to conserve water,
storing the captured carbon for use when light is available.
Marine algae and cyanobacteria use yet other variations, and
their collective activity is responsible for roughly half of the
oxygen produced on Earth each year.

Photosynthetic efficiency is remarkably low when measured against
the maximum theoretical limit. The best crop plants convert only
about one percent of the solar energy that falls on them into
harvested biomass, and most ecosystems are even less efficient.
This is not because plants are badly designed but because RuBisCO
is slow, because light levels often exceed what the photosynthetic
machinery can use, and because plants must balance photosynthesis
against water loss through their stomata. Agricultural research
over the past several decades has explored whether photosynthetic
efficiency can be improved through selective breeding or genetic
engineering, with some promising but still modest results. The
fundamental reactions are deeply conserved across photosynthetic
organisms, which suggests that the system sits near a local
optimum that is hard to escape without wholesale redesign.
```

**Raw length:** ~5,300 bytes, ~950 words, 7 paragraphs.

### Why this test case

The opposite end of the density spectrum from Example 1. An expository technical passage on a settled scientific topic. Its telos is efficient transfer of already-established knowledge to a reader who does not yet have it. Everything in the passage should be retrievable against the shared substrate of biology. Any original content would be a defect, since students would have no way to verify novel claims. A successful explanatory passage is supposed to read Stock across every stratum against a public substrate. The framework should recognize this and not penalize it.

### Step 0: telos and substrate

`telos = "teach the essential mechanism of photosynthesis to a biology student who knows basic chemistry, such that they could answer an exam question and understand where this fits in biology"`

`substrate = public` (high-school chemistry literacy)

### Step 1: measurement

| Quantity | Value |
|---|---|
| Total bytes | ~5,300 |
| Total words | ~950 |
| Paragraphs | 7 |

### Step 2: stratum ledger

| Stratum | Content | Compressed | Intensity |
|---|---|---|---|
| **Grammatica** | Expository declarative prose, ~23-word sentences, technical-textbook register | ~25 B | **Stock** |
| **Dialectica** | Standard derivations (electron chain leading to proton gradient leading to ATP synthase leading to ATP; the balanced equation 6 CO₂ + 6 H₂O + light → C₆H₁₂O₆ + 6 O₂; stoichiometric "6 turns of the Calvin cycle give glucose") | ~50 B | **Stock** |
| **Rhetorica** | Ordering (definition, location, stage 1, stage 2, significance, variants, efficiency); standard textbook scope decisions; conventional example selection | ~35 B + ~15 bits | **Stock** |
| **Arithmetica** | ~290 propositions via content-word heuristic, ~0.31 prop/word, medium-density expository writing | ~20 B | **Stock** |
| **Geometria** | 7 flat paragraphs, expository ordering, linear, standard textbook architecture | ~30 B | **Stock** |
| **Musica** | Rhythmically flat, no rhetorical figures, no marked prosody. Correct for expository prose | ~5 B | **Stock** |
| **Astronomia** | Conventional textbook trajectory (summary, location, mechanism, significance, variants). No arc, no surprise, no reframing | ~25 B | **Stock** |

**Total `K_τ(d, t) ≈ 190 bytes.** Raw ~5,300 bytes.

### Step 3: metrics

| Metric | Value | Interpretation |
|---|---|---|
| SCR | ~28 | Very high. Correct for pedagogical elaboration, not a bloat indicator. See SKILL.md interpretation bands for expository prose. |
| ND | 0 | Zero novelty. Correct: a textbook should not contain new claims. |
| RI | ~0.83 | Encyclopedic. Nearly every statement is retrievable against a biology textbook. |

All seven strata read Stock. This is correct. A successful introductory passage on a well-established scientific topic should have zero originality against a discipline-literate substrate, and the seven-row table reports it cleanly. Seven Stock tags confirm the text does its one job, conventional knowledge transmission, across every stratum.

### Step 4: local density

Uniformly Stock across all seven paragraphs. The framework reports zero originality without ambiguity.

### Step 5: compression curve

| Target | Preserves telos? |
|---|---|
| 280 c (tweet) | NO. Equation fits but mechanism does not. |
| 500-800 c | PARTIAL. Stages named but not built. |
| 1,500-2,000 c | YES. Full mechanism for a student. |
| 5,000 c | YES. Close to the original. |

### Step 6: key findings

Seven Stock tags across seven strata is a valid and informative reading. A reader who sees this knows immediately that the text does its pedagogical job without originality. Not "this text is boring" but "this text is consistently derivative against a science-literate substrate, which is what an introductory passage should be."

The SCR ≈ 28 reading is not a bloat signal under the interpretation bands for expository prose. Argumentative prose expects 2-5; expository and pedagogical prose can legitimately run to 20-30 because elaboration is part of the telos.

Musica reads Stock, not null. The passage has prosody (sentence-length variance, paragraph rhythm) but its prosody sits at the UID-smooth baseline for its genre. This is the correct report: the text has rhythm in the sense that any text does, and its rhythm is conventional.

Astronomia reads Stock, meaning the trajectory is fully predictable from genre. A textbook reader could predict what comes next at every point. This is the global-UID analog of Musica-Stock. The text does not violate the trajectory-expectation distribution for expository prose.

---

## Cross-example takeaways

| Text | Telos | Dominant stratum | Dominant intensity | SCR | Overall ND |
|---|---|---|---|---|---|
| Hopkins, "Pied Beauty" | transmit observation | Musica | **Original** | 1.3 | 0.37 |
| Hopkins, "Pied Beauty" | preserve artifact | Musica, Grammatica, Rhetorica, Geometria | **Original** | 1.0 | 0.85 |
| "The Problem of Defaults" | policy reader | Dialectica | **Original** | 3.6 | 0.24 |
| "The Problem of Defaults" | engineer | Dialectica | **Original** | 4.0 | 0.22 |
| "How Photosynthesis Works" | teach novice | (all seven) | **Stock** | ~28 | 0 |

Reading the table: six distinct profiles across three texts. No row is wrong; each is a precise characterization against its stated telos and substrate.

Seven observations fall out of the cross-example comparison.

1. Each text has a different dominant stratum. Musica (Hopkins), Dialectica (Defaults), nothing (Photosynthesis). The framework's seven strata catch real differences across genre.

2. The intensity ladder adds a second axis that sharpens every cell. Defaults and Hopkins both have "high novelty" in aggregate, but the novelty sits at different strata and different intensities. Hopkins is Musica-Original (historically new prosody), Defaults is Dialectica-Original (new argumentative claims). Knowing which is which is editorially actionable in a way "high ND" is not.

3. Seven Stock tags is a valid reading for pedagogical prose. The framework handles the "correct zero" case without forcing false novelty onto textbook writing. Photosynthesis is correctly identified as conventional knowledge transmission.

4. Musica and Astronomia behave independently. Hopkins is Musica-Original, Astronomia-Implied. The UID-at-dual-scales spine produces different values at local and global scales for the same text. Hopkins is rhythmically new without being trajectory-new. His praise-poem arc is conventional.

5. Telos reframing shifts intensities but not strata. Hopkins under Framing A has Grammatica, Rhetorica, and Geometria at Selected. Under Framing B they shift to Original. The stratum identities stay constant; only the intensity tags move. This is the architecture behaving correctly. The strata describe *what kind of work* the text does; the intensity tags describe *how conditioned on context* that work is. Different telos specify different contexts, which changes intensities but not strata.

6. Zero retrievability (RI = 0) and maximum retrievability (RI ≈ 0.83) both appear. Hopkins has RI = 0 (no external references); Photosynthesis has RI ≈ 0.83 (nearly everything is retrievable from a biology textbook). The framework tolerates both extremes without forcing them to a middle.

7. The telos-weighted `K_τ` formalism gives different answers for the same text under different telos by shifting weights, not by re-measuring strata. Hopkins under "transmit observation" weights Dialectica high; Hopkins under "preserve artifact" weights Grammatica, Rhetorica, Musica, and Geometria high. The same seven-stratum measurement underlies both answers.

---

*"The Problem of Defaults" and "How Photosynthesis Works" are released under the same license as this repository. Hopkins's "Pied Beauty" is public domain (1918 US publication). Run the preprocessor on all three, produce independent stratum estimates, and compare. Differences between independent analyses are informative about where the framework's subjectivity lives.*
