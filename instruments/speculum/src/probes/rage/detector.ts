export interface DetectionResult {
  count: number;
  matches: Match[];
}

export interface Match {
  word: string;
  index: number;
  severity: Severity;
  group: string;
}

export type Severity = "mild" | "moderate" | "strong";

interface WordDef {
  word: string;
  severity: Severity;
  group: string;
}

const WORDLIST: WordDef[] = [
  { word: "fuck", severity: "strong", group: "fuck" },
  { word: "fucking", severity: "strong", group: "fuck" },
  { word: "fucked", severity: "strong", group: "fuck" },
  { word: "fucker", severity: "strong", group: "fuck" },
  { word: "fuckin", severity: "strong", group: "fuck" },
  { word: "fucks", severity: "strong", group: "fuck" },
  { word: "motherfucker", severity: "strong", group: "fuck" },
  { word: "motherfucking", severity: "strong", group: "fuck" },
  { word: "clusterfuck", severity: "strong", group: "fuck" },
  { word: "shit", severity: "strong", group: "shit" },
  { word: "shitty", severity: "strong", group: "shit" },
  { word: "shitting", severity: "strong", group: "shit" },
  { word: "shits", severity: "strong", group: "shit" },
  { word: "bullshit", severity: "strong", group: "shit" },
  { word: "horseshit", severity: "strong", group: "shit" },
  { word: "ass", severity: "moderate", group: "ass" },
  { word: "asses", severity: "moderate", group: "ass" },
  { word: "asshole", severity: "strong", group: "ass" },
  { word: "assholes", severity: "strong", group: "ass" },
  { word: "jackass", severity: "strong", group: "ass" },
  { word: "dumbass", severity: "strong", group: "ass" },
  { word: "damn", severity: "moderate", group: "damn" },
  { word: "damned", severity: "moderate", group: "damn" },
  { word: "damnit", severity: "moderate", group: "damn" },
  { word: "dammit", severity: "moderate", group: "damn" },
  { word: "goddamn", severity: "moderate", group: "damn" },
  { word: "bitch", severity: "strong", group: "bitch" },
  { word: "bitches", severity: "strong", group: "bitch" },
  { word: "bastard", severity: "strong", group: "bastard" },
  { word: "bastards", severity: "strong", group: "bastard" },
  { word: "piss", severity: "moderate", group: "piss" },
  { word: "pissed", severity: "moderate", group: "piss" },
  { word: "crap", severity: "moderate", group: "crap" },
  { word: "crappy", severity: "moderate", group: "crap" },
  { word: "hell", severity: "mild", group: "hell" },
  { word: "wtf", severity: "mild", group: "wtf" },
  { word: "stfu", severity: "mild", group: "stfu" },
  { word: "cunt", severity: "strong", group: "cunt" },
  { word: "cunts", severity: "strong", group: "cunt" },
];

function collapseWithMap(text: string): { collapsed: string; map: number[] } {
  const out: string[] = [];
  const map: number[] = [];
  let prev = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text.charAt(i);
    if (ch !== prev) {
      out.push(ch);
      map.push(i);
      prev = ch;
    }
  }
  return { collapsed: out.join(""), map };
}

function buildPattern(words: WordDef[]): RegExp {
  const sorted = [...words].sort((a, b) => b.word.length - a.word.length);
  return new RegExp(`\\b(${sorted.map((w) => w.word).join("|")})\\b`, "gi");
}

const DEFAULT_PATTERN = buildPattern(WORDLIST);
const WORD_MAP = new Map(WORDLIST.map((w) => [w.word.toLowerCase(), w]));

export function detect(text: string): DetectionResult {
  const matches: Match[] = [];
  const seen = new Set<number>();
  const lower = text.toLowerCase();

  DEFAULT_PATTERN.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = DEFAULT_PATTERN.exec(lower)) !== null) {
    if (seen.has(m.index)) continue;
    const word = m[0]!.toLowerCase();
    const entry = WORD_MAP.get(word);
    if (!entry) continue;
    seen.add(m.index);
    matches.push({ word, index: m.index, severity: entry.severity, group: entry.group });
  }

  const { collapsed, map } = collapseWithMap(lower);
  if (collapsed !== lower) {
    DEFAULT_PATTERN.lastIndex = 0;
    while ((m = DEFAULT_PATTERN.exec(collapsed)) !== null) {
      const origIndex = map[m.index] ?? m.index;
      if (seen.has(origIndex)) continue;
      const word = m[0]!.toLowerCase();
      const entry = WORD_MAP.get(word);
      if (!entry) continue;
      seen.add(origIndex);
      matches.push({ word, index: origIndex, severity: entry.severity, group: entry.group });
    }
  }

  return { count: matches.length, matches };
}
