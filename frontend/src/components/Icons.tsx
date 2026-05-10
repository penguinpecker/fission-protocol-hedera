// Custom SVG icons used across the marketing pages. Stroke-only, currentColor,
// 24x24 viewBox so they inherit text color and scale with font-size utilities.
//
// Hand-drawn (not lucide / heroicons) so the visual language stays consistent
// with the FissionLogo and avoids the generic-AI-icon-set look.

import type { SVGProps } from "react";

type IconProps = SVGProps<SVGSVGElement> & { strokeWidth?: number };

function Icon({ children, strokeWidth = 1.6, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {children}
    </svg>
  );
}

/** PT — vault / fixed yield */
export function LockIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="4.5" y="10" width="15" height="10.5" rx="2" />
      <path d="M8 10V6.5a4 4 0 0 1 8 0V10" />
      <circle cx="12" cy="15" r="1.2" />
    </Icon>
  );
}

/** YT — variable / leveraged */
export function BoltIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M13.5 3 6 13.5h5l-1 7.5L18 9h-5z" />
    </Icon>
  );
}

/** Split — branching path */
export function BranchIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="6" cy="6" r="2" />
      <circle cx="18" cy="6" r="2" />
      <circle cx="12" cy="19" r="2" />
      <path d="M6 8v3a3 3 0 0 0 3 3h6a3 3 0 0 0 3-3V8" />
      <path d="M12 14v3" />
    </Icon>
  );
}

/** Shield — governance */
export function ShieldIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M12 3 4.5 6v6c0 4.5 3.2 8 7.5 9 4.3-1 7.5-4.5 7.5-9V6L12 3z" />
      <path d="m9 12 2.2 2.2L15 10.4" />
    </Icon>
  );
}

/** Flow — fees streaming through */
export function FlowIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <circle cx="5" cy="6" r="1.7" />
      <circle cx="19" cy="6" r="1.7" />
      <circle cx="5" cy="18" r="1.7" />
      <circle cx="19" cy="18" r="1.7" />
      <path d="M6.7 6h10.6" />
      <path d="M6.7 18h10.6" />
      <path d="M5 7.7v8.6" />
      <path d="M19 7.7v8.6" />
      <path d="M9 12h6" />
    </Icon>
  );
}

/** Chain — timelock / on-chain delay */
export function ChainIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <rect x="3" y="9" width="8" height="6" rx="3" />
      <rect x="13" y="9" width="8" height="6" rx="3" />
      <path d="M11 12h2" />
    </Icon>
  );
}

/** External link */
export function ArrowOutIcon(props: IconProps) {
  return (
    <Icon {...props}>
      <path d="M7 17 17 7" />
      <path d="M9 7h8v8" />
    </Icon>
  );
}
