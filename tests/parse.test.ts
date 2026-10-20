import { describe, expect, it } from 'vitest';
import { parseAttribution } from '../src/parse';
import type { AttributionTouch, ParseOptions } from '../src/types';
const now = 1_800_000_000_000;
function touch(query = '', options: ParseOptions = {}, referrer?: string): AttributionTouch {
  const result = parseAttribution({ url: `https://example.com/join?${query}`, referrer, now }, options);
  if (result.kind === 'ignore') throw new Error(`Unexpected ignore: ${result.reason}`);
  return result.touch;
}

describe('campaign parsing', () => {
  it('preserves sanitized UTM case separately from normalized attribution', () => {
    expect(touch('UTM_Source=NewsLetter&UTM_Medium=EMAIL&utm_campaign=Autumn%00Sale&utm_term=Shoes&utm_content=Banner&utm_id=ABC&utm_source_platform=CRM&utm_creative_format=Video&utm_marketing_tactic=Remarketing')).toMatchObject({
      source: 'newsletter', medium: 'email', channel: 'email', evidence: 'utm', timestamp: now,
      utm: { source: 'NewsLetter', medium: 'EMAIL', campaign: 'AutumnSale', term: 'Shoes', content: 'Banner', id: 'ABC', sourcePlatform: 'CRM', creativeFormat: 'Video', marketingTactic: 'Remarketing' },
    });
  });
  it.each(['campaign', 'term', 'content', 'id', 'source_platform', 'creative_format', 'marketing_tactic'])('recognizes partial utm_%s', (name) => {
    expect(touch(`utm_${name}=Present`)).toMatchObject({ source: '(not set)', medium: '(not set)', channel: 'unknown', evidence: 'utm' });
  });
  it('does not infer a conflicting click-ID medium for explicit campaigns', () => {
    expect(touch('utm_source=Newsletter&gclid=123')).toMatchObject({ source: 'newsletter', medium: '(not set)', channel: 'unknown' });
  });
  it('supports aliases and rejects inherited properties', () => {
    expect(touch('utm_source=chatgpt.com')).toMatchObject({ source: 'chatgpt', medium: 'ai_referral', channel: 'ai_referral' });
    expect(touch('utm_source=PARTNER', { sourceAliases: { partner: { source: 'my_partner', medium: 'email' } } })).toMatchObject({ source: 'my_partner', channel: 'email' });
    expect(touch('utm_source=toString')).toMatchObject({ source: 'tostring', medium: '(not set)' });
    const inherited = Object.create({ inherited: { source: 'bad', medium: 'email' } }) as Record<string, { source: string; medium: string }>;
    expect(touch('utm_source=inherited', { sourceAliases: inherited }).source).toBe('inherited');
  });
  it.each([
    ['google', 'cpc', 'paid_search'], ['facebook', 'cpc', 'paid_social'], ['newsletter', 'email', 'email'],
    ['anything', 'display', 'display'], ['google', 'organic', 'organic_search'], ['partner', 'referral', 'referral'],
    ['instagram', 'social', 'social'], ['custom', 'mystery', 'unknown'],
  ])('classifies %s / %s as %s', (source, medium, channel) => {
    expect(touch(`utm_source=${source}&utm_medium=${medium}`).channel).toBe(channel);
  });
});

describe('click IDs', () => {
  it.each([
    ['gclid', 'google', 'cpc'], ['gbraid', 'google', 'cpc'], ['wbraid', 'google', 'cpc'],
    ['dclid', 'google', 'display'], ['msclkid', 'bing', 'cpc'], ['ttclid', 'tiktok', 'paid_social'],
    ['twclid', 'twitter', 'paid_social'], ['li_fat_id', 'linkedin', 'paid_social'], ['fbclid', 'facebook', 'social'],
  ])('infers %s without retaining raw value by default', (param, source, medium) => {
    const result = touch(`${param}=secret`);
    expect(result).toMatchObject({ source, medium, evidence: 'click_id' });
    expect(result.clickIds).toBeUndefined();
  });
  it('stores identifiers only when enabled', () => {
    expect(touch('gclid=abc&fbclid=def', { captureClickIds: true }).clickIds).toEqual({ gclid: 'abc', fbclid: 'def' });
  });
  it('never lets a Facebook signal replace a selected Google click', () => {
    expect(touch('gclid=g&fbclid=f', {}, 'https://l.instagram.com/')).toMatchObject({ source: 'google', medium: 'cpc' });
    expect(touch('fbclid=f', {}, 'https://l.instagram.com/')).toMatchObject({ source: 'instagram', medium: 'social' });
    expect(touch('fbclid=f', {}, 'https://reddit.com/')).toMatchObject({ source: 'facebook', medium: 'social' });
  });
});

