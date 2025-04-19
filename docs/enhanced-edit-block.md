# Enhanced Edit Block Functionality

The `edit_block` tool has been enhanced with several new features to make it more powerful and flexible. This document explains the new capabilities and how to use them.

## Core Enhancements

1. **Multiple Block Support**: You can now include multiple search/replace blocks in a single command
2. **Global Replacement**: Replace all occurrences of a pattern, not just the first one
3. **Counted Replacements**: Replace only a specific number of occurrences
4. **Case-Insensitive Matching**: Match patterns regardless of case
5. **Dry Run Mode**: Simulate replacements without actually modifying files
6. **Enhanced Error Handling**: Better error reporting with details

## Usage

### Basic Syntax with Flags

The `edit_block` command now supports optional flags in the search block delimiter:

```text
filepath
<<<<<<< SEARCH[:flags]
content to find
=======
new content
>>>>>>> REPLACE
```text

Where `flags` can be any combination of:
- `g`: Global replacement (replace all occurrences)
- `i`: Case-insensitive matching
- `d`: Dry run (don't actually modify the file)
- `n:X`: Replace only X occurrences (where X is a positive number)

For example:
```text
/path/to/file.txt
<<<<<<< SEARCH:gi
mixed case text
=======
REPLACED TEXT
>>>>>>> REPLACE
```text

### Multiple Blocks

You can include multiple search/replace blocks in a single edit_block command:

```text
/path/to/file.txt
<<<<<<< SEARCH
first pattern
=======
first replacement
>>>>>>> REPLACE
<<<<<<< SEARCH:g
second pattern
=======
second replacement (global)
>>>>>>> REPLACE
<<<<<<< SEARCH:i
THIRD pattern
=======
third replacement (case-insensitive)
>>>>>>> REPLACE
```text

## Examples

### Global Replacement

Replace all occurrences of a pattern:

```text
/path/to/file.txt
<<<<<<< SEARCH:g
function oldName
=======
function newName
>>>>>>> REPLACE
```text

### Counted Replacement

Replace only the first 3 occurrences of a pattern:

```text
/path/to/file.txt
<<<<<<< SEARCH:n:3
repeated text
=======
limited replacement
>>>>>>> REPLACE
```text

### Case-Insensitive Matching

Match a pattern regardless of case:

```text
/path/to/file.txt
<<<<<<< SEARCH:i
WARNING
=======
ERROR
>>>>>>> REPLACE
```text

This will match "WARNING", "Warning", "warning", etc.

### Combined Flags

Use multiple flags together:

```text
/path/to/file.txt
<<<<<<< SEARCH:n:2:i
error
=======
warning
>>>>>>> REPLACE
```text

This will replace the first 2 occurrences of "error", "Error", "ERROR", etc. with "warning".

### Dry Run

Test replacements without modifying the file:

```text
/path/to/file.txt
<<<<<<< SEARCH:d
sensitive change
=======
test replacement
>>>>>>> REPLACE
```text

The output will show what would be changed, but the file remains unmodified.

## Error Handling

The enhanced implementation provides better error messages for common issues:

1. **Malformed blocks**: Detailed information about syntax errors
2. **Pattern size limits**: Warnings for excessively large patterns
3. **Missing blocks**: Clear indication when no valid blocks are found
4. **Block-specific errors**: Each block's errors are reported separately

## Backward Compatibility

All existing `edit_block` usage patterns continue to work as before. The enhancements are fully backward compatible with the original implementation.
