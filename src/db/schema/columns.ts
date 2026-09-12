import { customType, timestamp } from 'drizzle-orm/pg-core';

/** Case-insensitive text, used for email so `A@x.com` and `a@x.com` collide. */
export const citext = customType<{ data: string }>({
  dataType() {
    return 'citext';
  },
});

/**
 * All timestamps are stored WITH TIME ZONE in UTC. Accounting boundaries are
 * computed in Asia/Damascus by `src/lib/time/period.ts` — never by the
 * database — so the stored value stays unambiguous.
 */
export const utcTimestamp = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

export const createdAt = () => utcTimestamp('created_at').notNull().defaultNow();
export const updatedAt = () => utcTimestamp('updated_at').notNull().defaultNow();
