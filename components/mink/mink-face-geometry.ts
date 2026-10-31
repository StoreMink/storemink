/**
 * The Mink AI face, as drawn on the owner's expression sheet (Oct 2026):
 * a saffron app tile, an ink side-parted head and a cream face. Only the
 * eyes and mouth change between the five states; the head, hair, keyline
 * and colours never do, so the avatar stays recognisable while it works.
 *
 * Pure data (no React, no DOM) so the component, its test and any other
 * renderer share one drawing. Coordinates are on the sheet's 24-unit grid:
 * the head is 15.2 units wide and mirror-symmetric, one 1.15-unit ink
 * keyline runs around face and hair as a single shape, and the eyes sit on
 * the 14 line.
 */

export const MINK_FACE_STATES = [
  "default",
  "listening",
  "thinking",
  "talking",
  "done",
] as const;

export type MinkFaceState = (typeof MINK_FACE_STATES)[number];

/** The sheet's four colours. Saffron is the tile, stone the page behind it. */
export const MINK_FACE_COLORS = {
  saffron: "#FFB224",
  ink: "#141522",
  cream: "#FFF4E3",
  stone: "#F2F1EC",
  white: "#FFFFFF",
} as const;

const LEFT_EYE_X = 8.96;
const RIGHT_EYE_X = 15.04;
const EYE_Y = 14.08;

export const MINK_FACE = {
  /** Hair and keyline, one shape. The fringe's volume sits on the right. */
  silhouette:
    "M3.84 16.2V9.6C3.84 5.4 6.6 2.95 11 2.9C13.4 2.87 15.6 2.75 17.2 3.4C19.2 4.3 20.15 6.2 20.2 8.4L20.24 16.2C20.24 19.9 16.8 21.2 12 21.2C7.2 21.2 3.84 19.9 3.84 16.2Z",
  /**
   * The cream face inside the keyline. Its top edge is the hairline: the
   * left lobe rises to the part, then the fringe sweeps right and down to
   * the right temple.
   */
  face: "M4.88 11.2C6.3 11 8.4 10.5 9.4 9.4C9.75 9 10 8.4 10.16 7.7C11.2 8.8 13.2 9.9 16 10.05C17 10.1 17.8 10 18.1 10C18.7 10.6 19 11.6 19.05 12.6V16C19.05 19 16.2 20.16 12 20.16C7.8 20.16 4.88 19 4.88 16Z",
  scleraR: 1.9,
  pupilR: 1.12,
  highlightR: 0.3,
  arcStroke: 1.3,
  /** The app tile's corner: the sheet's tiles round about 22% of a side. */
  tileRadius: 5.4,
  /**
   * Places the figure on the tile: about 47% of the tile wide and 52% tall,
   * centred, which is the calm margin the sheet's tiles leave.
   */
  tileTransform: "translate(12 12) scale(0.68) translate(-12.04 -12.05)",
} as const;

export type MinkFaceEye =
  | {
      kind: "open";
      cx: number;
      cy: number;
      px: number;
      py: number;
      hx: number;
      hy: number;
    }
  | { kind: "closed"; d: string };

export type MinkFaceMouth =
  | { kind: "stroke"; d: string; width: number }
  | { kind: "ellipse"; cx: number; cy: number; rx: number; ry: number }
  | { kind: "fill"; d: string };

export type MinkFaceParts = { eyes: MinkFaceEye[]; mouth: MinkFaceMouth };

/** Where the pupils look, per state: straight, a little up, up and right. */
const GAZE: Record<MinkFaceState, { dx: number; dy: number }> = {
  default: { dx: 0, dy: 0 },
  listening: { dx: 0, dy: -0.3 },
  thinking: { dx: 0.45, dy: -0.42 },
  talking: { dx: 0, dy: 0 },
  done: { dx: 0, dy: 0 },
};

function openEye(cx: number, state: MinkFaceState): MinkFaceEye {
  const gaze = GAZE[state];
  const px = round(cx + gaze.dx);
  const py = round(EYE_Y + gaze.dy);
  return {
    kind: "open",
    cx,
    cy: EYE_Y,
    px,
    py,
    hx: round(px + 0.42),
    hy: round(py - 0.42),
  };
}

/** Happy closed eyes: an arc that rises to its middle. */
function closedEye(cx: number): MinkFaceEye {
  return {
    kind: "closed",
    d: `M${round(cx - 1.95)} 14.8Q${cx} 12.35 ${round(cx + 1.95)} 14.8`,
  };
}

function mouthFor(state: MinkFaceState): MinkFaceMouth {
  switch (state) {
    case "listening":
    case "thinking":
      return { kind: "stroke", d: "M10.85 18.05H13.15", width: 1.2 };
    case "talking":
      return { kind: "ellipse", cx: 12, cy: 18.1, rx: 1.15, ry: 1.08 };
    case "done":
      return {
        kind: "fill",
        d: "M9.45 17.15H14.55Q14.55 19.7 12 19.7Q9.45 19.7 9.45 17.15Z",
      };
    default:
      return {
        kind: "stroke",
        d: "M10.04 17.4Q12 18.76 13.96 17.4",
        width: 1.28,
      };
  }
}

/** The eyes and mouth for one state; everything else is fixed. */
export function minkFaceParts(state: MinkFaceState): MinkFaceParts {
  const eyes =
    state === "done"
      ? [closedEye(LEFT_EYE_X), closedEye(RIGHT_EYE_X)]
      : [openEye(LEFT_EYE_X, state), openEye(RIGHT_EYE_X, state)];
  return { eyes, mouth: mouthFor(state) };
}

/** Any value that is not one of the five states reads as the default face. */
export function normalizeMinkFaceState(value: unknown): MinkFaceState {
  return MINK_FACE_STATES.includes(value as MinkFaceState)
    ? (value as MinkFaceState)
    : "default";
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}
