/** Raw, sanitized campaign values. Normalization never changes this evidence. */
export interface UtmParameters {
  source?: string;
  medium?: string;
  campaign?: string;
  term?: string;
  content?: string;
  id?: string;
  sourcePlatform?: string;
  creativeFormat?: string;
  marketingTactic?: string;
}

export type AttributionChannel =
  | 'direct' | 'organic_search' | 'paid_search' | 'paid_social'
  | 'social' | 'email' | 'referral' | 'ai_referral' | 'display' | 'unknown';

export interface AttributionTouch {
  /** Assigned when recorded; stable across cookie trimming and store recovery. */
  id?: string;
  source: string;
  medium: string;
  channel: AttributionChannel;
  evidence: 'utm' | 'click_id' | 'referrer' | 'none';
  timestamp: number;
  utm?: UtmParameters;
  /** Hostname only; never the referring URL's path or query. */
  referrer?: string;
  /** Path only; query strings and fragments are never retained. */
  landingPath?: string;
  /** Opt-in raw identifiers; these remain untrusted marketing input. */
  clickIds?: Record<string, string>;
  fieldsTruncated?: boolean;
}

export interface SourceRule {
  source: string;
  medium: string;
  channel?: AttributionChannel;
}

export interface ReferrerRule extends SourceRule {
  hostname: string;
}

export interface ParseOptions {
  /** Owned hostnames; an apex also includes its subdomains. */
  siteHosts?: readonly string[];
  /** Additional payment/authentication domains to ignore. */
  ignoredReferrers?: readonly string[];
  captureClickIds?: boolean;
  maxFieldLength?: number;
  sourceAliases?: Readonly<Record<string, SourceRule>>;
  referrerRules?: readonly ReferrerRule[];
}

export interface AttributionInput {
  url: URL | string;
  referrer?: string | null;
  now?: number;
}

export type AttributionDecision =
  | { kind: 'touch' | 'direct'; touch: AttributionTouch }
  | { kind: 'ignore'; reason: 'internal' | 'excluded_referrer' | 'invalid_request' };

/** State persisted in a cookie. The first element is retained during eviction. */
export interface AttributionState {
  version: 1;
  touches: AttributionTouch[];
  totalTouchCount: number;
  droppedTouchCount: number;
  expiresAt: number;
}

export interface AttributionSnapshot extends AttributionState {
  firstTouch: AttributionTouch;
  /** The latest recorded touch; direct return visits do not replace it. */
  lastTouch: AttributionTouch;
  lastNonDirectTouch: AttributionTouch | null;
  middleTouches: AttributionTouch[];
  historyTruncated: boolean;
}

export interface TrackerOptions extends ParseOptions {
  cookieName?: string;
  cookieDomain?: string;
  secure?: boolean;
  ttlDays?: number;
  maxTouches?: number;
  /** Budget for the serialized cookie including a conservative attribute allowance. */
  maxCookieBytes?: number;
  dedupeWindowSeconds?: number;
  /** Injectable clock; normally use the default Date.now. */
  now?: () => number;
}

export interface AttributionCookieOptions {
  name: string;
  path: '/';
  httpOnly: true;
  sameSite: 'lax';
  secure?: boolean;
  domain?: string;
}

export interface CaptureResult {
  snapshot: AttributionSnapshot | null;
  /** Present only when persistence changed. Already safe for a cookie value. */
  cookieValue?: string;
  reason: 'recorded' | 'ignored' | 'duplicate' | 'direct_return';
}

export interface AttributionTracker {
  readonly cookie: Readonly<AttributionCookieOptions>;
  capture(input: AttributionInput, previousCookie?: string): CaptureResult;
  read(raw?: string, now?: number): AttributionSnapshot | null;
}

/** Accepts Next.js cookies(), NextRequest.cookies, or a compatible server store. */
export interface CookieReader {
  get(name: string): { value: string } | undefined;
}

/** Implement update atomically (transaction/lock/CAS); a read-then-write is insufficient. */
export interface AttributionStore {
  read(visitorId: string): Promise<AttributionState | null>;
  update(
    visitorId: string,
    updater: (current: AttributionState | null) => AttributionState | null,
  ): Promise<AttributionState | null>;
  delete(visitorId: string): Promise<void>;
}

export interface StoredTrackerOptions extends TrackerOptions {
  store: AttributionStore;
  visitorCookieName?: string;
  storeTimeoutMs?: number;
  serverMaxTouches?: number;
  onStoreError?: (error: unknown, operation: 'read' | 'update' | 'delete') => void;
}

export interface StoredCaptureResult extends CaptureResult {
  visitorId?: string;
  persisted: boolean;
}

export interface StoredAttributionTracker {
  readonly cookie: Readonly<AttributionCookieOptions>;
  readonly visitorCookie: Readonly<AttributionCookieOptions>;
  capture(input: AttributionInput, previousCookie?: string, visitorId?: string): Promise<StoredCaptureResult>;
  read(raw?: string, visitorId?: string, now?: number): Promise<AttributionSnapshot | null>;
  delete(visitorId?: string): Promise<void>;
}
