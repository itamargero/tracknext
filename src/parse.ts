import type {
  AttributionChannel, AttributionDecision, AttributionInput, AttributionTouch,
  ParseOptions, SourceRule, UtmParameters,
} from './types';

const UTM_FIELDS = [
  ['utm_source', 'source'], ['utm_medium', 'medium'], ['utm_campaign', 'campaign'],
  ['utm_term', 'term'], ['utm_content', 'content'], ['utm_id', 'id'],
  ['utm_source_platform', 'sourcePlatform'], ['utm_creative_format', 'creativeFormat'],
  ['utm_marketing_tactic', 'marketingTactic'],
] as const;

// Ordering is intentional: a Facebook decoration must not override a Google ad.
const CLICK_IDS = [
  ['gclid', 'google', 'cpc'], ['gbraid', 'google', 'cpc'], ['wbraid', 'google', 'cpc'],
  ['dclid', 'google', 'display'], ['msclkid', 'bing', 'cpc'],
  ['ttclid', 'tiktok', 'paid_social'], ['twclid', 'twitter', 'paid_social'],
  ['li_fat_id', 'linkedin', 'paid_social'], ['fbclid', 'facebook', 'social'],
] as const;

const AI_SOURCES: Readonly<Record<string, string>> = {
  'chatgpt.com': 'chatgpt', 'chat.openai.com': 'chatgpt', 'perplexity.ai': 'perplexity',
  'claude.ai': 'claude', 'gemini.google.com': 'gemini', 'bard.google.com': 'gemini',
  'copilot.microsoft.com': 'copilot', 'chat.deepseek.com': 'deepseek', 'grok.com': 'grok',
  'meta.ai': 'meta_ai', 'you.com': 'you', 'chat.mistral.ai': 'mistral', 'poe.com': 'poe',
};
const SOCIAL_SOURCES: Readonly<Record<string, string>> = {
  'facebook.com': 'facebook', 'fb.com': 'facebook', 'messenger.com': 'messenger',
  'instagram.com': 'instagram', 'threads.net': 'threads', 'threads.com': 'threads',
  'linkedin.com': 'linkedin', 'lnkd.in': 'linkedin', 'twitter.com': 'twitter', 'x.com': 'twitter',
  't.co': 'twitter', 'tiktok.com': 'tiktok', 'reddit.com': 'reddit', 'youtube.com': 'youtube',
  'youtu.be': 'youtube', 'pinterest.com': 'pinterest', 'pin.it': 'pinterest', 'quora.com': 'quora',
};
const SOCIAL_NAMES = new Set([...Object.values(SOCIAL_SOURCES), 'meta', 'fb', 'ig', 'x', 'snapchat']);
const IGNORED_REFERRERS = [
  'paypal.com', 'stripe.com', 'pay.google.com', 'accounts.google.com',
  'login.microsoftonline.com', 'appleid.apple.com', 'auth0.com',
];
// Match search front-ends only, never Gmail, Google Docs, or arbitrary suffixes.
const SEARCH_ENGINES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(?:www\.|images\.|news\.)?google\.[a-z]{2,3}(?:\.[a-z]{2})?$/, 'google'],
  [/^(?:www\.|[a-z]{2}\.)?bing\.com$/, 'bing'],
  [/^(?:www\.)?duckduckgo\.com$/, 'duckduckgo'],
  [/(?:^|\.)search\.yahoo\.(?:com|co\.jp)$/, 'yahoo'],
  [/^(?:www\.)?baidu\.com$/, 'baidu'], [/^(?:www\.)?ecosia\.org$/, 'ecosia'],
  [/^(?:www\.)?yandex\.(?:com|ru)$/, 'yandex'], [/^search\.brave\.com$/, 'brave'],
  [/^(?:www\.)?startpage\.com$/, 'startpage'],
];
const ANDROID_APPS: Readonly<Record<string, SourceRule>> = {
  'com.google.android.gm': { source: 'gmail', medium: 'email' },
  'com.google.android.googlequicksearchbox': { source: 'google', medium: 'organic' },
  'com.google.android.apps.bard': { source: 'gemini', medium: 'ai_referral' },
  'com.openai.chatgpt': { source: 'chatgpt', medium: 'ai_referral' },
  'com.facebook.katana': { source: 'facebook', medium: 'social' },
  'com.facebook.orca': { source: 'messenger', medium: 'social' },
  'com.instagram.android': { source: 'instagram', medium: 'social' },
  'com.linkedin.android': { source: 'linkedin', medium: 'social' },
  'com.twitter.android': { source: 'twitter', medium: 'social' },
  'com.zhiliaoapp.musically': { source: 'tiktok', medium: 'social' },
  'org.telegram.messenger': { source: 'telegram', medium: 'social' },
  'com.whatsapp': { source: 'whatsapp', medium: 'social' },
  'com.viber.voip': { source: 'viber', medium: 'social' },
  'com.slack': { source: 'slack', medium: 'referral' },
};

