interface Props {
  size?: number;
  color?: string;
  strokeWidth?: number;
  /** Animate orbits + nucleus. Off by default so nav/footer logos stay still. */
  animate?: boolean;
}

/**
 * Fission "atom" logo — three offset orbital ellipses + central nucleus dot.
 * When `animate` is true, each orbit rotates around the SVG center at a
 * different speed (one reversed) and the nucleus spins faster with two
 * "proton" satellites. Honors prefers-reduced-motion via globals.css.
 */
export function FissionLogo({ size = 30, color = "#ffffff", strokeWidth, animate = false }: Props) {
  const sw = strokeWidth ?? (size > 50 ? 3.2 : size > 24 ? 4.2 : 4.5);
  const nucleusR = size > 50 ? 4.5 : 5.5;
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
      <g className={animate ? "fl-orbit-1" : undefined}>
        <ellipse cx="50" cy="50" rx="40" ry="15" transform="rotate(-20 50 50)" stroke={color} strokeWidth={sw} fill="none" />
      </g>
      <g className={animate ? "fl-orbit-2" : undefined}>
        <ellipse cx="50" cy="50" rx="40" ry="15" transform="rotate(45 50 50)" stroke={color} strokeWidth={sw} fill="none" />
      </g>
      <g className={animate ? "fl-orbit-3" : undefined}>
        <ellipse cx="50" cy="50" rx="40" ry="15" transform="rotate(110 50 50)" stroke={color} strokeWidth={sw} fill="none" />
      </g>
      {animate ? (
        <g className="fl-nucleus">
          <circle cx="50" cy="50" r={nucleusR} fill={color} />
          {/* Proton satellites — visible only when the group rotates. */}
          <circle cx={50 + nucleusR + 1.4} cy="50" r="1.6" fill={color} opacity="0.8" />
          <circle cx={50 - nucleusR - 1.4} cy="50" r="1.6" fill={color} opacity="0.8" />
        </g>
      ) : (
        <circle cx="50" cy="50" r={nucleusR} fill={color} />
      )}
    </svg>
  );
}
