import { loadConfig } from "../core/config.js";
import { createLogger } from "../security/logger.js";
import { MailSentryApp } from "./app.js";

const log = createLogger("startup");

async function main(): Promise<void> {
  const config = loadConfig();
  const app = new MailSentryApp(config);
  await app.start();
  log.info("MailSentry is running", {
    url: config.baseUrl,
    bind: `${config.host}:${config.port}`,
    gmailConfigured: Boolean(config.google.clientId),
    microsoftConfigured: Boolean(config.microsoft.clientId),
  });
  process.stdout.write(`MailSentry listening on ${config.baseUrl}\n`);

  let stopping = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (stopping) return;
    stopping = true;
    log.info("shutting down", { signal });
    try {
      await app.stop();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  log.error("failed to start", { error });
  process.stderr.write(
    "MailSentry failed to start. Check MAILSENTRY_* environment variables and port availability.\n",
  );
  process.exit(1);
});
