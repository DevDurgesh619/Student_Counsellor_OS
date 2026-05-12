import type { ResourceProps } from '@refinedev/core';

/**
 * Resource registry. Day-0 critical path is `students` and `tasks` — those
 * have hand-built screens. The rest expose list/show via Refine's defaults so
 * an operator can inspect rows without waiting for a custom UI.
 */
export const RESOURCES: ResourceProps[] = [
  {
    name: 'students',
    list: '/students',
    create: '/students/create',
    edit: '/students/edit/:id',
    show: '/students/show/:id',
    meta: { canDelete: true, label: 'Students' },
  },
  {
    name: 'counsellors',
    list: '/counsellors',
    meta: { label: 'Counsellors' },
  },
  {
    name: 'tasks',
    list: '/tasks',
    create: '/tasks/create',
    meta: { label: 'Tasks (per student)', canDelete: true },
  },
  {
    name: 'completions',
    list: '/completions',
    meta: { label: 'Completions' },
  },
  {
    name: 'artifacts',
    list: '/artifacts',
    meta: { label: 'Artifacts' },
  },
  {
    name: 'review_queue',
    list: '/review-queue',
    meta: { label: 'Review Queue' },
  },
];
