import { NextResponse } from 'next/server';
import { getSql } from '@/db';
import { serverEnv } from '@/lib/config/env';
import { logger } from '@/lib/logger';

export const dynamic = 'force-dynamic';

/**
 * Liveness and readiness probe.
 *
 * It reports the truth: if the database is unreachable the endpoint says so
 * and returns 503, rather than reporting a healthy app that cannot serve a
 * single order. No configuration values are echoed — only their presence.
 */
export async function GET() {
  const checks: Record<string, 'up' | 'down'> = { app: 'up', config: 'down', database: 'down' };

  try {
    serverEnv();
    checks.config = 'up';
  } catch (error) {
    logger.error({ err: error }, 'Environment validation failed during health check');
  }

  if (checks.config === 'up') {
    try {
      await getSql()`SELECT 1`;
      checks.database = 'up';
    } catch (error) {
      logger.error({ err: error }, 'Database unreachable during health check');
    }
  }

  const healthy = Object.values(checks).every((value) => value === 'up');

  return NextResponse.json(
    { status: healthy ? 'healthy' : 'degraded', checks, timestamp: new Date().toISOString() },
    { status: healthy ? 200 : 503 },
  );
}
