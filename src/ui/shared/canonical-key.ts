function encodeNumber(value: number): string {
    if (Number.isNaN(value)) return 'number:NaN';
    if (value === Infinity) return 'number:Infinity';
    if (value === -Infinity) return 'number:-Infinity';
    if (Object.is(value, -0)) return 'number:-0';
    return `number:${value}`;
}

export function canonicalRequestKey(value: unknown): string {
    if (value === null) return 'null';
    if (Array.isArray(value)) return `array:[${value.map(canonicalRequestKey).join(',')}]`;

    switch (typeof value) {
        case 'string': return `string:${JSON.stringify(value)}`;
        case 'number': return encodeNumber(value);
        case 'boolean': return `boolean:${value}`;
        case 'undefined': return 'undefined';
        case 'object': {
            const object = value as Record<string, unknown>;
            return `object:{${Object.keys(object).sort().map(
                (key) => `${JSON.stringify(key)}:${canonicalRequestKey(object[key])}`
            ).join(',')}}`;
        }
        default:
            throw new TypeError(`Unsupported request-key value: ${typeof value}`);
    }
}
