/**
 * SEOCoral fork: one entry point for search volume, shared by the keyword_volume tool and the
 * dashboard's web handler. Google Ads (free, the agency's own MCC) is preferred when configured;
 * DataForSEO is the fallback. SAC_VOLUME_PROVIDER=dataforseo forces DataForSEO when both are set.
 */
import type { DataForSeoClient } from './DataForSeoClient.js';
import type { GoogleAdsClient } from './GoogleAdsClient.js';

export type VolumeProvider = 'google-ads' | 'dataforseo';

export interface VolumeRow {
  keyword: string;
  searchVolume: number | null;
  cpc: number | null;
  competition: number | null;
  competitionLevel?: string | null;
  groupedUnder?: string;
  monthly?: Array<{ year: number; month: number; searches: number | null }>;
}

export interface VolumeResult { provider: VolumeProvider; keywords: VolumeRow[]; cached: boolean; cost: number }

export function pickVolumeProvider(ads: GoogleAdsClient | null, dfs: DataForSeoClient | null, env: NodeJS.ProcessEnv = process.env): VolumeProvider | null {
  const forced = (env.SAC_VOLUME_PROVIDER ?? '').trim().toLowerCase();
  if (forced === 'dataforseo' && dfs) return 'dataforseo';
  if (forced === 'google-ads' && ads) return 'google-ads';
  return ads ? 'google-ads' : dfs ? 'dataforseo' : null;
}

export async function keywordVolumes(
  ads: GoogleAdsClient | null, dfs: DataForSeoClient | null,
  keywords: string[], location?: string | number, languageCode?: string,
): Promise<VolumeResult> {
  const provider = pickVolumeProvider(ads, dfs);
  if (!provider) {
    throw new Error('No search-volume source configured: set GOOGLE_ADS_CREDENTIALS (free, Google Ads Keyword Planner - run scripts/google-ads-auth.mjs) or DATAFORSEO_USERNAME / DATAFORSEO_PASSWORD.');
  }
  if (provider === 'google-ads') {
    const r = await ads!.historicalMetrics(keywords, location, languageCode);
    return {
      provider, cached: r.cached, cost: 0,
      keywords: r.items.map(k => ({
        keyword: k.keyword, searchVolume: k.searchVolume, cpc: k.cpc, competition: k.competition,
        competitionLevel: k.competitionLevel, monthly: k.monthly, ...(k.groupedUnder ? { groupedUnder: k.groupedUnder } : {}),
      })),
    };
  }
  const r = await dfs!.searchVolume(keywords, location, languageCode);
  return {
    provider, cached: r.cached, cost: r.cost,
    keywords: (r.tasks[0]?.result ?? []).map((k: any) => ({ keyword: k.keyword, searchVolume: k.search_volume, cpc: k.cpc, competition: k.competition })),
  };
}
