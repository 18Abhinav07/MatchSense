import type { ReactNode } from "react";

type Band = readonly [color: string, weight?: number];

type FlagSpec =
  | { bands: readonly Band[]; kind: "horizontal" | "vertical" }
  | {
      background: string;
      cross: string;
      inner?: string | undefined;
      kind: "nordic";
    }
  | { color: string; kind: "solid" };

const FLAG_SPECS = {
  ARG: { bands: [["#74acdf"], ["#ffffff"], ["#74acdf"]], kind: "horizontal" },
  BRA: { color: "#009739", kind: "solid" },
  ENG: { color: "#ffffff", kind: "solid" },
  ESP: {
    bands: [
      ["#aa151b", 1],
      ["#f1bf00", 2],
      ["#aa151b", 1],
    ],
    kind: "horizontal",
  },
  FRA: { bands: [["#002395"], ["#ffffff"], ["#ed2939"]], kind: "vertical" },
  JPN: { color: "#ffffff", kind: "solid" },
  GER: { bands: [["#161616"], ["#dd0000"], ["#ffce00"]], kind: "horizontal" },
  POR: {
    bands: [
      ["#046a38", 2],
      ["#da291c", 3],
    ],
    kind: "vertical",
  },
  NED: { bands: [["#ae1c28"], ["#ffffff"], ["#21468b"]], kind: "horizontal" },
  BEL: { bands: [["#1b1b1b"], ["#fdda24"], ["#ef3340"]], kind: "vertical" },
  BIH: { color: "#002395", kind: "solid" },
  ITA: { bands: [["#009246"], ["#ffffff"], ["#ce2b37"]], kind: "vertical" },
  CRO: { bands: [["#ff0000"], ["#ffffff"], ["#171796"]], kind: "horizontal" },
  URU: { color: "#ffffff", kind: "solid" },
  COL: {
    bands: [["#fcd116", 2], ["#003893"], ["#ce1126"]],
    kind: "horizontal",
  },
  USA: { color: "#ffffff", kind: "solid" },
  CAN: { bands: [["#d80621"], ["#ffffff", 2], ["#d80621"]], kind: "vertical" },
  MEX: { bands: [["#006847"], ["#ffffff"], ["#ce1126"]], kind: "vertical" },
  MAR: { color: "#c1272d", kind: "solid" },
  SEN: { bands: [["#00853f"], ["#fdef42"], ["#e31b23"]], kind: "vertical" },
  KOR: { color: "#ffffff", kind: "solid" },
  AUS: { color: "#012169", kind: "solid" },
  NZL: { color: "#012169", kind: "solid" },
  SUI: { color: "#da291c", kind: "solid" },
  DEN: { background: "#c60c30", cross: "#ffffff", kind: "nordic" },
  NOR: {
    background: "#ba0c2f",
    cross: "#ffffff",
    inner: "#00205b",
    kind: "nordic",
  },
  SWE: { background: "#006aa7", cross: "#fecc02", kind: "nordic" },
  FIN: { background: "#ffffff", cross: "#002f6c", kind: "nordic" },
  ISL: {
    background: "#02529c",
    cross: "#ffffff",
    inner: "#dc1e35",
    kind: "nordic",
  },
  POL: { bands: [["#ffffff"], ["#dc143c"]], kind: "horizontal" },
  AUT: { bands: [["#ed2939"], ["#ffffff"], ["#ed2939"]], kind: "horizontal" },
  SRB: { bands: [["#c6363c"], ["#0c4076"], ["#ffffff"]], kind: "horizontal" },
  TUR: { color: "#e30a17", kind: "solid" },
  UKR: { bands: [["#0057b7"], ["#ffd700"]], kind: "horizontal" },
  SCO: { color: "#0065bd", kind: "solid" },
  WAL: { bands: [["#ffffff"], ["#00ab39"]], kind: "horizontal" },
  ECU: {
    bands: [["#ffdd00", 2], ["#034ea2"], ["#ed1c24"]],
    kind: "horizontal",
  },
  PAR: { bands: [["#d52b1e"], ["#ffffff"], ["#0038a8"]], kind: "horizontal" },
  CHI: { bands: [["#ffffff"], ["#d52b1e"]], kind: "horizontal" },
  CRC: {
    bands: [["#002b7f"], ["#ffffff"], ["#ce1126", 2], ["#ffffff"], ["#002b7f"]],
    kind: "horizontal",
  },
  PAN: { color: "#ffffff", kind: "solid" },
  JAM: { color: "#009b3a", kind: "solid" },
  GHA: { bands: [["#ce1126"], ["#fcd116"], ["#006b3f"]], kind: "horizontal" },
  NGA: { bands: [["#008753"], ["#ffffff"], ["#008753"]], kind: "vertical" },
  CMR: { bands: [["#007a5e"], ["#ce1126"], ["#fcd116"]], kind: "vertical" },
  CIV: { bands: [["#f77f00"], ["#ffffff"], ["#009e60"]], kind: "vertical" },
  ALG: { bands: [["#ffffff"], ["#006233"]], kind: "vertical" },
  EGY: { bands: [["#ce1126"], ["#ffffff"], ["#000000"]], kind: "horizontal" },
  TUN: { color: "#e70013", kind: "solid" },
  RSA: {
    bands: [
      ["#de3831"],
      ["#ffffff", 0.18],
      ["#007a4d"],
      ["#ffffff", 0.18],
      ["#002395"],
    ],
    kind: "horizontal",
  },
  IRN: { bands: [["#239f40"], ["#ffffff"], ["#da0000"]], kind: "horizontal" },
  KSA: { color: "#006c35", kind: "solid" },
  QAT: { color: "#8a1538", kind: "solid" },
  JOR: { bands: [["#000000"], ["#ffffff"], ["#007a3d"]], kind: "horizontal" },
  BOL: {
    bands: [["#d52b1e"], ["#f9e300"], ["#007934"]],
    kind: "horizontal",
  },
  CPV: { color: "#003893", kind: "solid" },
  CUW: { color: "#002b7f", kind: "solid" },
  HAI: { bands: [["#00209f"], ["#d21034"]], kind: "horizontal" },
  IRQ: {
    bands: [["#ce1126"], ["#ffffff"], ["#000000"]],
    kind: "horizontal",
  },
  UZB: {
    bands: [
      ["#1eb53a"],
      ["#ce1126", 0.14],
      ["#ffffff"],
      ["#ce1126", 0.14],
      ["#0099b5"],
    ],
    kind: "horizontal",
  },
  COD: { color: "#007fff", kind: "solid" },
} as const satisfies Record<string, FlagSpec>;

