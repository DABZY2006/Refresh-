import { setImmediate } from "node:timers/promises";
import { AnalysisResourceConstraintError } from "../../domain/analysisErrorCore.js";
import { analysisSettingLimit } from "../../domain/analysisSettingDefinitions.js";
import {
  DEFAULT_NATIVE_MATCHING_REPRESENTATION_BYTES,
  MAXIMUM_NATIVE_MATCHING_REPRESENTATION_BYTES,
} from "../../domain/analysisResourceLimits.js";
import {
  DEFAULT_NATIVE_MATCHING_ALLOWANCE,
  NATIVE_MATCHING_ALLOWANCE_SETTING,
  type NativeMatchingAllowance,
} from "../../config/nativeMatchingAllowance.js";

const MEBIBYTE = 1024 * 1024;
const byteAllowance = (bytes: number): string =>
  Number.isInteger(bytes / MEBIBYTE)
    ? `${String(bytes / MEBIBYTE)} MiB / ${String(bytes)} bytes`
    : `${String(bytes)} bytes`;

/** User-visible recovery for the effective matching representation allowance. */
const nativeMatchingAllowanceRecovery = (
  allowance: NativeMatchingAllowance,
): string =>
  [
    `Native function matching is limited to ${byteAllowance(allowance.maximumBytes)} of representation${allowance.source === "setting" ? ` by ${NATIVE_MATCHING_ALLOWANCE_SETTING}` : ""}.`,
    `On MCP, call update_analysis_settings with setting native.matching_representation_bytes, action set, and a value in bytes up to ${byteAllowance(MAXIMUM_NATIVE_MATCHING_REPRESENTATION_BYTES)} (default ${byteAllowance(DEFAULT_NATIVE_MATCHING_REPRESENTATION_BYTES)}), then retry the original request. It applies to the next operation without restarting REA. For CLI or future REA processes, set ${NATIVE_MATCHING_ALLOWANCE_SETTING} in the launch environment.`,
    "This budget is not a bound on total process RSS; raising it lets matching retain more representation in the REA process.",
    "Splitting inventories into separate matches changes global name and body uniqueness, so it is not an equivalent workaround.",
    "Repeating the unchanged request fails the same way.",
  ].join(" ");

/** Budget the actual selected observations, before cloning or index allocation. */
export class NativeMatchingAdmission {
  readonly #maximum: number;
  readonly #source: NativeMatchingAllowance["source"];
  #remaining: number;
  #work = 0;
  readonly #seen = new WeakSet<object>();
  constructor(
    readonly operation: string,
    readonly signal?: AbortSignal,
    allowance: NativeMatchingAllowance = DEFAULT_NATIVE_MATCHING_ALLOWANCE,
  ) {
    // Read the accepted operation's value once, so the refusal reports the
    // budget this request actually ran under.
    this.#maximum = allowance.maximumBytes;
    this.#source = allowance.source;
    this.#remaining = this.#maximum;
  }
  readonly checkpoint = async (bytes = 0): Promise<void> => {
    this.#remaining -= bytes;
    if (this.#remaining < 0)
      throw new AnalysisResourceConstraintError(
        this.operation,
        "capacity",
        `Native function matching exceeds its ${byteAllowance(this.#maximum)} representation allowance (native.matching_representation_bytes).`,
        { maximum_bytes: this.#maximum },
        {
          retryable: false,
          remediationAction: nativeMatchingAllowanceRecovery({
            maximumBytes: this.#maximum,
            source: this.#source,
          }),
          limit: analysisSettingLimit(
            "native.matching_representation_bytes",
            this.#maximum,
            this.#source,
          ),
        },
      );
    this.signal?.throwIfAborted();
    if (++this.#work % 256 === 0)
      await setImmediate(
        undefined,
        this.signal === undefined ? {} : { signal: this.signal },
      );
  };
  async admit(root: unknown): Promise<void> {
    const pending: Iterator<unknown>[] = [[root][Symbol.iterator]()];
    while (pending.length) {
      const next = pending[pending.length - 1]!.next();
      if (next.done) {
        pending.pop();
        continue;
      }
      const value = next.value;
      if (typeof value === "object" && value !== null) {
        if (this.#seen.has(value)) continue;
        this.#seen.add(value);
        await this.checkpoint(128);
        // Iterator traversal avoids a second width-sized array of child values.
        pending.push(
          (function* () {
            for (const key in value)
              if (Object.hasOwn(value, key)) {
                yield key;
                yield (value as Record<string, unknown>)[key];
              }
          })(),
        );
      } else
        await this.checkpoint(
          typeof value === "string" ? 64 + value.length * 4 : 128,
        );
    }
  }
}
