import type { Pool, PoolClient } from 'pg';
import type { AttributionState, AttributionStore } from 'tracknext';

/**
 * Optional node-postgres recipe, copied into the host application. pg is NOT a
 * TrackNext runtime dependency. Prisma/Drizzle adapters can implement the same
 * interface using their transaction APIs and this same per-visitor lock.
 */
export function createPostgresStore(pool: Pool): AttributionStore {
  async function locked<T>(visitorId: string, operation: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    let discardConnection = false;
    try {
      await client.query('BEGIN');
      // Lock the logical visitor, not just an existing row: first arrivals race too.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [visitorId]);
      const result = await operation(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { discardConnection = true; }
      throw error;
    } finally {
      client.release(discardConnection);
    }
  }

  return {
    async read(visitorId) {
      const result = await pool.query<{ state: AttributionState }>(
        'SELECT state FROM tracknext_attribution WHERE visitor_id = $1 AND expires_at > NOW()',
        [visitorId],
      );
      // TrackNext validates/rebuilds the JSON before exposing a snapshot.
      return result.rows[0]?.state ?? null;
    },
    async update(visitorId, updater) {
      return locked(visitorId, async (client) => {
        const existing = await client.query<{ state: AttributionState }>(
          'SELECT state FROM tracknext_attribution WHERE visitor_id = $1 AND expires_at > NOW()',
          [visitorId],
        );
        const next = updater(existing.rows[0]?.state ?? null);
        if (next === null) {
          await client.query('DELETE FROM tracknext_attribution WHERE visitor_id = $1', [visitorId]);
        } else {
          await client.query(
            `INSERT INTO tracknext_attribution (visitor_id, state, expires_at) VALUES ($1, $2::jsonb, $3)
             ON CONFLICT (visitor_id) DO UPDATE SET state = EXCLUDED.state, expires_at = EXCLUDED.expires_at`,
            [visitorId, JSON.stringify(next), new Date(next.expiresAt)],
          );
        }
        return next;
      });
    },
    async delete(visitorId) {
      await locked(visitorId, async (client) => {
        await client.query('DELETE FROM tracknext_attribution WHERE visitor_id = $1', [visitorId]);
      });
    },
  };
}
