/**
 * @fileoverview Structured JSON logger wrapping pino.
 * All pipeline output goes through this logger — never console.log.
 */

import pino from "pino";
import { LOG_LEVEL } from "./constants.js";

const isDevelopment = process.env.NODE_ENV !== "production";

/**
 * Creates and returns the application-wide logger instance.
 * In development, output is pretty-printed. In production (GitHub Actions),
 * output is newline-delimited JSON for native log parsing.
 *
 * @returns {import('pino').Logger} Configured pino logger
 */
function createLogger() {
  const transport = isDevelopment
    ? { target: "pino-pretty", options: { colorize: true, translateTime: "SYS:standard" } }
    : undefined;

  return pino(
    {
      level: process.env.LOG_LEVEL ?? LOG_LEVEL.INFO,
      base: { pid: process.pid },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    transport ? pino.transport(transport) : undefined
  );
}

export const logger = createLogger();