export const BUNDLED_FLAG_CODES = Object.freeze(Object.keys(FLAG_SPECS));

export function hasBundledTeamFlagArt(code: string) {
  return Object.hasOwn(FLAG_SPECS, code.trim().toUpperCase());
}

function renderBands(
  bands: readonly Band[],
  direction: "horizontal" | "vertical",
) {
  const total = bands.reduce((sum, [, weight = 1]) => sum + weight, 0);
  let cursor = 0;

  return bands.map(([color, weight = 1], index) => {
    const start = (cursor / total) * (direction === "horizontal" ? 40 : 60);
    const size = (weight / total) * (direction === "horizontal" ? 40 : 60);
    cursor += weight;

    return direction === "horizontal" ? (
      <rect
        key={`${color}-${index}`}
        fill={color}
        height={size}
        width="60"
        x="0"
        y={start}
      />
    ) : (
      <rect
        key={`${color}-${index}`}
        fill={color}
        height="40"
        width={size}
        x={start}
        y="0"
      />
    );
  });
}

function renderNordic(spec: Extract<FlagSpec, { kind: "nordic" }>) {
  return (
    <>
      <rect fill={spec.background} height="40" width="60" />
      <path d="M17 0h9v40h-9zM0 16h60v9H0z" fill={spec.cross} />
      {spec.inner ? (
        <path d="M20 0h3v40h-3zM0 19h60v3H0z" fill={spec.inner} />
      ) : null}
    </>
  );
}

