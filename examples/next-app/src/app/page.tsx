import Link from 'next/link';

export default function HomePage() {
  return <main>
    <h1>TrackNext example</h1>
    <p>Open this page with marketing parameters, return with another campaign, then submit a signup. Only marketing arrivals are recorded.</p>
    <p>Try <code>/?utm_source=newsletter&amp;utm_medium=email&amp;utm_campaign=launch</code> in the address bar.</p>
    <p><Link href="/pricing">Visit pricing</Link> · <Link href="/signup">Sign up</Link></p>
    <p>Internal navigation and prefetching leave the marketing history unchanged. This example uses server code and first-party cookies without a tracking script.</p>
  </main>;
}
