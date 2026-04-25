import { HttpClient } from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { environment } from '../../../environments/environment';

const TOKEN_KEY = 'voicechat.accessToken';
const EMAIL_KEY = 'voicechat.email';
const DISPLAY_NAME_KEY = 'voicechat.displayName';

export interface AuthResponse {
  accessToken: string;
  email: string;
  displayName?: string;
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
    typeof localStorage === 'undefined'
      ? null
      : localStorage.getItem(EMAIL_KEY) || this.claimFromStoredToken('email')
  );
  readonly userDisplayName = signal<string | null>(
    typeof localStorage === 'undefined'
      ? null
      : localStorage.getItem(DISPLAY_NAME_KEY) || this.claimFromStoredToken('name')
  );

  setSession(response: AuthResponse | null | undefined): void {
    if (!response?.accessToken) {
      throw new Error(
        'Login did not return an access token. Check the deployed Angular apiBaseUrl and the API /api/auth/login response.'
      );
    }

    localStorage.setItem(TOKEN_KEY, response.accessToken);
    localStorage.setItem(EMAIL_KEY, response.email);
    const displayName = response.displayName || this.nameFromJwt(response.accessToken) || this.nameFromEmail(response.email);
    localStorage.setItem(DISPLAY_NAME_KEY, displayName);
    this.accessToken.set(response.accessToken);
    this.userEmail.set(response.email);
    this.userDisplayName.set(displayName);
  }

  /** Used after Google redirect (JWT only in query string). */
  storeAccessToken(token: string): void {
    localStorage.setItem(TOKEN_KEY, token);
    this.accessToken.set(token);
    const email = this.emailFromJwt(token);
    const displayName = this.nameFromJwt(token) || (email ? this.nameFromEmail(email) : null);
    if (email) {
      localStorage.setItem(EMAIL_KEY, email);
      this.userEmail.set(email);
    }
    if (displayName) {
      localStorage.setItem(DISPLAY_NAME_KEY, displayName);
      this.userDisplayName.set(displayName);
    }
  }

  logout(): void {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(EMAIL_KEY);
    localStorage.removeItem(DISPLAY_NAME_KEY);
    this.accessToken.set(null);
    this.userEmail.set(null);
    this.userDisplayName.set(null);
    void this.router.navigate(['/login'], { replaceUrl: true });
  }

  displayName(): string {
    const name = this.userDisplayName();
    if (name) return name;
    const email = this.userEmail();
    return email ? this.nameFromEmail(email) : 'User';
  }

  private nameFromEmail(email: string): string {
    return email.split('@')[0] || email;
  }

  private claimFromStoredToken(claim: 'email' | 'name'): string | null {
    if (typeof localStorage === 'undefined') return null;
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) return null;
    return claim === 'email' ? this.emailFromJwt(token) : this.nameFromJwt(token);
  }

  private nameFromJwt(token: string): string | null {
    const claims = this.claimsFromJwt(token);
    const name =
      claims?.['name'] ??
      claims?.['unique_name'] ??
      claims?.['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/name'];
    return typeof name === 'string' && name.length > 0 ? name : null;
  }

  private emailFromJwt(token: string): string | null {
    const claims = this.claimsFromJwt(token);
    const email =
      claims?.['email'] ??
      claims?.['http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress'];
    return typeof email === 'string' ? email : null;
  }

  private claimsFromJwt(token: string): Record<string, unknown> | null {
    try {
      const payload = token.split('.')[1];
      if (!payload) return null;
      const normalized = payload.replaceAll('-', '+').replaceAll('_', '/');
      const json = decodeURIComponent(
        atob(normalized)
          .split('')
          .map((c) => `%${(c.codePointAt(0) ?? 0).toString(16).padStart(2, '0')}`)
          .join('')
      );
      return JSON.parse(json) as Record<string, unknown>;
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