/** Domain comparisons always require a label boundary, preventing suffix spoofs. */
function normalizeHost(host: string): string {
  return host.trim().toLowerCase().replace(/\.+$/, '').replace(/^www\./, '');
}
function hostIs(host: string, domain: string): boolean {
  const normalized = normalizeHost(domain);
  return normalized.length > 0 && (host === normalized || host.endsWith(`.${normalized}`));
}
function tableSource(host: string, table: Readonly<Record<string, string>>): string | undefined {
  return Object.entries(table).find(([domain]) => hostIs(host, domain))?.[1];
}
function ownRule(table: Readonly<Record<string, SourceRule>>, key: string): SourceRule | undefined {
  return Object.entries(table).find(([name]) => name.toLowerCase() === key)?.[1];
}
function channelFor(source: string, medium: string): AttributionChannel {
  if (medium === 'ai_referral') return 'ai_referral';
  if (medium === 'email' || medium === 'e-mail') return 'email';
  if (['display', 'banner', 'cpm', 'programmatic'].includes(medium)) return 'display';
  if (['paid_social', 'paidsocial', 'paid-social'].includes(medium)) return 'paid_social';
  if (['cpc', 'ppc', 'paidsearch', 'paid_search', 'paid-search'].includes(medium)) {
    return SOCIAL_NAMES.has(source) ? 'paid_social' : 'paid_search';
  }
  if (['social', 'social-network', 'social_media', 'social-media'].includes(medium)) return 'social';
  if (medium === 'organic' || medium === 'organic_search') return 'organic_search';
  if (medium === 'referral' || medium === 'app') return 'referral';
  return 'unknown';
}

