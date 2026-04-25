import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { environment } from '../../../environments/environment';

const TOKEN_KEY = 'voicechat.accessToken';
const EMAIL_KEY = 'voicechat.email';

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
  readonly userEmail = signal<string | null>(
    typeof localStorage === 'undefined' ? null : localStorage.getItem(EMAIL_KEY)
  );

  setSession(response: AuthResponse | null | undefined): void {
    if (!response?.accessToken) {
      throw new Error(
        'Login did not return an access token. Check the deployed Angular apiBaseUrl and the API /api/auth/login response.'
      );
    }

    localStorage.setItem(TOKEN_KEY, response.accessToken);
    localStorage.setItem(EMAIL_KEY, response.email);
    this.accessToken.set(response.accessToken);
    this.userEmail.set(response.email);
  }

  /** Used after Google redirect (JWT only in query string). */
  storeAccessToken(token: string): void {
    localStorage.setItem(TOKEN_KEY, token);
    this.accessToken.set(token);
    const email = this.emailFromJwt(token);
    if (email) {
      localStorage.setItem(EMAIL_KEY, email);
      this.userEmail.set(email);
    }
  }

  logout(): void {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(EMAIL_KEY);
    this.accessToken.set(null);
    this.userEmail.set(null);
    void this.router.navigate(['/login'], { replaceUrl: true });
  }

  displayName(): string {
    const email = this.userEmail();
    if (!email) return 'User';
    return email.split('@')[0] || email;
  }

  private emailFromJwt(token: string): string | null {
    try {
      const payload = token.split('.')[1];
      if (!payload) return null;
      const normalized = payload.replace(/-/g, '+').replace(/_/g, '/');
      const json = decodeURIComponent(
        atob(normalized)
          .split('')
          .map((c) => `%${c.charCodeAt(0).toString(16).padStart(2, '0')}`)
          .join('')
      );
      const claims = JSON.parse(json) as Record<string, unknown>;
      const email =
        claims['email'] ??
        claims['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'];
      return typeof email === 'string' ? email : null;
    } catch {
      return null;
    }
  }

  registerSendOtp(email: string) {
    return this.http.post<{ message: string }>(`${this.base}/api/auth/register/send-otp`, { email });
  }

  registerValidateOtp(email: string, code: string) {
    return this.http.post<{ message: string }>(`${this.base}/api/auth/register/validate-otp`, { email, code });
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
