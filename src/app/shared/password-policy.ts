/** Mirrors API PasswordPolicy — keep rules in sync. */
export interface PasswordRuleState {
  minLength: boolean;
  uppercase: boolean;
  lowercase: boolean;
  digit: boolean;
  special: boolean;
}

export function evaluatePasswordRules(password: string): PasswordRuleState {
  return {
    minLength: password.length >= 8,
    uppercase: /[A-Z]/.test(password),
    lowercase: /[a-z]/.test(password),
    digit: /[0-9]/.test(password),
    special: /[^A-Za-z0-9]/.test(password)
  };
}

export function isPasswordPolicyMet(state: PasswordRuleState): boolean {
  return (
    state.minLength &&
    state.uppercase &&
    state.lowercase &&
    state.digit &&
    state.special
  );
}

export function isPasswordAcceptable(password: string): boolean {
  return isPasswordPolicyMet(evaluatePasswordRules(password));
}