function fivePointStar(fill: string, transform = "translate(0 0)"): ReactNode {
  return (
    <polygon
      fill={fill}
      points="30,11 32.1,17.2 38.7,17.2 33.3,21.1 35.4,27.3 30,23.5 24.6,27.3 26.7,21.1 21.3,17.2 27.9,17.2"
      transform={transform}
    />
  );
}

function unionCanton() {
  return (
    <g>
      <rect fill="#012169" height="20" width="30" />
      <path d="M0 0l30 20M30 0L0 20" stroke="#ffffff" strokeWidth="4" />
      <path d="M0 0l30 20M30 0L0 20" stroke="#c8102e" strokeWidth="1.8" />
      <path d="M15 0v20M0 10h30" stroke="#ffffff" strokeWidth="6" />
      <path d="M15 0v20M0 10h30" stroke="#c8102e" strokeWidth="3" />
    </g>
  );
}

function renderAccent(code: string): ReactNode {
  switch (code) {
    case "BIH":
      return (
        <>
          <path d="M19 3h27L19 36z" fill="#fecb00" />
          {[7, 13, 19, 25, 31, 37].map((offset) => (
            <circle
              key={offset}
              cx={offset}
              cy={offset - 2}
              fill="#ffffff"
              r="1.35"
            />
          ))}
        </>
      );
    case "ARG":
      return <circle cx="30" cy="20" fill="#f6b40e" r="3.2" />;
    case "BRA":
      return (
        <>
          <path d="M30 5L54 20 30 35 6 20z" fill="#ffdf00" />
          <circle cx="30" cy="20" fill="#002776" r="9" />
          <path
            d="M22 18c6-2 12-1 17 3"
            fill="none"
            stroke="#ffffff"
            strokeWidth="1.5"
          />
        </>
      );
    case "ENG":
      return <path d="M25 0h10v40H25zM0 15h60v10H0z" fill="#ce1124" />;
    case "ESP":
      return (
        <circle
          cx="21"
          cy="20"
          fill="#aa151b"
          r="3.3"
          stroke="#f7d117"
          strokeWidth="1"
        />
      );
    case "JPN":
      return <circle cx="30" cy="20" fill="#bc002d" r="9.5" />;
    case "POR":
      return (
        <circle
          cx="24"
          cy="20"
          fill="#ffcc00"
          r="5"
          stroke="#ffffff"
          strokeWidth="1"
        />
      );
    case "CRO":
      return (
        <g transform="translate(25 12)">
          <rect
            fill="#ffffff"
            height="16"
            stroke="#29459b"
            strokeWidth="1"
            width="12"
          />
          {[0, 1, 2].map((row) =>
            [0, 1].map((column) => (
              <rect
                key={`${row}-${column}`}
                fill={(row + column) % 2 === 0 ? "#ff0000" : "#ffffff"}
                height="4"
                width="4"
                x={column * 4 + (row % 2) * 4}
                y={row * 4}
              />
            )),
          )}
        </g>
      );
    case "URU":
      return (
        <>
          {[1, 3, 5, 7].map((line) => (
            <rect
              key={line}
              fill="#0038a8"
              height="4.45"
              width="60"
              y={line * 4.45}
            />
          ))}
          <rect fill="#ffffff" height="22" width="23" />
          <circle cx="11.5" cy="10.5" fill="#fcd116" r="4.2" />
        </>
      );
    case "USA":
      return (
        <>
          {Array.from({ length: 7 }, (_, index) => (
            <rect
              key={index}
              fill="#b22234"
              height="3.08"
              width="60"
              y={index * 6.15}
            />
          ))}
          <rect fill="#3c3b6e" height="21.5" width="27" />
          {[5, 13.5, 22].flatMap((x) =>
            [5, 10.5, 16].map((y) => (
              <circle key={`${x}-${y}`} cx={x} cy={y} fill="#ffffff" r="1" />
            )),
          )}
        </>
      );
    case "CAN":
      return (
        <path
          d="M30 7l2.2 5.5 4-2-1.6 5 4.6.6-5 4 1.6 3.4-4.5-.8L30 32l-1.3-9.3-4.5.8 1.6-3.4-5-4 4.6-.6-1.6-5 4 2z"
          fill="#d80621"
        />
      );
    case "MEX":
      return (
        <circle
          cx="30"
          cy="20"
          fill="#8c5a2b"
          r="3.2"
          stroke="#006847"
          strokeWidth="1.3"
        />
      );
    case "MAR":
      return (
        <path
          d="M30 11l2.7 8.2h8.6l-7 5.1 2.7 8.2-7-5.1-7 5.1 2.7-8.2-7-5.1h8.6z"
          fill="none"
          stroke="#006233"
          strokeWidth="1.8"
        />
      );
    case "SEN":
      return fivePointStar(
        "#00853f",
        "translate(0 1) scale(.72) translate(11.7 6.4)",
      );
    case "KOR":
      return (
        <>
          <path
            d="M30 12a8 8 0 010 16 4 4 0 000-8 4 4 0 010-8z"
            fill="#cd2e3a"
          />
          <path
            d="M30 28a8 8 0 010-16 4 4 0 000 8 4 4 0 010 8z"
            fill="#0047a0"
          />
          <path
            d="M12 10l7 4M11 13l7 4M42 23l7 4M41 26l7 4"
            stroke="#111111"
            strokeWidth="1.4"
          />
        </>
      );
    case "AUS":
    case "NZL":
      return (
        <>
          {unionCanton()}
          {[38, 48, 42, 52].map((x, index) => (
            <circle
              key={x}
              cx={x}
              cy={[11, 17, 28, 32][index]}
              fill={code === "NZL" ? "#cc142b" : "#ffffff"}
              r={code === "NZL" ? 1.8 : 1.4}
              stroke={code === "NZL" ? "#ffffff" : "none"}
              strokeWidth="0.7"
            />
          ))}
          {code === "AUS" ? (
            <circle cx="15" cy="30" fill="#ffffff" r="2.4" />
          ) : null}
        </>
      );
    case "SUI":
      return <path d="M25 8h10v8h8v9h-8v8H25v-8h-8v-9h8z" fill="#ffffff" />;
    case "SRB":
      return (
        <path
          d="M17 8h8v14c0 5-4 8-4 8s-4-3-4-8z"
          fill="#ffffff"
          stroke="#c6363c"
          strokeWidth="1.3"
        />
      );
    case "TUR":
      return (
        <>
          <circle cx="25" cy="20" fill="#ffffff" r="9" />
          <circle cx="28.5" cy="18.5" fill="#e30a17" r="7.2" />
          <g transform="translate(10 -1) scale(.62)">
            {fivePointStar("#ffffff")}
          </g>
        </>
      );
    case "SCO":
      return <path d="M0 0l60 40M60 0L0 40" stroke="#ffffff" strokeWidth="6" />;
    case "WAL":
      return (
        <path
          d="M14 25l8-9 7 3 5-8 4 7 9 1-7 5 2 7-9-4-6 5-4-6z"
          fill="#d30731"
        />
      );
    case "ECU":
    case "PAR":
      return (
        <circle
          cx="30"
          cy="20"
          fill={code === "ECU" ? "#8b5a2b" : "#f0c43c"}
          r="2.8"
          stroke="#ffffff"
          strokeWidth="0.8"
        />
      );
    case "CHI":
      return (
        <>
          <rect fill="#0039a6" height="20" width="20" />
          <g transform="translate(-20 -10) scale(.5)">
            {fivePointStar("#ffffff")}
          </g>
        </>
      );
    case "PAN":
      return (
        <>
          <rect fill="#ffffff" height="20" width="30" />
          <rect fill="#d21034" height="20" width="30" x="30" />
          <rect fill="#005293" height="20" width="30" y="20" />
          <rect fill="#ffffff" height="20" width="30" x="30" y="20" />
          <g transform="translate(-15 -10) scale(.5)">
            {fivePointStar("#005293")}
          </g>
          <g transform="translate(15 10) scale(.5)">
            {fivePointStar("#d21034")}
          </g>
        </>
      );
    case "JAM":
      return (
        <>
          <path d="M0 0l30 20L0 40zM60 0L30 20l30 20z" fill="#000000" />
          <path d="M0 0l60 40M60 0L0 40" stroke="#fed100" strokeWidth="5" />
        </>
      );
    case "GHA":
    case "CMR":
      return fivePointStar(
        code === "GHA" ? "#111111" : "#fcd116",
        "translate(3 2) scale(.9)",
      );
    case "ALG":
      return (
        <>
          <circle cx="30" cy="20" fill="#d21034" r="8" />
          <circle cx="33" cy="18" fill="#ffffff" r="6.5" />
          <g transform="translate(9 0) scale(.68)">
            {fivePointStar("#d21034")}
          </g>
        </>
      );
    case "EGY":
      return <path d="M27 15h6l2 5-5 6-5-6z" fill="#c8a951" />;
    case "TUN":
      return (
        <>
          <circle cx="30" cy="20" fill="#ffffff" r="9" />
          <circle cx="29" cy="20" fill="#e70013" r="5.7" />
          <circle cx="31" cy="18.5" fill="#ffffff" r="4.7" />
          <g transform="translate(8 -1) scale(.72)">
            {fivePointStar("#e70013")}
          </g>
        </>
      );
    case "RSA":
      return (
        <>
          <path
            d="M0 4l24 16L0 36z"
            fill="#000000"
            stroke="#ffb81c"
            strokeWidth="5"
          />
          <path
            d="M0 8l20 12L0 32M20 20h40"
            fill="none"
            stroke="#007a4d"
            strokeWidth="7"
          />
        </>
      );
    case "IRN":
      return <circle cx="30" cy="20" fill="#da0000" r="2.6" />;
    case "KSA":
      return (
        <>
          <path
            d="M18 15h24M20 18h20M23 21h16"
            stroke="#ffffff"
            strokeLinecap="round"
            strokeWidth="1.5"
          />
          <path
            d="M18 27c8 2 17 2 25-1"
            fill="none"
            stroke="#ffffff"
            strokeWidth="1.5"
          />
        </>
      );
    case "QAT":
      return (
        <path
          d="M0 0h18l-5 2.2 5 2.2-5 2.2 5 2.2-5 2.2 5 2.2-5 2.2 5 2.2-5 2.2 5 2.2-5 2.2 5 2.2-5 2.2 5 2.2-5 2.2 5 2.2-5 2.2H0z"
          fill="#ffffff"
        />
      );
    case "JOR":
      return (
        <>
          <path d="M0 0l25 20L0 40z" fill="#ce1126" />
          <circle cx="8" cy="20" fill="#ffffff" r="1.7" />
        </>
      );
    default:
      return null;
  }
}

export function BundledTeamFlagArt({ code }: { code: string }) {
  const normalizedCode = code.trim().toUpperCase();
  const spec = FLAG_SPECS[normalizedCode as keyof typeof FLAG_SPECS] as
    FlagSpec | undefined;

  if (!spec) return null;

  return (
    <span
      aria-hidden="true"
      className="ms-team-flag__art"
      data-flag-code={normalizedCode}
    >
      <svg
        focusable="false"
        preserveAspectRatio="xMidYMid slice"
        viewBox="0 0 60 40"
      >
        {spec.kind === "solid" ? (
          <rect fill={spec.color} height="40" width="60" />
        ) : null}
        {spec.kind === "horizontal" || spec.kind === "vertical"
          ? renderBands(spec.bands, spec.kind)
          : null}
        {spec.kind === "nordic" ? renderNordic(spec) : null}
        {renderAccent(normalizedCode)}
      </svg>
    </span>
  );
}
