'use client';

import { usePathname } from 'next/navigation';
import { Sidebar } from './sidebar';

/** Hide the sidebar on /login routes so the sign-in screen isn't squashed. */
export function ConditionalSidebar() {
  const pathname = usePathname();
  if (pathname.startsWith('/login')) return null;
  return <Sidebar />;
}
