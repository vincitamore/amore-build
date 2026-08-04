#!/usr/bin/env python3
"""
ISDA Preprocessor. Measurement, not judgment.

Philosophy: this tool provides raw quantitative data to anchor semantic analysis.
It does NOT classify content into strata; that requires understanding.

What this tool does:
  - Measures bytes, words, sentences, paragraphs (unambiguous).
  - Maps structure: sections, hierarchy (low-judgment).
  - Computes lexical statistics: TTR, sentence distribution (statistical).
  - Propositional density estimate (Arithmetica raw feature).
  - Prosody profile: sentence length variance plus syllable estimate (Musica raw feature).
  - Trajectory profile: per-segment information intensity scaffolding (Astronomia raw feature).
  - Extracts candidates for review: quotes, repeated phrases, citation patterns.
  - Per-segment rollups so local density is visible.
  - Records telos and substrate as metadata for downstream analysis.

What this tool does NOT do:
  - Classify content into Grammatica / Dialectica / Rhetorica / Arithmetica / Geometria / Musica / Astronomia
  - Assign Stock / Implied / Selected / Original intensity tags
  - Determine if repetition is redundancy or rhetorical device
  - Judge what counts as a "proper noun" vs common word
  - Run full CPIDR (POS-tag rules require a POS tagger dependency);
    we use a content-word heuristic as a reproducible proxy

Usage:
    python isda_preprocess.py <file_path>
    python isda_preprocess.py <file_path> --telos "teach category theory to a beginner"
    python isda_preprocess.py <file_path> --telos "..." --substrate "public web"
    python isda_preprocess.py --text "inline text" --telos "..."
    cat file.txt | python isda_preprocess.py --stdin --telos "..."

The --telos and --substrate flags are optional but strongly recommended. They
are recorded in the output metadata so downstream analysis always carries the
interpretive frame. If omitted, a warning is emitted.

Output: JSON with measurements, seven-stratum raw features, and candidates for
human judgment.
"""

import argparse
import json
import re
import sys
from collections import Counter
from dataclasses import dataclass, asdict, field


# ---------- Dataclasses ----------


@dataclass
class Measurements:
    total_bytes: int
    total_chars: int
    total_words: int
    total_sentences: int
    total_paragraphs: int


@dataclass
class Structure:
    detected_sections: list[str]
    section_count: int
    paragraph_lengths: list[int]
    avg_paragraph_words: float
    median_paragraph_words: float


@dataclass
class SentenceProfile:
    avg_length_words: float
    median_length_words: float
    min_length: int
    max_length: int
    distribution: dict[str, int]
    lengths: list[int]


@dataclass
class LexicalProfile:
    unique_words: int
    type_token_ratio: float
    hapax_legomena: int
    hapax_ratio: float
    avg_word_length: float
    word_length_distribution: dict[int, int]


@dataclass
class SegmentStats:
    label: str
    start_offset: int
    end_offset: int
    bytes: int
    words: int
    sentences: int
    unique_words: int
    type_token_ratio: float
    hapax_ratio: float
    avg_sentence_length: float
    sentence_length_variance: float
    content_word_ratio: float


@dataclass
class ArithmeticaFeature:
    """Raw feature for Arithmetica (propositional density)."""
    total_propositions_est: int
    density_per_word: float
    density_per_sentence: float
    method: str
    note: str


@dataclass
class MusicaFeature:
    """Raw feature for Musica (local prosody)."""
    sentence_length_mean: float
    sentence_length_variance: float
    sentence_length_cv: float  # coefficient of variation
    avg_syllables_per_word_est: float
    rhetorical_figure_candidates: int
    note: str


@dataclass
class AstronomiaFeature:
    """Raw feature for Astronomia (global trajectory)."""
    segment_count: int
    intensity_profile: list[float]  # content density per segment, normalized
    intensity_range: float
    intensity_variance: float
    peak_segment: int
    trough_segment: int
    note: str


@dataclass
class Candidate:
    type: str
    text: str
    position: int
    context: str
    note: str


# ---------- Stopword set for content-word heuristic ----------

