import type { Metadata } from 'next';
import { PRIVATE_ROBOTS } from '@/seo/config';

/**
 * Everything under /checkout is refused to crawlers, here rather than on each
 * page.
 *
 * Putting it on the layout means a page ADDED LATER inherits the refusal
 * instead of needing to remember it — and forgetting it on one checkout page is
 * exactly the kind of omission nobody notices until an order with a customer’s details shows
 * up in a search result.
 *
 * This is not the access control. Authorisation is `requireActor` on each page
 * and Row-Level Security beneath it; a crawler is refused the DATA regardless.
 * This only keeps the URLs out of an index.
 */
export const metadata: Metadata = {
  robots: PRIVATE_ROBOTS,
};

export default function CheckoutLayout({ children }: { children: React.ReactNode }) {
  return children;
}
