import type { ExecutionOptions } from "./AnalysisProvider.js";
import type { BrowserScenarioCapturePort } from "./BrowserScenarioCapturePort.js";
import { createBrowserScenarioEvidence } from "./BrowserScenarioEvidence.js";
import {
  AnalysisCancelledError,
  AnalysisCapabilityUnavailableError,
  AnalysisOutputError,
} from "../domain/analysisErrorCore.js";
import type { AnalysisError } from "../domain/analysisErrorBase.js";
import type { Evidence } from "../domain/evidence.js";
import {
  browserScenarioSecretAvailability,
  type BrowserScenario,
} from "../domain/browserScenario.js";
import { BROWSER_SCENARIO_START_STEP_ID } from "../domain/browserScenarioValues.js";
import type { AnalysisInputError } from "../domain/analysisErrorCore.js";
import { err, ok, type Result } from "../domain/result.js";
import { browserScenarioCaptureSchema } from "../domain/browserScenarioCapture.js";
import {
  completeProviderEvidence,
  keepIncompleteObservation,
} from "./ProviderOperationExecution.js";

const OPERATION = "capture_browser_scenario" as const;
const PROVIDER_ID = "rea-playwright-browser-scenario";

/** Execute one controlled browser scenario using its explicit request scope. */
export const captureBrowserScenario = async (
  provider: BrowserScenarioCapturePort | undefined,
  scenario: BrowserScenario,
  options: ExecutionOptions = {},
): Promise<Result<Evidence, AnalysisError>> => {
  if (provider === undefined)
    return err(
      new AnalysisCapabilityUnavailableError(
        PROVIDER_ID,
        OPERATION,
        "browser scenario provider is not configured",
      ),
    );
  if (options.signal?.aborted)
    return err(
      new AnalysisCancelledError(OPERATION, { cause: options.signal.reason }),
    );
  const captured = await provider.captureScenario(scenario, options);
  if (!captured.ok) {
    const partial = captured.error.partialObservation;
    if (
      partial !== undefined &&
      "kind" in partial &&
      partial.kind === "browser-scenario-observation"
    ) {
      const report = browserScenarioCaptureSchema.safeParse(partial.capture);
      // Only a completed capture becomes Evidence. A JSON-safe incomplete
      // observation stays on the owner error, including typed cancellation.
      if (
        report.success &&
        report.data.steps.every(({ status }) => status === "completed")
      ) {
        captured.error.partialObservation = createBrowserScenarioEvidence(
          scenario,
          report.data,
          provider.identity(),
        );
        return captured;
      }
    }
    return err(
      keepIncompleteObservation(
        captured.error,
        OPERATION,
        "Browser scenario provider retained a non-JSON incomplete observation.",
      ),
    );
  }
  const report = browserScenarioCaptureSchema.safeParse(captured.value);
  if (!report.success)
    return err(
      new AnalysisOutputError(
        OPERATION,
        "Browser scenario provider returned a malformed completed capture.",
        { cause: report.error },
      ),
    );
  return completeProviderEvidence(
    createBrowserScenarioEvidence(scenario, report.data, provider.identity()),
    options.signal,
  );
};

/** What a dry run checked, and the explicit stages it stopped before. */
export interface BrowserScenarioPlan {
  readonly operation: typeof OPERATION;
  readonly dry_run: true;
  readonly browser_mode: BrowserScenario["browser"]["mode"];
  readonly start_origin: string;
  /** Steps in capture order, including the initial navigation step. */
  readonly steps: readonly {
    readonly step_id: string;
    readonly action: string;
  }[];
  readonly secrets: readonly {
    readonly secret_id: string;
    readonly environment_variable: string;
    readonly environment_value: "present";
  }[];
  readonly not_checked: readonly string[];
}

const NOT_CHECKED = [
  "browser executable, CDP endpoint and target discovery",
  "browser launch or attachment",
  "navigation, network reachability and page state",
  "locator resolution, action outcomes and capture limits",
] as const;

/**
 * Apply the execution rules that need no browser to an already parsed
 * scenario, then stop before any provider is created. Secret values are
 * never read.
 */
export const planBrowserScenario = (
  scenario: BrowserScenario,
  environment: Readonly<Record<string, string | undefined>>,
): Result<BrowserScenarioPlan, AnalysisInputError> => {
  const available = browserScenarioSecretAvailability(scenario, environment);
  if (!available.ok) return available;
  return ok({
    operation: OPERATION,
    dry_run: true,
    browser_mode: scenario.browser.mode,
    start_origin: new URL(scenario.start_url.url).origin,
    steps: [
      { step_id: BROWSER_SCENARIO_START_STEP_ID, action: "goto_start" },
      ...scenario.actions.map(({ step_id, action }) => ({ step_id, action })),
    ],
    secrets: scenario.secrets.map(({ secret_id, environment_variable }) => ({
      secret_id,
      environment_variable,
      environment_value: "present" as const,
    })),
    not_checked: NOT_CHECKED,
  });
};