/** Classify one external arrival. This pure function never reads or writes storage. */
export function parseAttribution(input: AttributionInput, options: ParseOptions = {}): AttributionDecision {
  let url: URL;
  try {
    url = new URL(input.url);
    if (!['https:', 'http:'].includes(url.protocol)) return { kind: 'ignore', reason: 'invalid_request' };
  } catch {
    return { kind: 'ignore', reason: 'invalid_request' };
  }
  const timestamp = input.now ?? Date.now();
  if (!Number.isSafeInteger(timestamp) || timestamp < 0 || timestamp > 8_640_000_000_000_000) {
    return { kind: 'ignore', reason: 'invalid_request' };
  }

  let referrer: { host: string; app: boolean } | undefined;
  try {
    if (input.referrer) {
      const parsed = new URL(input.referrer);
      if (['http:', 'https:', 'android-app:'].includes(parsed.protocol) && parsed.hostname) {
        referrer = { host: normalizeHost(parsed.hostname), app: parsed.protocol === 'android-app:' };
      }
    }
  } catch { /* A missing or malformed referrer has no identifiable source. */ }

  // Exclude these journeys before reading UTMs: internal banners and checkout
  // callbacks must not manufacture marketing touches, even when decorated.
  if (referrer && !referrer.app) {
    const owned = [normalizeHost(url.hostname), ...(options.siteHosts ?? [])];
    if (owned.some((host) => hostIs(referrer.host, host))) return { kind: 'ignore', reason: 'internal' };
    if ([...IGNORED_REFERRERS, ...(options.ignoredReferrers ?? [])].some((host) => hostIs(referrer.host, host))) {
      return { kind: 'ignore', reason: 'excluded_referrer' };
    }
  }

  let fieldsTruncated = false;
  const configuredLimit = options.maxFieldLength ?? 150;
  const limit = Number.isInteger(configuredLimit) && configuredLimit > 0 ? configuredLimit : 150;
  function clean(value: string | undefined, maximum = limit): string | undefined {
    if (!value) return undefined;
    const sanitized = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
    if (sanitized.length <= maximum) return sanitized || undefined;
    fieldsTruncated = true;
    // Avoid leaving a split UTF-16 surrogate in a field that will be serialized.
    return sanitized.slice(0, maximum).replace(/[\ud800-\udbff]$/, '') || undefined;
  }
  const params = new Map<string, string>();
  url.searchParams.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (!params.has(lower)) params.set(lower, value);
  });
  const utm: UtmParameters = {};
  for (const [parameter, field] of UTM_FIELDS) {
    const value = clean(params.get(parameter));
    if (value) utm[field] = value;
  }
  const clickIds: Record<string, string> = {};
  let click: typeof CLICK_IDS[number] | undefined;
  for (const rule of CLICK_IDS) {
    const value = params.get(rule[0]);
    // Detection works without retaining raw click identifiers.
    if (!value?.replace(/[\u0000-\u001f\u007f]/g, '').trim()) continue;
    click ??= rule;
    if (options.captureClickIds) {
      const sanitized = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
      if (sanitized.length <= limit) clickIds[rule[0]] = sanitized;
      else fieldsTruncated = true; // A shortened click ID is unusable for conversion uploads.
    }
  }

  let refRule: SourceRule | undefined;
  if (referrer) {
    const custom = options.referrerRules?.find((rule) => hostIs(referrer.host, rule.hostname));
    if (custom) refRule = custom;
    else if (referrer.app) {
      refRule = ownRule(ANDROID_APPS, referrer.host) ?? { source: referrer.host, medium: 'app' };
    } else {
      const ai = tableSource(referrer.host, AI_SOURCES);
      const search = SEARCH_ENGINES.find(([pattern]) => pattern.test(referrer.host));
      const social = tableSource(referrer.host, SOCIAL_SOURCES);
      refRule = ai ? { source: ai, medium: 'ai_referral' }
        : search ? { source: search[1], medium: 'organic' }
        : social ? { source: social, medium: 'social' }
        : { source: referrer.host, medium: 'referral' };
    }
  }

  let source = 'direct';
  let medium = 'none';
  let channel: AttributionChannel = 'direct';
  let evidence: AttributionTouch['evidence'] = 'none';
  if (Object.keys(utm).length) {
    const rawSource = utm.source?.toLowerCase();
    const ai = rawSource ? Object.entries(AI_SOURCES).find(([domain]) => rawSource === domain)?.[1] : undefined;
    const defaultAlias: SourceRule | undefined = ai ? { source: ai, medium: 'ai_referral' }
      : rawSource === 'openai' ? { source: 'chatgpt', medium: 'ai_referral' }
      : rawSource && ['perplexity', 'copilot'].includes(rawSource) ? { source: rawSource, medium: 'ai_referral' } : undefined;
    const alias = rawSource ? ownRule(options.sourceAliases ?? {}, rawSource) ?? defaultAlias : undefined;
    source = clean(alias?.source)?.toLowerCase() ?? rawSource ?? '(not set)';
    medium = utm.medium?.toLowerCase() ?? clean(alias?.medium)?.toLowerCase() ?? '(not set)';
    channel = utm.medium ? channelFor(source, medium) : alias?.channel ?? channelFor(source, medium);
    evidence = 'utm';
  } else if (click) {
    source = click[0] === 'fbclid' && refRule?.source === 'instagram' ? 'instagram' : click[1];
    medium = click[2];
    channel = channelFor(source, medium);
    evidence = 'click_id';
  } else if (refRule) {
    source = clean(refRule.source)?.toLowerCase() ?? '(not set)';
    medium = clean(refRule.medium)?.toLowerCase() ?? '(not set)';
    channel = refRule.channel ?? channelFor(source, medium);
    evidence = 'referrer';
  }

  // Unicode lowercasing can expand a string (for example U+0130), so bound
  // normalized output too; otherwise our own stored cookie could fail validation.
  source = clean(source) ?? '(not set)';
  medium = clean(medium) ?? '(not set)';
  const touch: AttributionTouch = { source, medium, channel, evidence, timestamp };
  if (Object.keys(utm).length) touch.utm = utm;
  if (referrer) touch.referrer = clean(referrer.host);
  touch.landingPath = clean(url.pathname, 250);
  if (options.captureClickIds && Object.keys(clickIds).length) touch.clickIds = clickIds;
  if (fieldsTruncated) touch.fieldsTruncated = true;
  return { kind: evidence === 'none' ? 'direct' : 'touch', touch };
}
