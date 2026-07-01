export const OPERATOR_TECHNICAL_EMAIL_DOMAIN = 'operators.local.ahtops';

export type OperatorLoginIdentity =
  | {
      kind: 'username';
      username: string;
      email: string;
    }
  | {
      kind: 'email';
      username: null;
      email: string;
    };

export type OperatorProfile = {
  email: string | null;
  username: string | null;
  displayName: string | null;
};

const USERNAME_PATTERN = /^[a-z0-9](?:[a-z0-9_.-]{1,30}[a-z0-9])$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const INVALID_USERNAME_MESSAGE = 'Username không hợp lệ.';

export function normalizeOperatorUsername(value: string): string {
  const username = value.trim().toLowerCase();
  if (!USERNAME_PATTERN.test(username)) throw new Error(INVALID_USERNAME_MESSAGE);
  return username;
}

function normalizeOperatorEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(email)) throw new Error(INVALID_USERNAME_MESSAGE);
  return email;
}

export function operatorUsernameToTechnicalEmail(username: string): string {
  return `${normalizeOperatorUsername(username)}@${OPERATOR_TECHNICAL_EMAIL_DOMAIN}`;
}

export function resolveOperatorLoginIdentity(value: string): OperatorLoginIdentity {
  const trimmed = value.trim();
  if (trimmed.includes('@')) {
    return {
      kind: 'email',
      username: null,
      email: normalizeOperatorEmail(trimmed),
    };
  }

  const username = normalizeOperatorUsername(trimmed);
  return {
    kind: 'username',
    username,
    email: `${username}@${OPERATOR_TECHNICAL_EMAIL_DOMAIN}`,
  };
}

export function formatOperatorLabel(profile: OperatorProfile): string {
  const displayName = profile.displayName?.trim();
  if (displayName) return displayName;
  const username = profile.username?.trim();
  if (username) return username;
  const email = profile.email?.trim();
  if (email) return email;
  return 'Operator';
}
