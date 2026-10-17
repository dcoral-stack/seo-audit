/**
 * The ONE maintained list of AI crawler user-agent tokens, and how each is used. Every place that
 * names or groups AI bots (agent readiness, the dashboard's AI search panel) reads it from here, so
 * a design mock or a stale copy can never reclassify a bot.
 *
 * Grouping is by what the operator documents the agent is FOR:
 *   - search:   builds a search / answer index that cites pages, or fetches a page because a user
 *               asked an assistant to (blocking it removes you from that assistant's answers);
 *   - training: collects content for model training, or is a robots.txt control token for training
 *               use (blocking it does not affect live search citations).
 * GPTBot is OpenAI's TRAINING crawler; its search agents are OAI-SearchBot and ChatGPT-User.
 * Sources: each operator's published crawler documentation (OpenAI, Anthropic, Perplexity, Google,
 * Apple, Common Crawl, Meta, ByteDance, DuckDuckGo, Cohere).
 */
export type AiBotGroup = 'search' | 'training';
export interface AiBot { token: string; operator: string; group: AiBotGroup; note: string }

export const AI_BOTS: readonly AiBot[] = [
  { token: 'OAI-SearchBot', operator: 'OpenAI', group: 'search', note: 'ChatGPT search index' },
  { token: 'ChatGPT-User', operator: 'OpenAI', group: 'search', note: 'fetches a page a ChatGPT user asked for' },
  { token: 'Claude-SearchBot', operator: 'Anthropic', group: 'search', note: 'Claude search index' },
  { token: 'Claude-User', operator: 'Anthropic', group: 'search', note: 'fetches a page a Claude user asked for' },
  { token: 'PerplexityBot', operator: 'Perplexity', group: 'search', note: 'Perplexity search index' },
  { token: 'Perplexity-User', operator: 'Perplexity', group: 'search', note: 'fetches a page a Perplexity user asked for' },
  { token: 'DuckAssistBot', operator: 'DuckDuckGo', group: 'search', note: 'DuckAssist answers' },
  { token: 'GPTBot', operator: 'OpenAI', group: 'training', note: 'model training crawler' },
  { token: 'ClaudeBot', operator: 'Anthropic', group: 'training', note: 'model training crawler' },
  { token: 'Google-Extended', operator: 'Google', group: 'training', note: 'control token for Gemini training and grounding use (not a separate crawler)' },
  { token: 'Applebot-Extended', operator: 'Apple', group: 'training', note: 'control token for Apple model training use' },
  { token: 'CCBot', operator: 'Common Crawl', group: 'training', note: 'open web corpus widely used for training' },
  { token: 'Meta-ExternalAgent', operator: 'Meta', group: 'training', note: 'model training crawler' },
  { token: 'Bytespider', operator: 'ByteDance', group: 'training', note: 'model training crawler' },
  { token: 'cohere-training-data-crawler', operator: 'Cohere', group: 'training', note: 'model training crawler' },
];

/** Older or alternate tokens that still count as "the site names AI crawlers" in robots.txt. */
const LEGACY_TOKENS = ['Claude-Web', 'anthropic-ai', 'cohere-ai', 'Amazonbot'];

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** Matches any listed AI bot token (current or legacy) in robots.txt text. */
export const AI_BOT_PATTERN = new RegExp(`(${[...AI_BOTS.map(b => b.token), ...LEGACY_TOKENS].map(escapeRe).join('|')})`, 'i');
