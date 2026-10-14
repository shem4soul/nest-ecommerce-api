import { ExecutionContext, SetMetadata, createParamDecorator } from '@nestjs/common';

export type Role = 'CUSTOMER' | 'ADMIN';
export interface AuthUser {
  id: string;
  role: Role;
}

export const IS_PUBLIC = 'isPublic';
/** Opt a route out of the global JWT guard. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

export const ROLES = 'roles';
/** Restrict a route to the listed roles. Routes without it only need a valid login. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES, roles);

export const CurrentUser = createParamDecorator((_data: unknown, ctx: ExecutionContext): AuthUser => {
  return ctx.switchToHttp().getRequest().user;
});
