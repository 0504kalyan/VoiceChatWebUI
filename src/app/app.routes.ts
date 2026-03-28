import { Routes } from '@angular/router';

export const routes: Routes = [
  { path: '', loadComponent: () => import('./features/chat/chat').then((m) => m.ChatComponent) }
];
