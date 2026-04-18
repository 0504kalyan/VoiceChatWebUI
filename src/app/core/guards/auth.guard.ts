import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { AuthService } from '../services/auth.service';

/** Requires a stored JWT; otherwise redirects to `/login`. */
export const authGuard: CanActivateFn = () => {
  const auth = inject(AuthService);
  const router = inject(Router);
  return auth.accessToken() ? true : router.createUrlTree(['/login']);
};
