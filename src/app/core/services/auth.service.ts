import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { environment } from '../../../environments/environment';

const TOKEN_KEY = 'voicechat.accessToken';

export interface AuthResponse {
  accessToken: string;
  email: string;
  userId: string;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);
  private readonly base = environment.apiBaseUrl;

  readonly accessToken = signal<string | null>(
    typeof localStorage === 'undefined' ? null : localStorage.getItem(TOKEN_KEY)
  );

  setSession(response: AuthResponse): void {
    localStorage.setItem(TOKEN_KEY, response.accessToken);
    this.accessToken.set(response.accessToken);
  }

  /** Used after Google redirect (JWT only in query string). */
  storeAccessToken(token: string): void {
    localStorage.setItem(TOKEN_KEY, token);
    this.accessToken.set(token);
  }

  logout(): void {
    localStorage.removeItem(TOKEN_KEY);
    this.accessToken.set(null);
    void this.router.navigate(['/login']);
  }

  registerSendOtp(email: string) {
    return this.http.post<{ message: string }>(`${this.base}/api/auth/register/send-otp`, { email });
  }

  registerComplete(email: string, code: string, password: string) {
    return this.http.post<AuthResponse>(`${this.base}/api/auth/register/complete`, { email, code, password });
  }

  login(email: string, password: string) {
    return this.http.post<AuthResponse>(`${this.base}/api/auth/login`, { email, password });
  }

  forgotPassword(email: string) {
    return this.http.post<{ message: string }>(`${this.base}/api/auth/forgot-password`, { email });
  }

  resetPassword(email: string, token: string, newPassword: string) {
    return this.http.post<{ message: string }>(`${this.base}/api/auth/reset-password`, {
      email,
      token,
      newPassword
    });
  }

  googleLoginUrl(): string {
    return `${this.base}/api/auth/google`;
  }

  /** Google OAuth status; `authorizedRedirectUri` must be added in Google Cloud Console if you see redirect_uri_mismatch. */
  getGoogleOAuthStatus() {
    return this.http.get<{
      configured: boolean;
      authorizedRedirectUri?: string;
      hint?: string;
    }>(`${this.base}/api/auth/google/status`);
  }
}
