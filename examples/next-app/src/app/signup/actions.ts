'use server';

import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { attribution } from '@/lib/attribution';

export async function registerLead(formData: FormData): Promise<void> {
  const email = formData.get('email');
  if (typeof email !== 'string' || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new Error('Enter a valid email address');
  }
  const store = await cookies();
  const snapshot = attribution.read(store);
  // Replace this demo receipt with your database write containing the snapshot.
  // Only a small summary goes into this short-lived cookie, not the full journey.
  store.set('tracknext_example_receipt', JSON.stringify({
    email,
    first: snapshot?.firstTouch.source ?? null,
    middle: snapshot?.middleTouches.map((touch) => touch.source) ?? [],
    last: snapshot?.lastNonDirectTouch?.source ?? null,
    count: snapshot?.totalTouchCount ?? 0,
  }), { httpOnly: true, sameSite: 'lax', path: '/result', maxAge: 60 });
  redirect('/result');
}
