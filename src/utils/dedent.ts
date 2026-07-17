/**
 * Remove common leading whitespace from a template literal string.
 * This allows template literals to be indented with the code
 * without including that indentation in the output.
 */
export function dedent(strings: TemplateStringsArray, ...values: any[]): string {
    // Combine the template literal parts with interpolated values
    let result = '';
    for (let i = 0; i < strings.length; i++) {
        result += strings[i];
        if (i < values.length) {
            result += values[i];
        }
    }

    // Split into lines and find common leading whitespace
    const lines = result.split('\n');

    // Find the first non-empty line to determine base indentation
    let minIndent = Infinity;
    for (const line of lines) {
        if (line.trim().length === 0) continue;
        const match = line.match(/^(\s*)/);
        if (match) {
            const indent = match[1].length;
            if (indent < minIndent) {
                minIndent = indent;
            }
        }
    }

    // If no indented lines found, return as-is
    if (minIndent === Infinity || minIndent === 0) {
        return result.trim();
    }

    // Remove common leading whitespace from each line
    const dedented = lines.map(line => {
        if (line.trim().length === 0) return '';
        return line.slice(minIndent);
    });

    // Join and trim leading/trailing whitespace
    return dedented.join('\n').trim();
}
