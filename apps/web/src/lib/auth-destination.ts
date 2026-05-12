export type Me = {
  role: 'counsellor' | 'student';
  state?: string;
};

const COUNSELLOR_PREFIXES = [
  '/students',
  '/queue',
  '/settings',
  '/onboarding',
  '/sessions',
  '/todos',
  '/spinach-inbox',
];

function isCounsellorRoute(path: string): boolean {
  return COUNSELLOR_PREFIXES.some((p) => path === p || path.startsWith(p + '/'));
}

function isStudentRoute(path: string): boolean {
  return path === '/student' || path.startsWith('/student/');
}

/**
 * Where should this user land right now? Used by:
 *   - /auth/callback/route.ts (post sign-in)
 *   - app/layout.tsx server gate (every protected request)
 *
 * Returns null when the current path is already allowed for this role+state.
 */
export function resolveDestination(me: Me, currentPath: string, next?: string | null): string | null {
  const path = currentPath.length > 1 ? currentPath.replace(/\/+$/, '') : currentPath;

  if (me.role === 'counsellor') {
    const allowedNext =
      next &&
      (next === '/students' ||
        next.startsWith('/students/') ||
        next === '/queue' ||
        next.startsWith('/queue/') ||
        next === '/settings' ||
        next === '/todos' ||
        next.startsWith('/sessions/') ||
        next.startsWith('/spinach-inbox/'));
    if (path === '/') return allowedNext ? next! : '/students';
    if (isStudentRoute(path)) return '/students';
    return null;
  }

  // Student.
  if (me.state === 'active') {
    const allowedNext =
      next &&
      (next === '/student' ||
        next.startsWith('/student/today') ||
        next.startsWith('/student/tasks/') ||
        next.startsWith('/student/requests') ||
        next.startsWith('/student/reports') ||
        next.startsWith('/student/settings'));
    if (path === '/') return allowedNext ? next! : '/student/today';
    if (isCounsellorRoute(path)) return '/student/today';
    return null;
  }

  if (me.state === 'archived') {
    if (path === '/student/archived') return null;
    return '/student/archived';
  }

  // pending_onboarding / pending_review — only the form is allowed.
  if (path === '/student/onboarding') return null;
  return '/student/onboarding';
}
