// Tiny initial-only avatar. Color hashed off the user's name/email so
// the same person always renders the same color, but different people
// stay distinguishable at a glance.

const PALETTE = [
  'oklch(0.65 0.16 25)',
  'oklch(0.65 0.16 70)',
  'oklch(0.65 0.16 130)',
  'oklch(0.65 0.16 180)',
  'oklch(0.65 0.16 230)',
  'oklch(0.65 0.16 280)',
  'oklch(0.65 0.16 330)',
] as const;

function pickColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = (h * 31 + seed.charCodeAt(i)) >>> 0;
  }
  return PALETTE[h % PALETTE.length] ?? PALETTE[0];
}

export interface UserAvatarProps {
  name: string | null;
  email: string;
  size?: 'sm' | 'md';
}

export function UserAvatar({ name, email, size = 'md' }: Readonly<UserAvatarProps>) {
  const display = (name?.trim() || email).charAt(0).toUpperCase();
  const color = pickColor(email.toLowerCase());
  const dim = size === 'sm' ? '1.5rem' : '2rem';
  const fontSize = size === 'sm' ? '0.75rem' : '0.95rem';
  return (
    <span
      className="user-avatar"
      style={{
        background: color,
        width: dim,
        height: dim,
        fontSize,
      }}
      aria-hidden="true"
    >
      {display}
    </span>
  );
}
