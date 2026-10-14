#!/usr/bin/env node
/**
 * @file Report the token a new layer should claim.
 *
 * Usage: node scripts/next-layer-state-token.mjs <layer-id>
 * Prints "<layer-id>: <token>" for the next free token against the
 * published (HEAD) ledger. Read-only: it never rewrites the ledger — add
 * the reported row to src/data/layerStateTokenReservations.json and the
 * registry entry yourself, then let check-layer-state-tokens.mjs verify.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { nextLayerStateToken } from '../src/data/layerState.js';
import { readPublishedLayerStateReservations } from './check-layer-state-tokens.mjs';

const invokedAsCli =
  process.argv[1] &&
  path.resolve(process.argv[1]) ===
    path.resolve(fileURLToPath(import.meta.url));

if (invokedAsCli) {
  const [layerId] = process.argv.slice(2);
  if (!layerId) {
    console.error('usage: next-layer-state-token.mjs <layer-id>');
    process.exit(2);
  }
  try {
    const published = readPublishedLayerStateReservations(
      'HEAD',
      process.cwd(),
    );
    console.log(`${layerId}: ${nextLayerStateToken(published)}`);
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
}
