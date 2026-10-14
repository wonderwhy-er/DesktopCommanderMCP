/**
 * Rollouts the server worked out for this user. The server writes them into
 * every call row (`metadata.rollouts`, e.g. { "check": true }), and the device
 * keeps the map from the latest call it took. Changes arrive with the next call.
 */
class RolloutManager {
  private rollouts: Record<string, boolean> = {};

  /**
   * Replace the rollouts with the map from the latest call row. Anything that
   * isn't a map of booleans (a row from an older server has none) means all off.
   * Returns whether the rollouts changed.
   */
  update(rollouts: unknown): boolean {
    const next = isRolloutMap(rollouts) ? { ...rollouts } : {};
    const changed = JSON.stringify(next) !== JSON.stringify(this.rollouts);
    this.rollouts = next;
    return changed;
  }

  /**
   * Get a rollout value
   */
  get(name: string, defaultValue: boolean = false): boolean {
    return this.rollouts[name] !== undefined ? this.rollouts[name] : defaultValue;
  }

  /**
   * Get all rollouts for debugging
   */
  getAll(): Record<string, boolean> {
    return { ...this.rollouts };
  }
}

function isRolloutMap(value: unknown): value is Record<string, boolean> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && Object.values(value).every((enabled) => typeof enabled === 'boolean');
}

export const rolloutManager = new RolloutManager();
