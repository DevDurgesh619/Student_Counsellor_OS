'use client';

import { Refine } from '@refinedev/core';
import routerProvider from '@refinedev/nextjs-router';
import { authProvider } from '@/lib/auth-provider';
import { getDataProvider } from '@/lib/data-provider';
import { RESOURCES } from '@/lib/resources';

export function RefineShell({ children }: { children: React.ReactNode }) {
  return (
    <Refine
      authProvider={authProvider}
      dataProvider={getDataProvider()}
      routerProvider={routerProvider}
      resources={RESOURCES}
      options={{
        syncWithLocation: true,
        warnWhenUnsavedChanges: true,
        title: { text: 'WGC Admin', icon: <span>📚</span> },
      }}
    >
      {children}
    </Refine>
  );
}
