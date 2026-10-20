import { attribution } from '@/lib/attribution';

export const proxy = attribution.proxy;

// Next.js needs a literal matcher for static build-time analysis.
export const config = {
  matcher: ['/((?!api(?:/|$)|_next(?:/|$)|favicon\\.ico$|robots\\.txt$|sitemap\\.xml$).*)'],
};
