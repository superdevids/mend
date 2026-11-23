# mend

One command-line tool that applies the edits AI models write — unified diffs with
wrong line numbers, SEARCH/REPLACE blocks, the V4A patch format and text-editor
tool calls as JSON — to a tree of files, or nothing at all.

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

`SPEC.md` is the specification; `check.ts` runs the practice set.

Node 22 and its standard library alone. MIT.
