# SEOCoral Audit: fork en español de SEO Audit Console

Fork de [houtini-ai/seo-audit](https://github.com/houtini-ai/seo-audit) (Richard Baxter / Houtini,
licencia Apache 2.0), adaptado para auditar webs de clientes en español. El código original sigue
bajo su licencia; los cambios de este fork están marcados en el código con el comentario
`SEOCoral fork`.

## Qué cambia respecto al original

### 1. Capa de idioma (`src/core/text.ts`)
El original pasaba todo a minúsculas y eliminaba cualquier carácter fuera de `a-z0-9`, así que
partía las palabras españolas ("diseño" se convertía en "dise" + "o"). Ahora:

- **Normalización de acentos:** "Diseño", "diseno" y "DISEÑO" son la misma palabra (`diseno`). También ü, ç y ß.
- **Stopwords en inglés, español y catalán** (unión de las tres listas, sin configuración). "mejor/mejores" se tratan como "best": modificadores, no temas.
- **Stemming ligero de plurales:** "gestorías" = "gestoría", "gestores" = "gestor", "luces" = "luz", "habitaciones" = "habitación". No toca género ("abogado" ≠ "abogada") ni verbos.

Se aplica en todos los tokenizadores: canibalización (por query y por clúster), query ausente en el
title, anchor text, content gaps, oportunidades, arquitectura de contenidos, lista de keywords,
market sizing, triage de 404 y detección de marca.

- **Marca con acentos:** "peluquería lópez" ya cuenta como búsqueda de marca de `peluquerialopez.es`.
- **SQL:** se registra `sac_fold()` en SQLite para que las comparaciones `LIKE` agrupen "diseño cocinas" y "diseno cocinas".

### 2. Modelos multilingües
| Uso | Original | Fork |
|---|---|---|
| Duplicados semánticos (`find_duplicates`) | `Xenova/all-MiniLM-L6-v2` (inglés) | `Xenova/paraphrase-multilingual-MiniLM-L12-v2` |
| Puntuación de pasajes (`score_passages`, check `weak-passage-answer`) | `Xenova/ms-marco-MiniLM-L-6-v2` (inglés) | `cross-encoder/mmarco-mMiniLMv2-L12-H384-v1` |

**Pendiente de calibrar:** el umbral de "pasaje débil" (3) se calibró en el original para el modelo
inglés. Con el modelo multilingüe hay que revisarlo con páginas reales y ajustarlo con
`SAC_WEAK_PASSAGE_THRESHOLD`. Es un check de juicio (etiqueta N), no determinista.

### 3. Mercado por defecto: España
- DataForSEO: ubicación **2724 (España)** e idioma **es** (antes 2840 Estados Unidos, en).
- Google News: `hl=es-ES`, `gl=ES`. Etiquetas de Wikidata en español.
- El crawler, cuando cae al modo navegador, envía `Accept-Language: es-ES`. El modo bot sigue sin
  `Accept-Language`, igual que Googlebot.
- User agent propio: `seocoral-audit/0.1 (+https://seocoral.com; based on houtini-ai/seo-audit)`.

## Variables de entorno nuevas

| Variable | Por defecto | Para qué |
|---|---|---|
| `SAC_DEFAULT_LOCATION` | `2724` | Código o nombre de ubicación DataForSEO (p. ej. `2484` México) |
| `SAC_DEFAULT_LANGUAGE` | `es` | Idioma por defecto (`ca` catalán, `en` inglés) |
| `SAC_DEFAULT_COUNTRY` | `ES` | País para Google News |
| `SAC_ACCEPT_LANGUAGE` | `es-ES,es;q=0.9,en;q=0.7` | Cabecera del modo navegador |
| `SAC_EMBED_MODEL` | modelo multilingüe | Volver al inglés para webs solo en inglés |
| `SAC_RERANK_MODEL` | modelo multilingüe | Ídem |
| `SAC_WEAK_PASSAGE_THRESHOLD` | `3` | Umbral del check `weak-passage-answer` |

Cualquier herramienta sigue aceptando `location` y `languageCode` por llamada.

## Tests
`npm test` ejecuta toda la batería original más `scripts/probe-spanish.mjs` (33 comprobaciones con
casos en español: acentos, stopwords, plurales, marca con tilde, canibalización con y sin acento,
valores por defecto).

## Próximas fases
1. Informe y textos de los fixes en español, con marca SEOCoral.
2. Checks del mercado español: aviso legal y cookies (LSSI/RGPD), NAP y `LocalBusiness`, hreflang es-ES/es-MX/ca-ES.
3. Integración con el conector propio GSC + GA4.
