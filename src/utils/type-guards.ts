/**
 * This is a generic type guard for checking if an object has a property.
 *
 * @param obj The object to check
 * @param key The property to check for
 * @returns True if the object has the property, false otherwise
 */
export function hasProperty<T extends object, K extends PropertyKey>(
  obj: T,
  key: K
): obj is T & Record<K, unknown> {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

/**
 * Type guard to check if the value is of the expected type
 *
 * @param value The value to check
 * @param type The expected type ('string', 'number', 'boolean', etc.)
 * @returns True if the value is of the expected type, false otherwise
 */
export function isType<T>(value: unknown, type: string): value is T {
  return typeof value === type;
}
