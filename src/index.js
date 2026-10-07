#!/usr/bin/env node
// Entry point. Loads configuration, wires the clients, and runs the bridge
// until it receives SIGINT or SIGTERM.

import { loadConfig, ConfigError } from "./config.js";
import { createLogger } from "./logger.js";
import { PaperclipClient } from "./paperclip-client.js";
import { SimplexClient } from "./simplex-client.js";
import { StateStore } from "./state-store.js";
import { Bridge } from "./bridge.js";

export async function main(env = process.env) {
  let config;
  try {
    config = loadConfig(env);
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 2;
      return null;
    }
    throw error;
  }

  const logger = createLogger(config.logLevel);
  const paperclip = new PaperclipClient({
    baseUrl: config.paperclipApiUrl,
    token: config.paperclipApiToken,
    companyId: config.paperclipCompanyId,
    logger,
    requestTimeoutMs: config.requestTimeoutMs,
    retries: config.maxRetries,
    retryBaseMs: config.retryBaseMs,
    retryMaxMs: config.retryMaxMs,
  });
  const simplex = new SimplexClient({
    url: config.simplexWsUrl,
    timeoutMs: config.commandTimeoutMs,
    logger,
  });
  const state = new StateStore(config.statePath, { historyLimit: config.processedHistoryLimit });
  const bridge = new Bridge({ config, logger, paperclip, simplex, state });

  await bridge.start();
  logger.info("bridge running; press Ctrl+C to stop");

  const shutdown = async (signal) => {
    logger.info(`received ${signal}, shutting down`);
    await bridge.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  return bridge;
}

const isDirectRun = process.argv[1] && import.meta.url === `file://${process.argv[1]}`;
if (isDirectRun) {
  main().catch((error) => {
    process.stderr.write(`fatal: ${error.stack || error.message}\n`);
    process.exit(1);
  });
}
