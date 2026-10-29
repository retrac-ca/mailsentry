import { normalizeDomain, normalizeSelector } from "../security/validation.js";
import { runDiagnostics } from "../diagnostics/index.js";
import { APP_NAME, APP_VERSION } from "../shared/version.js";
import { redactString } from "../security/redact.js";

interface CliArgs {
  domain: string;
  selector: string;
  json: boolean;
}

function parseArgs(argv: string[]): CliArgs | null {
  const positional: string[] = [];
  let selector = "";
  let json = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] ?? "";
    if (arg === "--json") {
      json = true;
    } else if (arg === "--selector") {
      selector = argv[index + 1] ?? "";
      index += 1;
    } else if (arg.startsWith("--selector=")) {
      selector = arg.slice("--selector=".length);
    } else if (arg === "--help" || arg === "-h") {
      return null;
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    }
  }
  if (positional.length !== 1) return null;
  return { domain: positional[0] as string, selector, json };
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (!args) {
    process.stderr.write(
      [
        `Usage: npm run diagnose -- <domain> [--selector <dkim-selector>] [--json]`,
        ``,
        `Example: npm run diagnose -- example.com --selector 20230601`,
        ``,
        `Performs bounded public DNS lookups only. No email is sent and no records are changed.`,
        ``,
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }

  try {
    const report = await runDiagnostics({
      domain: normalizeDomain(args.domain),
      dkimSelector: normalizeSelector(args.selector),
    });
    if (args.json) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      return;
    }
    const lines: string[] = [
      `${APP_NAME} ${APP_VERSION} — Email health for ${report.domain}`,
      `Checked: ${report.checkedAt}   Status: ${report.status}`,
      "",
    ];
    for (const finding of report.findings) {
      lines.push(`[${finding.severity.toUpperCase()}] ${finding.title} (${finding.confidence})`);
      lines.push(`  Observed: ${finding.observed}`);
      lines.push(`  Why it matters: ${finding.whyItMatters}`);
      lines.push(`  Next step: ${finding.recommendation}`);
      lines.push("");
    }
    lines.push("Limitations:");
    for (const limitation of report.limitations) lines.push(`- ${limitation}`);
    process.stdout.write(`${lines.join("\n")}\n`);
  } catch (error) {
    const message = redactString(error instanceof Error ? error.message : "Diagnostics failed.");
    process.stderr.write(`Error: ${message}\n`);
    process.exitCode = 1;
  }
}

void main();
