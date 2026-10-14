#!/usr/bin/env node
/**
 * @file Merge-time guard for the layer-state token ledger.
 *
 * Share-link `l` params encode layer membership as single tokens
 * (src/data/layerState.js). Tokens are permanent public authored state: a
 * token, once published, is never reused or re-assigned, or old share links
 * silently restore the wrong layers. This checker compares the working
 * tree's token reservations against the published Git base and fails the
 * merge when a published token changed, was removed, or a newcomer skipped
 * the next free token.
 *
 * Usage: node scripts/check-layer-state-tokens.mjs [--base-ref <ref>]
 * Exit 0 prints "<N> published, <M> new"; any violation exits 1 with the
 * reason on stderr. The companion helper scripts/next-layer-state-token.mjs
 * reports the token a new layer should claim.
 *
 * Phase 4 pre-cutover: these scripts were absent while
 * src/data/layerStateTokenLedger.test.mjs expected them; restored here to
 * the contract that test specifies.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  LEGACY_LAYER_STATE_TOKENS,
  parseLayerStateTokenReservations,
  validateLayerStateAllocations,
} from '../src/data/layerState.js';

/** Token shape contract (mirrors layerState.js): 1-2 lowercase alphanumerics. */
const TOKEN_PATTERN = /^[a-z0-9]{1,2}$/;

/** The token map that predates the ledger file — ownership, not allocation. */
export const PRE_LEDGER_LAYER_STATE_TOKENS = Object.freeze({
  ...LEGACY_LAYER_STATE_TOKENS,
});

const LEDGER_REL = 'src/data/layerStateTokenReservations.json';
const SOURCE_REL = 'src/data/layerState.js';

function gitShow(baseRef, relPath, cwd) {
  try {
    return execFileSync('git', ['show', `${baseRef}:${relPath}`], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return null;
  }
}

/** Extract an inline `LAYER_STATE_TOKEN_RESERVATIONS = {...}` literal from old sources. */
function parseInlineReservations(source) {
  const match = source.match(
    /LAYER_STATE_TOKEN_RESERVATIONS\s*=\s*(?:Object\.freeze\(\s*)?(\{[\s\S]*?\})\s*\)?;/,
  );
  if (!match) return null;
  try {
    const value = new Function(`return (${match[1]});`)();
    if (!value || typeof value !== 'object') return null;
    return Object.freeze({ ...value });
  } catch {
    return null;
  }
}

/**
 * Read the token reservations as published at a Git ref.
 * Prefers the JSON ledger; falls back to an inline reservations literal in
 * the published source; throws when neither is recognizable.
 */
export function readPublishedLayerStateReservations(
  baseRef = 'HEAD',
  cwd = process.cwd(),
) {
  const ledger = gitShow(baseRef, LEDGER_REL, cwd);
  if (ledger !== null) {
    return parseLayerStateTokenReservations(JSON.parse(ledger));
  }
  const source = gitShow(baseRef, SOURCE_REL, cwd);
  if (source !== null) {
    const inline = parseInlineReservations(source);
    if (inline) {
      return parseLayerStateTokenReservations(
        Object.entries(inline),
      );
    }
  }
  throw new Error(
    `no recognizable layer-state token ledger at ${baseRef} ` +
      `(looked for ${LEDGER_REL} and an inline LAYER_STATE_TOKEN_RESERVATIONS)`,
  );
}

/** Read the working tree's candidate reservations.
 *
 * Precedence: an inline `LAYER_STATE_TOKEN_RESERVATIONS` literal in the
 * working tree's source wins over the JSON ledger — the source is what a
 * merge actually ships, so a source/ledger skew must fail against the
 * published base, not silently pass on the ledger alone. Sources that build
 * their reservations from the ledger (the normal pattern) have no inline
 * literal and fall through to the JSON.
 */
function readCandidateReservations(cwd) {
  let source = null;
  try {
    source = readFileSync(path.join(cwd, SOURCE_REL), 'utf8');
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
  }
  if (source !== null) {
    const inline = parseInlineReservations(source);
    if (inline) {
      // The inline literal is the merge's truth verbatim: validate shapes,
      // not ledger completeness (a partial inline source must still fail
      // against the published base via validateLayerStateAllocations).
      const candidate = {};
      const seenTokens = new Set();
      for (const [id, token] of Object.entries(inline)) {
        if (typeof id !== 'string' || !TOKEN_PATTERN.test(token)) {
          throw new Error(`Invalid layer-state token reservation: ${id}`);
        }
        if (seenTokens.has(token)) {
          throw new Error(
            `Duplicate layer-state token reservation: ${token}`,
          );
        }
        seenTokens.add(token);
        candidate[id] = token;
      }
      return Object.freeze(candidate);
    }
  }
  try {
    const ledger = readFileSync(path.join(cwd, LEDGER_REL), 'utf8');
    return parseLayerStateTokenReservations(JSON.parse(ledger));
  } catch (err) {
    if (err?.code === 'ENOENT' && source !== null) {
      throw new Error(
        `no recognizable layer-state token ledger in the working tree ` +
          `(looked for an inline LAYER_STATE_TOKEN_RESERVATIONS in ${SOURCE_REL} ` +
          `and for ${LEDGER_REL})`,
      );
    }
    throw err;
  }
}

/**
 * Fail closed when the working tree's reservations violate the published
 * base. Returns { published, new } counts for the success report.
 */
export function checkLayerStateTokens(baseRef = 'HEAD', cwd = process.cwd()) {
  const published = readPublishedLayerStateReservations(baseRef, cwd);
  const candidate = readCandidateReservations(cwd);
  validateLayerStateAllocations(published, candidate);
  const fresh = Object.keys(candidate).filter(
    (id) => !Object.hasOwn(published, id),
  );
  return { published: Object.keys(published).length, new: fresh.length };
}

const invokedAsCli =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));

if (invokedAsCli) {
  let baseRef = 'HEAD';
  const flag = process.argv.indexOf('--base-ref');
  if (flag !== -1 && process.argv[flag + 1]) baseRef = process.argv[flag + 1];
  try {
    const { published, new: fresh } = checkLayerStateTokens(
      baseRef,
      process.cwd(),
    );
    console.log(`${published} published, ${fresh} new`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
