// Prompt assembly shared by all three backends (SPEC §7.6). The system and
// user strings are byte-exact per the normative example in SPEC §6.4.

export interface GlossaryEntry {
  src: string;
  dst: string;
}

// Byte-exact system message from SPEC §6.4.
const SYSTEM_MESSAGE =
  "You translate comic dialogue to English. Keep each line short and natural. Preserve names exactly as written in the GLOSSARY. Keep the speaker's tone (casual, formal, shouting). Do not explain, annotate, or add quotes. Reply with exactly one line per input tag, in the same order, formatted 'N: translation'.";

const GLOSSARY_CAP = 50; // ≤ 50 entries (SPEC §7.6)
const PREVIOUS_CAP = 12; // last 12 committed strings
const PREVIOUS_CHAR_CAP = 60; // each truncated to 60 chars

export function buildSystemMessage(): string {
  return SYSTEM_MESSAGE;
}

export function buildUserMessage({
  strings,
  glossary,
  previous,
}: {
  strings: string[];
  glossary: GlossaryEntry[];
  previous: string[];
}): string {
  let out = 'GLOSSARY\n';
  out += glossary
    .slice(0, GLOSSARY_CAP)
    .map((entry) => `${entry.src}=${entry.dst}`)
    .join('\n');
  if (previous.length > 0) {
    out +=
      '\nCONTEXT (previous page)\n' +
      previous
        .slice(-PREVIOUS_CAP)
        .map((text, i) => `${i + 1}: ${text.slice(0, PREVIOUS_CHAR_CAP)}`)
        .join('\n');
  }
  out += '\nTRANSLATE\n';
  out += strings.map((text, i) => `${i + 1}: ${text}`).join('\n');
  return out;
}