# English function words: articles, auxiliaries, pronouns, conjunctions, etc.
# Used for the content-word heuristic that approximates Kintsch propositional density.
# Non-stopword tokens are treated as proposition-bearing content words.
STOPWORDS = {
    # articles
    "a", "an", "the",
    # auxiliaries
    "am", "is", "are", "was", "were", "be", "been", "being",
    "have", "has", "had", "having",
    "do", "does", "did", "doing", "done",
    "will", "would", "shall", "should", "can", "could", "may", "might",
    "must", "ought",
    # pronouns
    "i", "me", "my", "mine", "myself",
    "you", "your", "yours", "yourself", "yourselves",
    "he", "him", "his", "himself",
    "she", "her", "hers", "herself",
    "it", "its", "itself",
    "we", "us", "our", "ours", "ourselves",
    "they", "them", "their", "theirs", "themselves",
    "this", "that", "these", "those",
    "who", "whom", "whose", "which", "what",
    # conjunctions
    "and", "or", "but", "nor", "yet", "so", "for",
    "if", "then", "else", "when", "where", "while", "as", "because",
    "though", "although", "since", "unless", "until", "whether",
    # determiners
    "some", "any", "all", "every", "each", "no", "none",
    "many", "much", "more", "most", "few", "several", "such",
    # prepositions (arguably content-bearing in CPIDR but excluded here for simplicity)
    "of", "in", "on", "at", "to", "from", "by", "with", "about",
    "into", "onto", "upon", "over", "under", "through", "between",
    "among", "against", "before", "after", "during", "without", "within",
    # other function words
    "not", "only", "even", "also", "just", "very", "too",
    "there", "here", "now", "then",
}


# ---------- Tokenization primitives ----------


def tokenize_words(text: str) -> list[str]:
    return re.findall(r'\b[a-zA-Z]+\b', text.lower())


def tokenize_sentences(text: str) -> list[str]:
    protected = text
    abbrevs = ['Mr', 'Mrs', 'Ms', 'Dr', 'Prof', 'Inc', 'Ltd', 'Jr', 'Sr',
               'vs', 'etc', 'i.e', 'e.g']
    for abbr in abbrevs:
        protected = re.sub(rf'\b{abbr}\.\s', f'{abbr}<DOT> ', protected)

    sentences = re.split(r'[.!?]+\s+', protected)
    sentences = [s.replace('<DOT>', '.').strip() for s in sentences if s.strip()]
    return sentences


def extract_paragraphs(text: str) -> list[str]:
    paragraphs = re.split(r'\n\s*\n|\r\n\s*\r\n', text)
    return [p.strip() for p in paragraphs if p.strip()]


def extract_sections(text: str) -> list[str]:
    """
    Extract lines that look like section headers.
    Heuristic only; human should verify.
    """
    lines = text.split('\n')
    candidates = []

    for line in lines:
        stripped = line.strip()
        if not stripped or len(stripped) > 100:
            continue

        if re.match(r'^#{1,6}\s+', stripped):
            candidates.append(re.sub(r'^#+\s+', '', stripped))
            continue

        if stripped.endswith(('.', ',', ';', '?', '!')):
            continue

        words = stripped.split()
        if 2 <= len(words) <= 12:
            caps = sum(1 for w in words if w and w[0].isupper())
            if caps >= len(words) * 0.4:
                candidates.append(stripped)

    return candidates


# ---------- v0.2 content-word heuristic ----------


def count_content_words(words: list[str]) -> int:
    """
    CPIDR-lite approximation. Count words NOT in the function-word stoplist
    as proposition-bearing content words. This is a rough proxy for Kintsch
    propositional density (propositions per word). Real CPIDR uses POS tags
    + ~40 adjustment rules; this is a reproducible deterministic approximation
    with no external dependencies.
    """
    return sum(1 for w in words if w not in STOPWORDS)


def estimate_syllables(word: str) -> int:
    """
    Vowel-group heuristic for syllable estimation.
    Not linguistically precise; close enough for relative variance.
    """
    word = word.lower().strip()
    if not word:
        return 0
    count = 0
    prev_was_vowel = False
    vowels = "aeiouy"
    for char in word:
        is_vowel = char in vowels
        if is_vowel and not prev_was_vowel:
            count += 1
        prev_was_vowel = is_vowel
    if word.endswith("e") and count > 1:
        count -= 1
    return max(1, count)


