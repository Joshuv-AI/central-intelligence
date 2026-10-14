import { startApplicationChrome } from '../app/startupChrome.js';
export function startStandaloneChrome(options) {
  return startApplicationChrome({
    ...options,
  });
}
