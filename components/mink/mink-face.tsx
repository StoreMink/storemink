import styles from "./mink-face.module.css";
import {
  MINK_FACE,
  MINK_FACE_COLORS as C,
  minkFaceParts,
  normalizeMinkFaceState,
  type MinkFaceState,
} from "./mink-face-geometry";

export type { MinkFaceState } from "./mink-face-geometry";

export type MinkFaceProps = {
  /** default, listening, thinking, talking or done; anything else is default. */
  state?: MinkFaceState;
  /** Rendered width and height in pixels. */
  size?: number;
  /** The saffron app tile behind the face (the sheet's icon form). */
  tile?: boolean;
  /** Blink, glance and talk. Off under reduced motion whatever this says. */
  animated?: boolean;
  /**
   * Names the face for assistive technology. Without one the face is
   * decorative and hidden from it, which is right beside a visible label.
   */
  title?: string;
  className?: string;
};

/**
 * The Mink AI face from the owner's expression sheet: a saffron tile, an ink
 * side-parted head, a cream face. Only the eyes and mouth change with
 * `state`; the drawing lives in `mink-face-geometry.ts`.
 *
 * No hooks and no browser APIs, so it renders on the server too; the motion
 * is CSS keyed off `data-state`, which is why a state change animates without
 * remounting.
 */
export function MinkFace({
  state = "default",
  size = 32,
  tile = true,
  animated = false,
  title,
  className = "",
}: MinkFaceProps) {
  const current = normalizeMinkFaceState(state);
  const parts = minkFaceParts(current);
  const classes = [styles.face, animated ? styles.animated : "", className]
    .filter(Boolean)
    .join(" ");

  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      className={classes}
      data-state={current}
      data-mink-face=""
      role={title ? "img" : undefined}
      aria-label={title || undefined}
      aria-hidden={title ? undefined : true}
      focusable="false"
    >
      {tile ? (
        <rect
          width="24"
          height="24"
          rx={MINK_FACE.tileRadius}
          fill={C.saffron}
        />
      ) : null}
      <g transform={tile ? MINK_FACE.tileTransform : undefined}>
        <g className={styles.head}>
          <path d={MINK_FACE.silhouette} fill={C.ink} />
          <path d={MINK_FACE.face} fill={C.cream} />
          <g className={styles.eyes}>
            {parts.eyes.map((eye, index) =>
              eye.kind === "open" ? (
                <g key={index}>
                  <circle
                    cx={eye.cx}
                    cy={eye.cy}
                    r={MINK_FACE.scleraR}
                    fill={C.white}
                  />
                  <g className={styles.pupil}>
                    <circle
                      cx={eye.px}
                      cy={eye.py}
                      r={MINK_FACE.pupilR}
                      fill={C.ink}
                    />
                    <circle
                      cx={eye.hx}
                      cy={eye.hy}
                      r={MINK_FACE.highlightR}
                      fill={C.white}
                    />
                  </g>
                </g>
              ) : (
                <path
                  key={index}
                  d={eye.d}
                  fill="none"
                  stroke={C.ink}
                  strokeWidth={MINK_FACE.arcStroke}
                  strokeLinecap="round"
                />
              ),
            )}
          </g>
          <g className={styles.mouth}>
            {parts.mouth.kind === "stroke" ? (
              <path
                d={parts.mouth.d}
                fill="none"
                stroke={C.ink}
                strokeWidth={parts.mouth.width}
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            ) : parts.mouth.kind === "ellipse" ? (
              <ellipse
                cx={parts.mouth.cx}
                cy={parts.mouth.cy}
                rx={parts.mouth.rx}
                ry={parts.mouth.ry}
                fill={C.ink}
              />
            ) : (
              <path
                d={parts.mouth.d}
                fill={C.ink}
                stroke={C.ink}
                strokeWidth={0.35}
                strokeLinejoin="round"
              />
            )}
          </g>
        </g>
      </g>
    </svg>
  );
}
