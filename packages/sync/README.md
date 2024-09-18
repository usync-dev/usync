# @usync/sync

[![NPM](https://img.shields.io/npm/v/@usync/sync.svg)](https://npm.im/@usync/sync)
![License](https://img.shields.io/npm/l/@usync/sync.svg)
[![jsDocs.io](https://img.shields.io/badge/jsDocs.io-reference-blue)](https://www.jsdocs.io/package/@usync/sync)

Pure sync decision logic for normalized two-sided snapshots.

This package contains the core reconciliation model for the project. It compares two normalized snapshots, resolves conflicts deterministically, and produces abstract actions for the target side. IO, parsing, and snapshot construction are intentionally outside its scope.

The design is intentionally narrow:

- the input is already normalized
- the output is a small set of abstract actions
- the reconciliation rules are stable and deterministic

This makes the sync engine reusable across multiple storage layouts and adapters without coupling it to any specific backend format.