describe('referrers and exclusions', () => {
  it('ignores internal campaign banners before considering UTMs', () => {
    expect(parseAttribution({ url: 'https://example.com/?utm_source=banner', referrer: 'https://shop.example.com/', now }, { siteHosts: [' WWW.Example.COM. '] })).toEqual({ kind: 'ignore', reason: 'internal' });
    expect(parseAttribution({ url: 'https://example.com/?gclid=x', referrer: 'https://example.com/', now })).toEqual({ kind: 'ignore', reason: 'internal' });
  });
  it('requires domain boundaries', () => {
    expect(touch('', { siteHosts: ['example.com'] }, 'https://notexample.com/').source).toBe('notexample.com');
    expect(touch('', {}, 'https://facebook.com.attacker.test/').channel).toBe('referral');
  });
  it('ignores payment/auth and configured exclusions even with UTMs', () => {
    for (const referrer of ['https://checkout.stripe.com/', 'https://accounts.google.com/', 'https://login.microsoftonline.com/', 'https://pay.provider.test/']) {
      expect(parseAttribution({ url: 'https://example.com/?utm_source=return', referrer, now }, { ignoredReferrers: ['provider.test'] })).toEqual({ kind: 'ignore', reason: 'excluded_referrer' });
    }
  });
  it.each([
    ['https://www.google.com.ph/search?q=private', 'google', 'organic_search'],
    ['https://images.google.co.uk/', 'google', 'organic_search'], ['https://mail.google.com/', 'mail.google.com', 'referral'],
    ['https://docs.google.com/', 'docs.google.com', 'referral'], ['https://mail.yahoo.com/', 'mail.yahoo.com', 'referral'],
    ['https://uk.search.yahoo.com/', 'yahoo', 'organic_search'], ['https://chat.openai.com/', 'chatgpt', 'ai_referral'],
    ['https://l.facebook.com/', 'facebook', 'social'], ['android-app://com.google.android.gm/', 'gmail', 'email'],
    ['android-app://com.google.android.googlequicksearchbox/', 'google', 'organic_search'], ['android-app://com.openai.chatgpt/', 'chatgpt', 'ai_referral'],
  ])('classifies %s', (referrer, source, channel) => {
    expect(touch('', {}, referrer)).toMatchObject({ source, channel, evidence: 'referrer' });
  });
  it('allows custom rules before built-ins', () => {
    expect(touch('', { referrerRules: [{ hostname: 'Partner.test.', source: 'Partner', medium: 'EMAIL' }] }, 'https://go.partner.test/')).toMatchObject({ source: 'partner', medium: 'email', channel: 'email' });
  });
  it('uses direct only when no source can be identified', () => {
    expect(touch('', {}, 'javascript:bad')).toMatchObject({ source: 'direct', medium: 'none', evidence: 'none' });
  });
});

describe('safe input handling', () => {
  it('retains neither landing queries/fragments nor referrer paths', () => {
    const result = touch('email=secret@example.com#token', {}, 'https://partner.test/private?token=secret');
    expect(result).toMatchObject({ landingPath: '/join', referrer: 'partner.test' });
    expect(JSON.stringify(result)).not.toContain('secret');
  });
  it('caps field and path lengths and marks truncation', () => {
    expect(touch('utm_campaign=LongCampaign', { maxFieldLength: 4 })).toMatchObject({ utm: { campaign: 'Long' }, fieldsTruncated: true });
    const result = parseAttribution({ url: `https://example.com/${'x'.repeat(300)}`, now });
    expect(result.kind !== 'ignore' && result.touch.landingPath?.length).toBe(250);
  });
  it('omits oversized raw click identifiers instead of exporting invalid shortened IDs', () => {
    const result = touch(`gclid=${'x'.repeat(201)}`, { captureClickIds: true });
    expect(result.source).toBe('google');
    expect(result.clickIds).toBeUndefined();
    expect(result.fieldsTruncated).toBe(true);
  });
  it.each(['not a url', '/relative', 'javascript:alert(1)', 'file:///tmp/private'])('rejects invalid landing %s', (url) => {
    expect(parseAttribution({ url, now })).toEqual({ kind: 'ignore', reason: 'invalid_request' });
  });
  it.each([NaN, Infinity, -1])('rejects timestamp %s', (value) => {
    expect(parseAttribution({ url: 'https://example.com/', now: value })).toEqual({ kind: 'ignore', reason: 'invalid_request' });
  });
  it('accepts URL objects without mutating them', () => {
    const url = new URL('https://example.com/?utm_source=Partner');
    expect(parseAttribution({ url, now })).toMatchObject({ kind: 'touch' });
    expect(String(url)).toContain('utm_source=Partner');
  });
});
