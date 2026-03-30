/**
 * @fileoverview File-based cache for API responses.
 * Keys are `{packageName}@{version}` strings. TTL is read from bot.config.json.
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { CACHE } from "./constants.js";
import { logger } from "./logger.js";

/** @typedef {{ value: unknown; expiresAt: number }} CacheEntry */

/** @type {Map<string, CacheEntry>} In-memory mirror of the disk cache */
let memoryCache = new Map();

/** @type {boolean} Whether the cache has been hydrated from disk */
let hydrated = false;

/**
 * Loads the on-disk cache file into memory. Called lazily on first access.
 *
 * @returns {Promise<void>}
 */
async function hydrate() {
  if (hydrated) return;
  hydrated = true;

  if (!existsSync(CACHE.CHANGELOG_FILE)) return;

  try {
    const raw = await readFile(CACHE.CHANGELOG_FILE, "utf8");
    const parsed = JSON.parse(raw);
    memoryCache = new Map(Object.entries(parsed));
    logger.debug({ entries: memoryCache.size }, "Cache hydrated from disk");
  } catch (error) {
    logger.warn({ error: error.message }, "Failed to hydrate cache — starting fresh");
    memoryCache = new Map();
  }
}

/**
 * Persists the in-memory cache to disk.
 *
 * @returns {Promise<void>}
 */
async function persist() {
  try {
    await mkdir(CACHE.DIR, { recursive: true });
    const serializable = Object.fromEntries(memoryCache);
    await writeFile(CACHE.CHANGELOG_FILE, JSON.stringify(serializable, null, 2), "utf8");
  } catch (error) {
    logger.warn({ error: error.message }, "Failed to persist cache to disk");
  }
}

/**
 * Retrieves a cached value by key. Returns undefined if missing or expired.
 *
 * @param {string} key - Cache key, e.g. "lodash@4.17.21"
 * @returns {Promise<unknown | undefined>}
 */
export async function get(key) {
  await hydrate();
  const entry = memoryCache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    memoryCache.delete(key);
    return undefined;
  }
  return entry.value;
}

/**
 * Stores a value in the cache with a TTL.
 *
 * @param {string} key - Cache key, e.g. "lodash@4.17.21"
 * @param {unknown} value - Serializable value to store
 * @param {number} ttlHours - Time-to-live in hours
 * @returns {Promise<void>}
 */
export async function set(key, value, ttlHours = CACHE.DEFAULT_TTL_HOURS) {
  await hydrate();
  const expiresAt = Date.now() + ttlHours * 60 * 60 * 1_000;
  memoryCache.set(key, { value, expiresAt });
  await persist();
}

/**
 * Removes a single entry from the cache.
 *
 * @param {string} key - Cache key to invalidate
 * @returns {Promise<void>}
 */
export async function invalidate(key) {
  await hydrate();
  memoryCache.delete(key);
  await persist();
}
