import fixtures from "../../test/fixtures/robustness-cases.json";

export const robustnessCases = fixtures.map((fixture) => {
  const noise = "[info] successful background task finished\n".repeat(fixture.noiseLines ?? 160);
  const input = fixture.position === "start" ? fixture.signal + noise : fixture.position === "end" ? noise + fixture.signal : noise + fixture.signal + noise;
  const question = fixture.statusOnly ? "Return only PASS or FAIL." : fixture.family === "Terraform"
    ? "Return SAFE or UNSAFE. List risky changes with their exact original resource addresses and plan lines."
    : "Return PASS or FAIL. List failing items with their relevant raw error messages and source locations.";
  return { ...fixture, input, question, inputRequired: fixture.inputRequired ?? fixture.required };
});

// Gold labels are written in the fixture, not produced by the runtime extractor.
export function evaluateRobustnessOutput(fixture: typeof robustnessCases[number], output: string) {
  const normalized = output.replace(/\r\n?/g, "\n").replace(/\u001B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "").trim();
  const verdict = normalized.match(/^(PASS|FAIL|SAFE|UNSAFE)\b/)?.[1] ?? null;
  const missing = fixture.required.filter((anchor) => !normalized.includes(anchor));
  return {
    verdict, verdictPassed: verdict === fixture.verdict,
    required: fixture.required.length, retained: fixture.required.length - missing.length, missing,
    contractPassed: verdict === fixture.verdict && missing.length === 0
  };
}