def detect_rhetorical_figure_candidates(sentences: list[str]) -> int:
    """
    Very rough heuristic for counting candidate rhetorical figures:
    - isocolon: adjacent sentences of similar length (within 20%)
    - anaphora: adjacent sentences starting with the same 2+ words
    - tricolon: three short items separated by commas or semicolons

    Returns a count, not a classification.
    """
    count = 0

    # Anaphora: adjacent sentences with shared opening
    for i in range(len(sentences) - 1):
        s1_words = sentences[i].lower().split()[:2]
        s2_words = sentences[i + 1].lower().split()[:2]
        if s1_words and s2_words and s1_words == s2_words:
            count += 1

    # Isocolon: adjacent sentences with similar word-lengths
    for i in range(len(sentences) - 1):
        l1 = len(sentences[i].split())
        l2 = len(sentences[i + 1].split())
        if l1 >= 5 and l2 >= 5 and abs(l1 - l2) <= max(1, 0.2 * min(l1, l2)):
            count += 1

    # Tricolon: count triple comma lists ("x, y, and z" or "x, y, z")
    for sentence in sentences:
        # Look for "X, Y, (and|or)? Z" patterns with short items
        if re.search(r'\b\w+(\s+\w+){0,3},\s+\w+(\s+\w+){0,3},\s+(and\s+|or\s+)?\w+', sentence):
            count += 1

    return count


# ---------- Core measurement ----------


def measure(text: str) -> Measurements:
    paragraphs = extract_paragraphs(text)
    sentences = tokenize_sentences(text)
    words = tokenize_words(text)

    return Measurements(
        total_bytes=len(text.encode('utf-8')),
        total_chars=len(text),
        total_words=len(words),
        total_sentences=len(sentences),
        total_paragraphs=len(paragraphs)
    )


def analyze_structure(text: str) -> Structure:
    paragraphs = extract_paragraphs(text)
    sections = extract_sections(text)

    para_lengths = [len(tokenize_words(p)) for p in paragraphs]
    sorted_lengths = sorted(para_lengths) if para_lengths else [0]
    median_idx = len(sorted_lengths) // 2

    return Structure(
        detected_sections=sections,
        section_count=len(sections),
        paragraph_lengths=para_lengths,
        avg_paragraph_words=round(sum(para_lengths) / len(para_lengths), 2) if para_lengths else 0,
        median_paragraph_words=sorted_lengths[median_idx] if sorted_lengths else 0
    )


def analyze_sentences(text: str) -> SentenceProfile:
    sentences = tokenize_sentences(text)
    lengths = [len(tokenize_words(s)) for s in sentences]

    if not lengths:
        return SentenceProfile(0, 0, 0, 0, {}, [])

    sorted_lengths = sorted(lengths)
    median_idx = len(sorted_lengths) // 2

    dist = {'short_1_10': 0, 'medium_11_20': 0, 'long_21_35': 0, 'very_long_36_plus': 0}
    for length in lengths:
        if length <= 10:
            dist['short_1_10'] += 1
        elif length <= 20:
            dist['medium_11_20'] += 1
        elif length <= 35:
            dist['long_21_35'] += 1
        else:
            dist['very_long_36_plus'] += 1

    return SentenceProfile(
        avg_length_words=round(sum(lengths) / len(lengths), 2),
        median_length_words=sorted_lengths[median_idx],
        min_length=min(lengths),
        max_length=max(lengths),
        distribution=dist,
        lengths=lengths
    )


def analyze_lexical(text: str) -> LexicalProfile:
    words = tokenize_words(text)
    if not words:
        return LexicalProfile(0, 0, 0, 0, 0, {})

    word_counts = Counter(words)
    unique = len(word_counts)
    hapax = sum(1 for w, c in word_counts.items() if c == 1)

    original_words = re.findall(r'\b[a-zA-Z]+\b', text)
    length_dist = Counter(len(w) for w in original_words)

    return LexicalProfile(
        unique_words=unique,
        type_token_ratio=round(unique / len(words), 4),
        hapax_legomena=hapax,
        hapax_ratio=round(hapax / unique, 4) if unique else 0,
        avg_word_length=round(sum(len(w) for w in original_words) / len(original_words), 2),
        word_length_distribution=dict(sorted(length_dist.items()))
    )


# ---------- v0.2 seven-stratum raw features ----------


