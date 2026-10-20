import { cookies } from 'next/headers';

export default async function ResultPage() {
  const value = (await cookies()).get('tracknext_example_receipt')?.value;
  return <main><h1>Example conversion</h1><p>The signup Server Action read this attribution on the server.</p><pre data-testid="conversion">{value ?? 'Submit the signup form first.'}</pre></main>;
}
