// One exemplar per design direction (see shared.ts). Server-only like the
// bundled definitions: never import this from a client component.
import type { ThemeDefinition } from "../types";
import { boldAndLoud } from "./bold-and-loud";
import { classicAndTrusted } from "./classic-and-trusted";
import { denseCatalogue } from "./dense-catalogue";
import { luxuryMinimal } from "./luxury-minimal";
import { magazineEditorial } from "./magazine-editorial";
import { playfulAndColourful } from "./playful-and-colourful";
import { softAndNatural } from "./soft-and-natural";

export { EXEMPLAR_DIRECTION } from "./shared";

export const EXEMPLAR_THEMES: readonly ThemeDefinition[] = [
  luxuryMinimal,
  boldAndLoud,
  magazineEditorial,
  denseCatalogue,
  softAndNatural,
  playfulAndColourful,
  classicAndTrusted,
];

export function getExemplarTheme(id: string): ThemeDefinition | undefined {
  return EXEMPLAR_THEMES.find((theme) => theme.id === id);
}
