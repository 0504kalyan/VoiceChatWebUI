import { Routes } from '@angular/router';
import { authGuard } from './core/guards/auth.guard';

export const routes: Routes = [
  { path: 'login', loadComponent: () => import('./features/auth/login/login').then((m) => m.LoginComponent) },
  { path: 'register', loadComponent: () => import('./features/auth/register/register').then((m) => m.RegisterComponent) },
  {
    path: 'forgot-password',
    loadComponent: () => import('./features/auth/forget-password/forgot-password').then((m) => m.ForgotPasswordComponent)
  },
  {
    path: 'reset-password',
    loadComponent: () => import('./features/auth/reset-password/reset-password').then((m) => m.ResetPasswordComponent)
  },
  {
    path: 'auth/google-callback',
    loadComponent: () => import('./features/auth/google-callback').then((m) => m.GoogleCallbackComponent)
  },
  {
    path: '',
    loadComponent: () => import('./features/chat/chat').then((m) => m.ChatComponent),
    canMatch: [authGuard]
  }
];
