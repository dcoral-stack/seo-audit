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

### 4. Volúmenes de búsqueda gratis con Google Ads (Keyword Planner)
`keyword_volume` usa la API de Google Ads con el MCC de la agencia. Nueva herramienta `keyword_ideas`:
ideas de keywords desde palabras semilla, una URL o un dominio entero, con volumen, competencia y CPC.
Las respuestas traen tendencia y mes pico; la serie de 12 meses solo con `includeMonthly`.

- Es la misma fuente que revende DataForSEO. Con una cuenta cliente con gasto, los volúmenes son exactos; si no, Google da rangos redondeados.
- Google agrupa variantes cercanas (plurales, tildes): una keyword agrupada sale con `groupedUnder`.
- Caché de 30 días: repetir una consulta no gasta operaciones de la API.
- Requisitos: developer token con acceso **Basic** (Explorer no permite Keyword Planner), cliente OAuth de escritorio y la API de Google Ads habilitada en Google Cloud.

Configuración: `node scripts/google-ads-auth.mjs <client_secret.json>`. Pide el developer token y el
ID del MCC, abre el navegador para autorizar, guarda `credenciales/google-ads.json`, hace una
consulta real de prueba y lo añade a la configuración de Claude Desktop. `node scripts/google-ads-check.mjs` repite la prueba y la conexión sin volver a autorizar (por ejemplo, cuando aprueban el acceso Basic).

### 5. Sin DataForSEO ni Majestic
Eliminados por ser de pago. Se han retirado 20 herramientas que dependían de ellos (ranked_keywords,
serp_features, domain_visibility, competitors_domain, top_pages, page_intersection, topic_gaps,
market_sizing, search_intent, page_lighthouse, related_terms, youtube_discovery, topic_trend,
trend_categories, recon_*, pull_backlinks, link_intersect, track_ranks), las pestañas Links y Content
research del panel, las tarjetas de market sizing y SERP features, y los enlaces de afiliado.
`news_discovery` queda solo con Google News (gratis). Los módulos internos siguen en el código pero
nunca se instancian, así que ninguna ruta puede llamar a esas APIs.

### 6. Keywords por cliente y pestaña Keywords
`keyword_volume` y `keyword_ideas` con `siteUrl` guardan las keywords en la base de datos del cliente
(tabla `keyword_planner`). Nueva herramienta `keyword_demand` y nueva pestaña **Keywords** en el panel
y en `export_report`: cada keyword con volumen, competencia, CPC y tendencia, cruzada con Search
Console (últimos 90 días, tildes y plurales agrupados): página que muestra Google, posición, clics y
estado (top 3, página 1, 11-20, >20, hueco). Para los huecos sugiere la página de la web que mejor
encaja, usando solo las palabras que distinguen una página de otra; si ninguna encaja: "Crear
contenido". Exportable a CSV.

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
| `GOOGLE_ADS_CREDENTIALS` | — | JSON de Google Ads (lo escribe `scripts/google-ads-auth.mjs`) |
| `GOOGLE_ADS_CUSTOMER_ID` | el MCC | Cuenta con la que se consulta el planificador |
| `GOOGLE_ADS_API_VERSION` | `v26` | Versión de la API de Google Ads |
| `GOOGLE_ADS_CACHE_DAYS` | `30` | Días de caché |

Cualquier herramienta sigue aceptando `location` y `languageCode` por llamada.

## Tests
`npm test` ejecuta toda la batería original más `scripts/probe-spanish.mjs` (33 comprobaciones con
casos en español: acentos, stopwords, plurales, marca con tilde, canibalización con y sin acento,
valores por defecto).

`scripts/probe-keyword-demand.mjs`: 14 comprobaciones del cruce keywords × Search Console × crawl.

`scripts/probe-google-ads.mjs`: 34 comprobaciones contra una API simulada (forma de las peticiones,
parseo, variantes, lotes, caché, errores y elección de proveedor).

## Próximas fases
1. Informe y textos de los fixes en español, con marca SEOCoral.
2. Checks del mercado español: aviso legal y cookies (LSSI/RGPD), NAP y `LocalBusiness`, hreflang es-ES/es-MX/ca-ES.
3. Integración con el conector propio GSC + GA4.
