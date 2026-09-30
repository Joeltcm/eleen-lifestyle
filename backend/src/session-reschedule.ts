/**
 * A schedule change is a reprogramming when the start instant changes.
 * Keeping this predicate shared prevents the application PATCH and the Google
 * Calendar pull from disagreeing about a move made only by changing the hour.
 */
export function scheduleWasMoved(previousStartsAt: Date | string, nextStartsAt: Date | string): boolean {
  return new Date(previousStartsAt).getTime() !== new Date(nextStartsAt).getTime();
}
