/**
 * The product half of `./form-prefill`, kept under its original names for
 * the proposal card, the parser and the product editor. New forms use
 * `form-prefill` directly.
 */
import {
  minkPrefillKey,
  minkPrefillPath,
  readMinkPrefill,
  storeMinkPrefill,
  takeMinkPrefill,
  MINK_PREFILL_PARAM,
  MINK_PREFILL_VALUE,
  type MinkProductPrefill,
} from "./form-prefill";

export type { MinkProductPrefill } from "./form-prefill";
export const MINK_PRODUCT_PREFILL_KEY = minkPrefillKey("product");
export const MINK_PRODUCT_PREFILL_PARAM = MINK_PREFILL_PARAM;
export const MINK_PRODUCT_PREFILL_VALUE = MINK_PREFILL_VALUE;

export function readMinkProductPrefill(
  value: unknown,
): MinkProductPrefill | null {
  return readMinkPrefill("product", value);
}

export function minkProductPrefillPath(): string {
  return minkPrefillPath("product");
}

export function storeMinkProductPrefill(prefill: MinkProductPrefill): boolean {
  return storeMinkPrefill({ kind: "product", fields: prefill });
}

export function takeMinkProductPrefill(): MinkProductPrefill | null {
  return takeMinkPrefill("product");
}
