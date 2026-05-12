import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AuthContext } from './middleware/auth.js';
import { errorHandler } from './middleware/error-handler.js';
import { requestLogger } from './middleware/request-logger.js';
import { authMiddleware } from './middleware/auth.js';
import { authRoutes } from './routes/auth.js';
import { studentRoutes } from './routes/students.js';
import { counsellorRoutes } from './routes/counsellors.js';
import { taskRoutes } from './routes/tasks.js';
import { completionRoutes } from './routes/completions.js';
import { artifactRoutes } from './routes/artifacts.js';
import { meRoutes } from './routes/me.js';
import { counsellorScopedRoutes } from './routes/counsellor.js';
import { studentScopedRoutes } from './routes/student.js';
import {
  calendarCounsellorRoutes,
  calendarPublicRoutes,
} from './routes/calendar.js';
import { assistantRoutes } from './routes/assistant.js';
import {
  onboardingCounsellorRoutes,
  onboardingStudentRoutes,
} from './routes/onboarding.js';
import {
  sessionsCounsellorRoutes,
  sessionsInternalRoutes,
  spinachPublicRoutes,
} from './routes/sessions.js';
import {
  spinachAuthPublicRoutes,
  spinachCounsellorRoutes,
  spinachInternalRoutes,
} from './routes/spinach.js';

export type AppEnv = { Variables: { auth?: AuthContext; requestId: string } };

export function createApp() {
  const app = new Hono<AppEnv>();

  // ───── global middleware
  app.use('*', requestLogger);
  app.use('*', cors({ origin: '*', credentials: true }));
  app.onError(errorHandler);

  // ───── health
  app.get('/health', (c) => c.json({ status: 'ok' }));

  // ───── public auth routes (mount before authMiddleware so login is reachable)
  app.route('/auth', authRoutes);

  // ───── public calendar OAuth callback + Google webhook (also pre-auth)
  app.route('/', calendarPublicRoutes);

  // ───── public Spinach webhook (HMAC-verified, no Bearer auth) — Zapier fallback path
  app.route('/', spinachPublicRoutes);

  // ───── public Spinach OAuth callback (no Bearer auth)
  app.route('/', spinachAuthPublicRoutes);

  // ───── internal RPC (shared-secret-verified, no Bearer auth).
  // Mounted under /internal/ NOT /api/internal/ so the /api/* auth
  // middleware doesn't reject the request.
  app.route('/internal', sessionsInternalRoutes);
  app.route('/internal', spinachInternalRoutes);

  // ───── authenticated routes
  app.use('/api/*', authMiddleware);
  app.route('/api/me', meRoutes);
  app.route('/api/students', studentRoutes);
  app.route('/api/counsellors', counsellorRoutes);
  app.route('/api/tasks', taskRoutes);
  app.route('/api/completions', completionRoutes);
  app.route('/api/artifacts', artifactRoutes);
  app.route('/api/counsellor', counsellorScopedRoutes);
  app.route('/api/counsellor', calendarCounsellorRoutes);
  app.route('/api/counsellor/assistant', assistantRoutes);
  app.route('/api/counsellor', onboardingCounsellorRoutes);
  app.route('/api/counsellor', sessionsCounsellorRoutes);
  app.route('/api/counsellor', spinachCounsellorRoutes);
  app.route('/api/me', studentScopedRoutes);
  app.route('/api/me', onboardingStudentRoutes);

  return app;
}
