/**
 * Language-aware text primitives (SEOCoral fork): one place for folding, stop words and the
 * light stemmer, so every tokenizer in the audit treats Spanish (and English) the same way.
 *
 * The upstream tokenizers lower-cased and then dropped everything outside [a-z0-9], which cut
 * Spanish words in half ("diseño" -> "dise o", "autónomos" -> "aut nomos"). Here text is first
 * FOLDED: Unicode-lower-cased, NFD-decomposed and stripped of combining marks, so "Diseño",
 * "diseno" and "DISEÑO" all become "diseno" - which is also how people type queries without
 * accents. ß/æ/œ/ø get explicit ASCII spellings because NFD leaves them alone.
 *
 * Stop words are the UNION of English and Spanish (plus a few Catalan function words), so a
 * mixed-language property needs no configuration. The union is safe: no Spanish stop word is a
 * meaningful English search term and vice versa (they are all articles, prepositions,
 * pronouns and auxiliaries).
 *
 * `stem` is a deliberately LIGHT stemmer (plural folding only, after Savoy's light Spanish
 * stemmer): "gestorías" -> "gestoria", "autónomos" -> "autonomo", "gestores" -> "gestor",
 * "luces" -> "luz", "habitaciones" -> "habitacion", "pages" -> "page". It never strips gender or
 * verb endings, which would merge distinct search intents ("abogado" vs "abogada" stay apart).
 */

const EXTRA: Record<string, string> = { ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', đ: 'd', ł: 'l', ı: 'i' };

/** Lower-case, strip accents/diacritics (ñ -> n, ç -> c, ü -> u). Keeps every other character. */
export function fold(s: string | null | undefined): string {
  if (!s) return '';
  return s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[ßæœøđłı]/g, ch => EXTRA[ch] ?? ch);
}

/** Folded alphanumeric words, split on anything else. No filtering. */
export function words(s: string | null | undefined): string[] {
  return fold(s).split(/[^a-z0-9]+/).filter(Boolean);
}

/** Folded text with every non-alphanumeric run collapsed away ("Peluquería López" -> "peluquerialopez"). */
export function compact(s: string | null | undefined): string {
  return fold(s).replace(/[^a-z0-9]+/g, '');
}

export const STOP_EN = ['the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'with', 'your', 'you', 'is', 'are', 'best', 'how', 'what', 'vs', 'why', 'can', 'my', 'i', 'it'];

// Spanish function words (already folded: "qué" -> "que", "cuál" -> "cual"). "mejor"/"mejores"
// mirror the upstream treatment of "best": a modifier, not a topic.
export const STOP_ES = [
  'el', 'la', 'los', 'las', 'lo', 'un', 'una', 'unos', 'unas', 'al', 'del', 'de', 'en', 'y', 'e', 'o', 'u', 'ni',
  'a', 'ante', 'con', 'contra', 'desde', 'hacia', 'hasta', 'para', 'por', 'segun', 'sin', 'sobre', 'tras', 'entre',
  'que', 'cual', 'cuales', 'como', 'cuando', 'donde', 'quien', 'quienes', 'cuanto', 'cuanta', 'cuantos', 'cuantas', 'porque',
  'es', 'son', 'ser', 'esta', 'estan', 'hay', 'se', 'su', 'sus', 'mi', 'mis', 'tu', 'tus', 'te', 'me', 'nos', 'le', 'les',
  'este', 'esta', 'estos', 'estas', 'ese', 'esa', 'esos', 'esas', 'muy', 'mas', 'pero', 'si', 'no', 'ya', 'tambien',
  'mejor', 'mejores', 'vs',
];

// Catalan function words that are not already covered and never a topic on their own.
export const STOP_CA = ['els', 'les', 'amb', 'per', 'dels', 'als', 'una', 'uns', 'unes', 'i', 'que', 'com', 'on', 'millor', 'millors'];

/** Union stop-word set used by every tokenizer. */
export const STOP = new Set<string>([...STOP_EN, ...STOP_ES, ...STOP_CA]);

const VOWEL = /[aeiou]/;

/**
 * Light plural-folding stemmer for Spanish and English tokens (input must already be folded).
 * It maps singular and plural to the SAME key rather than to a dictionary word, so it only has to
 * be consistent, not pretty (stems are compared, never shown):
 *   1. drop a plural "s" (not "-ss", "-is", "-us": "analysis", "campus", "crisis" stay whole);
 *   2. drop a final "e" after a consonant, so "-es" plurals meet their singular
 *      ("gestores" -> "gestore" -> "gestor" = "gestor"; "calles"/"calle" -> "call"; "stores"/"store" -> "stor");
 *   3. final "z" -> "c", so "luz"/"luces" -> "luc" and "vez"/"veces" -> "vec".
 * Gender and verb endings are never touched ("abogado" and "abogada" stay distinct intents).
 */
export function stem(w: string): string {
  if (w.length < 3 || /\d/.test(w)) return w;
  let s = w;
  if (s.length >= 4) {
    const pen = s[s.length - 2];
    if (s.endsWith('s') && pen !== 's' && pen !== 'i' && pen !== 'u') s = s.slice(0, -1);
    if (s.length > 3 && s.endsWith('e') && !VOWEL.test(s[s.length - 2])) s = s.slice(0, -1);
  }
  if (s.endsWith('z')) s = s.slice(0, -1) + 'c';
  return s;
}

/** Folded, stop-word-free words of at least `min` characters (default 2). Not stemmed. */
export function terms(s: string | null | undefined, min = 2): string[] {
  return words(s).filter(t => t.length >= min && !STOP.has(t));
}

/** Folded, stop-word-free, plural-stemmed tokens: the input to clustering and similarity. */
export function tokens(s: string | null | undefined, min = 2): string[] {
  return terms(s, min).map(stem);
}

/** Accept-Language sent by the crawler and recon fetches. Override with SAC_ACCEPT_LANGUAGE. */
export function acceptLanguage(): string {
  const v = (process.env.SAC_ACCEPT_LANGUAGE ?? '').trim();
  return v || 'es-ES,es;q=0.9,en;q=0.7';
}

type SqlFnHost = { function(name: string, opts: { deterministic: boolean }, fn: (s: unknown) => string): unknown };
const registered = new WeakSet<object>();

/**
 * Register `sac_fold(text)` on a SQLite handle (once per connection), so SQL can compare folded
 * query text with folded terms: `sac_fold(query) LIKE '%diseno%'` matches "diseño" and "diseno".
 * SQLite's own LOWER()/LIKE only fold ASCII.
 */
export function registerTextFunctions(db: SqlFnHost): void {
  if (registered.has(db)) return;
  db.function('sac_fold', { deterministic: true }, (s: unknown) => fold(typeof s === 'string' ? s : s == null ? '' : String(s)));
  registered.add(db);
}