def analyze_arithmetica(text: str) -> ArithmeticaFeature:
    """
    Arithmetica raw feature: propositional density estimate.

    Uses a content-word heuristic as a CPIDR-lite approximation.
    Each content word is treated as roughly contributing 0.5 propositions
    (a rough calibration based on CPIDR-style ratios). This is a deterministic
    proxy, not a real propositional analysis.

    For precise measurements, use real CPIDR (Brown et al. 2008) via its
    Python port. This preprocessor is measurement-only; the density estimate
    is an anchor for semantic analysis, not a replacement.
    """
    words = tokenize_words(text)
    sentences = tokenize_sentences(text)

    if not words:
        return ArithmeticaFeature(
            total_propositions_est=0,
            density_per_word=0.0,
            density_per_sentence=0.0,
            method="content-word heuristic (CPIDR-lite proxy)",
            note="No words to analyze."
        )

    content_count = count_content_words(words)
    # Rough calibration: CPIDR-style density for typical prose is 0.3-0.5 prop/word;
    # content_words/total_words is typically 0.5-0.7. We scale by ~0.55 to match.
    prop_estimate = int(content_count * 0.55)
    density_per_word = round(prop_estimate / len(words), 4)
    density_per_sentence = round(prop_estimate / max(1, len(sentences)), 4)

    return ArithmeticaFeature(
        total_propositions_est=prop_estimate,
        density_per_word=density_per_word,
        density_per_sentence=density_per_sentence,
        method="content-word heuristic (CPIDR-lite proxy, not real CPIDR)",
        note=(
            "Typical ranges: expository prose 0.25-0.35, argumentative 0.25-0.30, "
            "lyric poetry 0.10-0.15, dense technical 0.35-0.50. "
            "For precision, use real CPIDR (Brown et al. 2008)."
        ),
    )


def analyze_musica(text: str) -> MusicaFeature:
    """
    Musica raw feature: local prosody profile.

    Measures sentence-length variance (a proxy for rhythmic variation),
    average syllables per word (metrical proxy), and count of
    candidate rhetorical figures. Does NOT compute K(prosody | Pi_local)
    directly; that requires a trained prosodic-expectation model.
    """
    sentences = tokenize_sentences(text)
    words = tokenize_words(text)

    if not sentences or not words:
        return MusicaFeature(
            sentence_length_mean=0.0,
            sentence_length_variance=0.0,
            sentence_length_cv=0.0,
            avg_syllables_per_word_est=0.0,
            rhetorical_figure_candidates=0,
            note="Insufficient text for Musica feature extraction.",
        )

    sentence_lengths = [len(tokenize_words(s)) for s in sentences]
    mean_length = sum(sentence_lengths) / len(sentence_lengths)

    variance = sum((l - mean_length) ** 2 for l in sentence_lengths) / len(sentence_lengths)
    cv = (variance ** 0.5 / mean_length) if mean_length > 0 else 0

    syllable_counts = [estimate_syllables(w) for w in words]
    avg_syllables = sum(syllable_counts) / len(syllable_counts) if syllable_counts else 0

    figure_count = detect_rhetorical_figure_candidates(sentences)

    return MusicaFeature(
        sentence_length_mean=round(mean_length, 2),
        sentence_length_variance=round(variance, 2),
        sentence_length_cv=round(cv, 4),
        avg_syllables_per_word_est=round(avg_syllables, 2),
        rhetorical_figure_candidates=figure_count,
        note=(
            "Raw features for local prosody. High CV + high figure count suggests "
            "marked Musica content (candidate for Selected or Original intensity). "
            "Low CV + zero figures suggests rhythmically flat prose (Stock). "
            "Interpretation against Pi_local (genre-conditional UID null) requires judgment."
        ),
    )


