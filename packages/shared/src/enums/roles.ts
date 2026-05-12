import { z } from 'zod';

export const USER_ROLES = ['student', 'counsellor', 'admin'] as const;
export const UserRoleSchema = z.enum(USER_ROLES);
export type UserRole = z.infer<typeof UserRoleSchema>;
