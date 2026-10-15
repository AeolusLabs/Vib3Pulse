// Reconnect timing for the app socket, pure so it can be tested.

/**
 * The delay moved by up to 30% either way (`rand` is Math.random()): after a server restart every open tab drops at the same
 * moment, and without the spread they would all come back in the same instant, again and again.
 */
export function jittered(delay: number, rand: number): number {
  return Math.round(delay * (0.7 + 0.6 * rand));
}