def analyze_astronomia(
    segments: list[SegmentStats],
) -> AstronomiaFeature:
    """
    Astronomia raw feature: global trajectory profile.

    Builds a per-segment information-intensity profile using
    content-word density as a proxy for local information content.
    Reports the shape of the profile across the document.

    This is a v0.2 placeholder. Real Wilmot-Keller-style trajectory
    measurement requires a hierarchical neural reader model, which is
    beyond the scope of a measurement-only preprocessor.
    """
    if not segments:
        return AstronomiaFeature(
            segment_count=0,
            intensity_profile=[],
            intensity_range=0.0,
            intensity_variance=0.0,
            peak_segment=0,
            trough_segment=0,
            note="No segments to analyze.",
        )

    # Per-segment intensity: content-word ratio normalized
    intensities = [seg.content_word_ratio for seg in segments]

    mean_intensity = sum(intensities) / len(intensities)
    variance = sum((i - mean_intensity) ** 2 for i in intensities) / len(intensities)

    peak_idx = intensities.index(max(intensities)) if intensities else 0
    trough_idx = intensities.index(min(intensities)) if intensities else 0

    return AstronomiaFeature(
        segment_count=len(segments),
        intensity_profile=[round(i, 4) for i in intensities],
        intensity_range=round(max(intensities) - min(intensities), 4) if intensities else 0,
        intensity_variance=round(variance, 4),
        peak_segment=peak_idx,
        trough_segment=trough_idx,
        note=(
            "Raw feature for global trajectory. High range + high variance suggest "
            "marked Astronomia content (peaks and troughs in information flow). "
            "Flat profile suggests uniform trajectory (Stock). "
            "This is a content-word-density proxy for what Wilmot-Keller 2020 measures "
            "via hierarchical neural reader models. True K(trajectory | T_global) "
            "requires trained genre-conditional reader models (v0.3+)."
        ),
    )


# ---------- Segmentation and per-segment rollup ----------


def segment_by_markdown_headers(text: str) -> list[tuple[str, int, int]]:
    segments = []
    lines = text.split('\n')
    current_label = 'preamble'
    current_start = 0
    pos = 0

    for line in lines:
        line_with_nl = line + '\n'
        header_match = re.match(r'^(#{1,6})\s+(.+?)\s*$', line)
        if header_match:
            if pos > current_start:
                segments.append((current_label, current_start, pos))
            current_label = header_match.group(2).strip()
            current_start = pos
        pos += len(line_with_nl)

    if pos > current_start:
        segments.append((current_label, current_start, min(pos, len(text))))

    if len(segments) == 1 and segments[0][0] == 'preamble':
        return [('(whole document)', 0, len(text))]

    return segments


