import { Cli } from "incur";
import pino from "pino";
import { describe, expect, it, vi } from "vitest";

import type { BrowserScenarioCapturePort } from "../../../src/application/BrowserScenarioCapturePort.js";
import { BrowserScenarioSecrets } from "../../../src/browser/BrowserScenarioSecrets.js";
import { registerBrowserScenarioCommands } from "../../../src/cliBrowserScenarioCommands.js";
import { projectAnalysisError } from "../../../src/domain/analysisErrorProjection.js";
import { browserScenarioSchema } from "../../../src/domain/browserScenario.js";
import { cliTest } from "../../support/cli/cliFixture.js";

const SECRET_VALUE = "dry-run-secret-value-1234";

const scenario = {
  browser: { mode: "launch", executable_path: "/rea-missing/browser" },
  start_url: {
    url: "https://example.test/login",
    query: [
      {
        name: "token",
        value: { source: "secret", secret_id: "api_token" },
      },
    ],
  },
  actions: [
    { step_id: "settle", action: "wait_for_timeout", duration_ms: 1 },
    {
      step_id: "account",
      action: "goto",
      destination: { url: "https://example.test/account" },
      wait_until: "load",
    },
  ],
  secrets: [{ secret_id: "api_token", environment_variable: "REA_DRY_TOKEN" }],
};

/** One in-process CLI whose provider factory records every invocation. */
const scenarioCli = (environment: Readonly<Record<string, string>>) => {
  const createProvider = vi.fn((): BrowserScenarioCapturePort => {
    throw new Error("A dry run must not create a browser provider");
  });
  const cli = Cli.create("rea-scenario-dry-run-test", { sync: false });
  registerBrowserScenarioCommands(cli, pino({ level: "silent" }), environment, {
    createProvider,
  });
  const serve = async (input: unknown, ...flags: string[]) => {
    let stdout = "";
    await cli.serve(
      ["capture-browser-scenario", JSON.stringify(input), ...flags, "--json"],
      {
        env: {},
        stdout: (text) => {
          stdout += text;
        },
        exit: () => undefined,
      },
    );
    return { stdout, json: JSON.parse(stdout) as Record<string, unknown> };
  };
  return { createProvider, serve };
};

describe("capture-browser-scenario --dry-run", () => {
  it("returns the plan without creating a provider or reading secret values into output", async () => {
    const { createProvider, serve } = scenarioCli({
      REA_DRY_TOKEN: SECRET_VALUE,
    });
    const { stdout, json } = await serve(scenario, "--dry-run");
    expect(json).toEqual({
      operation: "capture_browser_scenario",
      dry_run: true,
      browser_mode: "launch",
      start_origin: "https://example.test",
      steps: [
        { step_id: "scenario_start", action: "goto_start" },
        { step_id: "settle", action: "wait_for_timeout" },
        { step_id: "account", action: "goto" },
      ],
      secrets: [
        {
          secret_id: "api_token",
          environment_variable: "REA_DRY_TOKEN",
          environment_value: "present",
        },
      ],
      not_checked: expect.arrayContaining(["browser launch or attachment"]),
    });
    expect(stdout).not.toContain(SECRET_VALUE);
    expect(createProvider).not.toHaveBeenCalled();
  });

  it("refuses a missing secret environment variable with the execution rule's error", async () => {
    const { createProvider, serve } = scenarioCli({});
    const { json } = await serve(scenario, "--dry-run");
    const parsed = browserScenarioSchema.parse(scenario);
    const execution = BrowserScenarioSecrets.resolve(parsed, {});
    if (execution.ok) throw new Error("Missing secret resolved");
    expect(json).toEqual({
      error: "Browser scenario validation failed",
      ...projectAnalysisError(execution.error),
    });
    expect(json).toMatchObject({
      code: "invalid_request",
      details: {
        issues: [
          {
            path: ["secrets", 0, "environment_variable"],
            reason: "missing_argument",
          },
        ],
      },
    });
    // An inherited or non-string value is not an available secret.
    const inherited = Object.create({ REA_DRY_TOKEN: SECRET_VALUE }) as Record<
      string,
      string
    >;
    expect(
      (await scenarioCli(inherited).serve(scenario, "--dry-run")).json,
    ).toMatchObject({ code: "invalid_request" });
    expect(createProvider).not.toHaveBeenCalled();
  });

  it("reports schema and semantic errors exactly as execution does", async () => {
    const invalid = {
      ...scenario,
      actions: [...scenario.actions, scenario.actions[0]],
      secrets: [],
    };
    const dry = scenarioCli({ REA_DRY_TOKEN: SECRET_VALUE });
    const executed = scenarioCli({ REA_DRY_TOKEN: SECRET_VALUE });
    const { json: dryJson } = await dry.serve(invalid, "--dry-run");
    const { json: executedJson } = await executed.serve(invalid);
    expect(dryJson).toMatchObject({
      error: "Browser scenario validation failed",
      code: "invalid_request",
      details: {
        issues: expect.arrayContaining([
          expect.objectContaining({
            path: ["actions"],
            message: "Action step IDs must be unique",
          }),
          expect.objectContaining({
            path: ["secrets"],
            message: "Secret reference api_token is not declared",
          }),
        ]),
      },
    });
    const { error: dryLabel, ...dryProjection } = dryJson;
    const { error: executedLabel, ...executedProjection } = executedJson;
    expect([dryLabel, executedLabel]).toEqual([
      "Browser scenario validation failed",
      "Browser scenario capture failed",
    ]);
    expect(dryProjection).toEqual(executedProjection);
    expect(dry.createProvider).not.toHaveBeenCalled();
    expect(executed.createProvider).not.toHaveBeenCalled();
  });

  it("still runs execution when the flag is omitted", async () => {
    const { createProvider, serve } = scenarioCli({
      REA_DRY_TOKEN: SECRET_VALUE,
    });
    const { json } = await serve(scenario);
    expect(json).not.toHaveProperty("dry_run");
    expect(createProvider).toHaveBeenCalledOnce();
  });
});

cliTest(
  "validates a scenario through the compiled CLI without a browser",
  async ({ cli }) => {
    const valid = await cli.run({
      arguments: [
        "capture-browser-scenario",
        JSON.stringify(scenario),
        "--dry-run",
        "--json",
      ],
      environment: { REA_LOG_LEVEL: "silent", REA_DRY_TOKEN: SECRET_VALUE },
    });
    expect(valid.exitCode).toBe(0);
    expect(valid.json).toMatchObject({ dry_run: true, browser_mode: "launch" });
    expect(valid.stdout).not.toContain(SECRET_VALUE);
    const missing = await cli.run({
      arguments: [
        "capture-browser-scenario",
        JSON.stringify(scenario),
        "--dry-run",
        "--json",
      ],
      environment: { REA_LOG_LEVEL: "silent" },
    });
    expect(missing.exitCode).not.toBe(0);
    expect(missing.json).toMatchObject({
      code: "invalid_request",
      details: { issues: [{ path: ["secrets", 0, "environment_variable"] }] },
    });
  },
);
