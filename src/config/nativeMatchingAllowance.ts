import {
  DEFAULT_NATIVE_MATCHING_REPRESENTATION_BYTES,
  MAXIMUM_NATIVE_MATCHING_REPRESENTATION_BYTES,
} from "../domain/analysisResourceLimits.js";
import { z } from "zod";

import { ConfigurationError } from "../domain/configurationErrors.js";
import { err, ok, type Result } from "../domain/result.js";

export const NATIVE_MATCHING_ALLOWANCE_SETTING =
  "REA_NATIVE_MATCHING_REPRESENTATION_BYTES";

/** Effective native function-matching representation allowance and its source. */
export interface NativeMatchingAllowance {
  readonly maximumBytes: number;
  readonly source: "default" | "setting" | "runtime";
}

export const DEFAULT_NATIVE_MATCHING_ALLOWANCE: NativeMatchingAllowance = {
  maximumBytes: DEFAULT_NATIVE_MATCHING_REPRESENTATION_BYTES,
  source: "default",
};

export const nativeMatchingRepresentationBytesConstraint = `${NATIVE_MATCHING_ALLOWANCE_SETTING} must be a positive decimal integer of at most ${String(MAXIMUM_NATIVE_MATCHING_REPRESENTATION_BYTES)} bytes (1 GiB); the default is ${String(DEFAULT_NATIVE_MATCHING_REPRESENTATION_BYTES)} bytes (96 MiB).`;

/** Optional decimal byte count for the native function-matching allowance. */
export const nativeMatchingRepresentationBytesSchema = z
  .string()
  .regex(/^[1-9]\d*$/u, {
    error: nativeMatchingRepresentationBytesConstraint,
  })
  .transform(Number)
  .pipe(
    z.number().int().max(MAXIMUM_NATIVE_MATCHING_REPRESENTATION_BYTES, {
      error: nativeMatchingRepresentationBytesConstraint,
    }),
  );

/** Resolve the effective allowance from one launch environment. */
export const parseNativeMatchingAllowance = (
  environment: Readonly<Record<string, string | undefined>>,
): Result<NativeMatchingAllowance, ConfigurationError> => {
  const value = environment[NATIVE_MATCHING_ALLOWANCE_SETTING];
  if (value === undefined) return ok(DEFAULT_NATIVE_MATCHING_ALLOWANCE);
  const parsed = nativeMatchingRepresentationBytesSchema.safeParse(value);
  return parsed.success
    ? ok({ maximumBytes: parsed.data, source: "setting" })
    : err(
        new ConfigurationError(nativeMatchingRepresentationBytesConstraint, {
          settings: [
            {
              setting: NATIVE_MATCHING_ALLOWANCE_SETTING,
              constraint: nativeMatchingRepresentationBytesConstraint,
            },
          ],
        }),
      );
};