def segment_equal_chunks(text: str, target_chunks: int = 5) -> list[tuple[str, int, int]]:
    total_len = len(text)
    if total_len == 0:
        return []

    chunk_size = max(1, total_len // target_chunks)
    segments = []
    pos = 0
    chunk_num = 1

    while pos < total_len and chunk_num <= target_chunks:
        end_target = min(pos + chunk_size, total_len)

        if chunk_num < target_chunks:
            next_break = text.find('\n\n', end_target)
            if next_break != -1 and next_break - end_target < chunk_size // 2:
                end_target = next_break + 2
        else:
            end_target = total_len

        segments.append((f'chunk {chunk_num}', pos, end_target))
        pos = end_target
        chunk_num += 1

    return segments


def analyze_segment(label: str, start: int, end: int, segment_text: str) -> SegmentStats:
    words = tokenize_words(segment_text)
    sentences = tokenize_sentences(segment_text)
    word_counts = Counter(words)
    unique = len(word_counts)
    hapax = sum(1 for _, c in word_counts.items() if c == 1)
    sentence_lengths = [len(tokenize_words(s)) for s in sentences]

    content_count = count_content_words(words)

    mean_sentence_length = (
        sum(sentence_lengths) / len(sentence_lengths) if sentence_lengths else 0
    )
    variance = (
        sum((l - mean_sentence_length) ** 2 for l in sentence_lengths)
        / len(sentence_lengths)
        if sentence_lengths
        else 0
    )

    return SegmentStats(
        label=label,
        start_offset=start,
        end_offset=end,
        bytes=len(segment_text.encode('utf-8')),
        words=len(words),
        sentences=len(sentences),
        unique_words=unique,
        type_token_ratio=round(unique / len(words), 4) if words else 0,
        hapax_ratio=round(hapax / unique, 4) if unique else 0,
        avg_sentence_length=round(mean_sentence_length, 2),
        sentence_length_variance=round(variance, 2),
        content_word_ratio=round(content_count / len(words), 4) if words else 0,
    )


def compute_local_rollup(segments: list[SegmentStats]) -> dict:
    if not segments:
        return {}

    hapax_ratios = [s.hapax_ratio for s in segments]
    ttrs = [s.type_token_ratio for s in segments]
    content_ratios = [s.content_word_ratio for s in segments]

    def stats(values: list[float]) -> dict:
        if not values:
            return {'median': 0, 'min': 0, 'max': 0, 'range': 0}
        sorted_vals = sorted(values)
        n = len(sorted_vals)
        median = (
            sorted_vals[n // 2]
            if n % 2 == 1
            else (sorted_vals[n // 2 - 1] + sorted_vals[n // 2]) / 2
        )
        return {
            'median': round(median, 4),
            'min': round(min(values), 4),
            'max': round(max(values), 4),
            'range': round(max(values) - min(values), 4),
        }

    return {
        'segment_count': len(segments),
        'hapax_ratio': stats(hapax_ratios),
        'type_token_ratio': stats(ttrs),
        'content_word_ratio': stats(content_ratios),
        'note': (
            'hapax_ratio is a LEXICAL novelty proxy, not semantic novelty density. '
            'content_word_ratio is an Arithmetica/Astronomia raw feature. '
            'High variance across segments flags uneven texts that need local analysis. '
            'Stratum intensity tagging (Stock/Implied/Selected/Original) requires semantic judgment.'
        ),
    }


# ---------- Candidate extraction ----------


def extract_candidates(text: str) -> list[Candidate]:
    candidates = []

    for match in re.finditer(r'["\u201C\u201D]([^"\u201C\u201D]{5,200})["\u201C\u201D]', text):
        start = max(0, match.start() - 30)
        end = min(len(text), match.end() + 30)
        candidates.append(Candidate(
            type='quoted_string',
            text=match.group(0),
            position=match.start(),
            context=text[start:end],
            note='May be citation, technical term, ironic usage, or emphasis; requires judgment'
        ))

    for match in re.finditer(r'https?://[^\s<>"{}|\\^`\[\]]+', text):
        candidates.append(Candidate(
            type='url',
            text=match.group(0),
            position=match.start(),
            context='',
            note='External reference, clearly retrievable (Memoria-substrate)'
        ))

    for match in re.finditer(r'\([A-Z][a-z]+(?:\s+(?:et al\.?|&|and)\s+[A-Z][a-z]+)?,?\s*\d{4}[a-z]?\)', text):
        candidates.append(Candidate(
            type='citation_pattern',
            text=match.group(0),
            position=match.start(),
            context='',
            note='Academic citation, likely Memoria-substrate pointer'
        ))

    for match in re.finditer(r'\[\d+\]', text):
        candidates.append(Candidate(
            type='citation_pattern',
            text=match.group(0),
            position=match.start(),
            context='',
            note='Numeric citation marker, likely Memoria-substrate pointer'
        ))

    words_lower = text.lower().split()
    seen_phrases = set()

    for n in range(3, 7):
        if n > len(words_lower):
            continue
        ngrams = [' '.join(words_lower[i:i + n]) for i in range(len(words_lower) - n + 1)]
        counts = Counter(ngrams)

        for phrase, count in counts.items():
            if count >= 2 and phrase not in seen_phrases:
                is_subset = any(phrase in p and phrase != p for p in seen_phrases)
                if not is_subset:
                    seen_phrases.add(phrase)
                    pos = text.lower().find(phrase)
                    candidates.append(Candidate(
                        type='repeated_phrase',
                        text=phrase,
                        position=pos,
                        context=f'Appears {count} times',
                        note=(
                            'May be redundancy OR intentional rhetorical device; requires judgment. '
                            'Repeated openings suggest anaphora (Musica); repeated structure '
                            'suggests isocolon (Musica); repeated content suggests Rhetorica emphasis '
                            'or redundancy.'
                        ),
                    ))

    return sorted(candidates, key=lambda x: x.position)


# ---------- Report assembly ----------


def generate_report(text: str, telos: str | None, substrate: str | None) -> dict:
    measurements = measure(text)
    structure = analyze_structure(text)
    sentences = analyze_sentences(text)
    lexical = analyze_lexical(text)
    candidates = extract_candidates(text)

    # v0.2 seven-stratum raw features
    arithmetica = analyze_arithmetica(text)
    musica = analyze_musica(text)

    # Segment the text
    seg_ranges = segment_by_markdown_headers(text)
    if len(seg_ranges) < 2:
        seg_ranges = segment_equal_chunks(text, target_chunks=5)

    segments = [
        analyze_segment(label, start, end, text[start:end])
        for label, start, end in seg_ranges
    ]
    rollup = compute_local_rollup(segments)

    astronomia = analyze_astronomia(segments)

    candidates_by_type: dict[str, list] = {}
    for c in candidates:
        candidates_by_type.setdefault(c.type, []).append(asdict(c))

    warnings = []
    if not telos:
        warnings.append(
            'No --telos provided. ISDA results without a stated telos compress '
            'toward an undefined target and are not interpretable. State the task '
            'this text is trying to achieve.'
        )
    if not substrate:
        warnings.append(
            'No --substrate provided. Arithmetica-density can be computed without a '
            'substrate, but Dialectica, Memoria-retrievability, and the intensity tags '
            '(Stock/Implied/Selected/Original) are meaningless without a named retrieval '
            'substrate (public / corpus / context). State which.'
        )

    return {
        '_meta': {
            'tool': 'ISDA Preprocessor',
            'framework': 'ISDA seven-stratum Nicomachan-Boethian',
            'philosophy': 'Measurement, not judgment. All intensity tags require human/LLM analysis.',
            'warning': (
                'Do NOT treat raw feature values as stratum classifications. '
                'Stock/Implied/Selected/Original tagging requires semantic judgment.'
            ),
            'telos': telos,
            'substrate': substrate,
            'warnings': warnings,
        },
        'measurements': asdict(measurements),
        'structure': {
            **asdict(structure),
            'paragraph_lengths': (
                structure.paragraph_lengths[:20]
                if len(structure.paragraph_lengths) > 20
                else structure.paragraph_lengths
            ),
            '_truncated': len(structure.paragraph_lengths) > 20,
        },
        'sentences': {
            **asdict(sentences),
            'lengths': sentences.lengths[:50] if len(sentences.lengths) > 50 else sentences.lengths,
            '_truncated': len(sentences.lengths) > 50,
        },
        'lexical': asdict(lexical),
        'stratum_raw_features': {
            'arithmetica': asdict(arithmetica),
            'musica': asdict(musica),
            'astronomia': asdict(astronomia),
            'note': (
                'Grammatica, Dialectica, Rhetorica, Geometria raw features are computable '
                'from the structure/sentences/lexical sections above. '
                'Arithmetica/Musica/Astronomia require dedicated feature extractors provided here. '
                'Intensity tagging (Stock/Implied/Selected/Original) is semantic and not provided.'
            ),
        },
        'local_density': {
            'segments': [asdict(s) for s in segments],
            'rollup': rollup,
        },
        'candidates_for_review': {
            'total_flagged': len(candidates),
            'by_type': {t: len(items) for t, items in candidates_by_type.items()},
            'items': candidates_by_type,
        },
    }


def main():
    parser = argparse.ArgumentParser(
        description='ISDA Preprocessor. Measurement, not judgment. Seven-stratum support.',
        epilog=(
            'Outputs raw data for semantic analysis. Does NOT classify strata. '
            '--telos and --substrate are recorded as metadata and emit warnings if missing.'
        )
    )
    parser.add_argument('file', nargs='?', help='Path to text file')
    parser.add_argument('--text', '-t', help='Inline text to analyze')
    parser.add_argument('--stdin', '-s', action='store_true', help='Read from stdin')
    parser.add_argument('--pretty', '-p', action='store_true', help='Pretty-print JSON')
    parser.add_argument(
        '--telos',
        help='The task/purpose the text is trying to achieve. '
             'Recorded in output metadata. Strongly recommended.'
    )
    parser.add_argument(
        '--substrate',
        help='The retrieval substrate against which Arithmetica/Dialectica are evaluated '
             '(public / corpus / context + name). Strongly recommended.'
    )

    args = parser.parse_args()

    if args.text:
        text = args.text
    elif args.stdin:
        text = sys.stdin.read()
    elif args.file:
        with open(args.file, 'r', encoding='utf-8') as f:
            text = f.read()
    else:
        parser.print_help()
        sys.exit(1)

    report = generate_report(text, args.telos, args.substrate)

    if args.pretty:
        print(json.dumps(report, indent=2))
    else:
        print(json.dumps(report))


if __name__ == '__main__':
    main()
