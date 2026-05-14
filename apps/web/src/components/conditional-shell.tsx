'use client';

import { usePathname } from 'next/navigation';
import { ActiveStudentPill } from './active-student-pill';
import { CounsellorSidebar } from './counsellor-sidebar';
import { StudentBottomNav } from './student-bottom-nav';

export function ConditionalShell({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const isStudent = pathname === '/student' || pathname.startsWith('/student/');
  // Pending / archived students see only the form or info screen — no nav.
  const isPendingStudentPage =
    pathname === '/student/onboarding' || pathname === '/student/archived';

  if (isStudent) {
    if (isPendingStudentPage) {
      return <main className="mx-auto w-full max-w-2xl px-4 py-6">{children}</main>;
    }
    return (
      <div className="min-h-screen pb-20 md:pb-0 md:flex">
        <main className="flex-1 mx-auto w-full max-w-2xl px-4 py-4 md:py-6">{children}</main>
        <StudentBottomNav />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen">
      <CounsellorSidebar />
      <div className="flex flex-1 flex-col overflow-hidden">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border bg-background px-6">
          <ActiveStudentPill />
        </div>
        <main className="flex-1 overflow-auto p-6">{children}</main>
      </div>
    </div>
  );
}
