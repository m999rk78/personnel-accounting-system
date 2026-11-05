import type { CSSProperties } from "react";

const outlines = [
  "1078 2320 2149 1825 2149 502 1078 998 1078 2320",
  "7 502 1078 998 1078 2320 7 1825 7 502",
  "2149 502 1078 7 7 502 1078 998 2149 502",
  "709 502 1078 331 1078 682 709 502",
  "1446.99 502 1077.99 331 1077.99 682 1446.99 502",
  "709 502 1077.99 331 1447 502 1077.99 682 709 502",
  "1077.99 331 1798 664",
  "1429 1276 1429 1717 1789 1555 1429 1276",
  "1789 1114 1429 1276 1789 1555 1789 1114",
  "1789 1555 1429 1717 1429 1276 1789 1114 1789 1555",
  "1429 1276 2149 952",
  "727 1276 727 1717 367 1555 727 1276",
  "367 1114 727 1276 367 1555 367 1114",
  "367 1555 727 1717 727 1276 367 1114 367 1555",
  "1075.94 1433.02 367 1114",
];

// The original TPS mark draws its contours before filling the three faces.
// SVG/CSS keeps this independent of hydration and adds no animation dependency.
export function AnimatedLogo() {
  return <svg className="login-logo" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 2156 2327" width="80" height="80" role="img" aria-label="Югмонтажстрой">
    <g className="login-logo-fill login-logo-fill-left">
      <polygon fill="#fdb041" points="7 502 1078 998 1078 2320 7 1825 7 502" />
      <polygon fill="#3a3a3c" points="367 1114 727 1276 367 1555 367 1114" />
      <polygon fill="#f6821d" points="727 1276 727 1717 367 1555 727 1276" />
    </g>
    <g className="login-logo-fill login-logo-fill-right">
      <polygon fill="#f6941d" points="1078 2320 2149 1825 2149 502 1078 998 1078 2320" />
      <polygon fill="#3a3a3c" points="1789 1114 1429 1276 1789 1555 1789 1114" />
      <polygon fill="#df781e" points="1429 1276 1429 1717 1789 1555 1429 1276" />
    </g>
    <g className="login-logo-fill login-logo-fill-top">
      <polygon fill="#fff" points="2149 502 1078 7 7 502 1078 998 2149 502" />
      <polygon fill="#3a3a3c" points="709 502 1078 331 1078 682 709 502" />
      <polygon fill="#fdb041" points="1446.99 502 1077.99 331 1077.99 682 1446.99 502" />
    </g>
    <g fill="none" stroke="#3a3a3c" strokeWidth="14" strokeLinejoin="round">
      {outlines.map((points, index) => <polyline key={points} className="login-logo-outline" points={points} pathLength="1" style={{ "--logo-delay": `${index * .08}s`, "--logo-duration": `${.8 - index * .03}s` } as CSSProperties} />)}
    </g>
  </svg>;
}
