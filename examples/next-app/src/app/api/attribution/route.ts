import { cookies } from 'next/headers';
import { attribution } from '@/lib/attribution';

export async function GET(): Promise<Response> {
  return Response.json(attribution.read(await cookies()), { headers: { 'Cache-Control': 'private, no-store' } });
}
