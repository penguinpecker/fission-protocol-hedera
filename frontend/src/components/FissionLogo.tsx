interface Props {
  size?: number;
  color?: string;
  strokeWidth?: number;
}

/**
 * Fission "atom" logo — three offset orbital ellipses + central nucleus dot.
 * Reused from the original Hedera repo's design language (clean, monochrome).
 */
export function FissionLogo({ size = 30, color = "#ffffff", strokeWidth }: Props) {
  const sw = strokeWidth ?? (size > 50 ? 3.2 : size > 24 ? 4.2 : 4.5);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      role="img"
      aria-label="Fission Protocol"
    >
      <ellipse cx="50" cy="50" rx="40" ry="15" transform="rotate(-20 50 50)" stroke={color} strokeWidth={sw} fill="none" />
      <ellipse cx="50" cy="50" rx="40" ry="15" transform="rotate(45 50 50)" stroke={color} strokeWidth={sw} fill="none" />
      <ellipse cx="50" cy="50" rx="40" ry="15" transform="rotate(110 50 50)" stroke={color} strokeWidth={sw} fill="none" />
      <circle cx="50" cy="50" r={size > 50 ? 4.5 : 5.5} fill={color} />
    </svg>
  );
}
