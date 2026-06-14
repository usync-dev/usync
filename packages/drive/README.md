# @usync/drive

[![NPM](https://img.shields.io/npm/v/@usync/drive.svg)](https://npmx.dev/package/@usync/drive)
![License](https://img.shields.io/npm/l/@usync/drive.svg)

Provider adapters and shared types for working with remote file storage.

This package isolates provider-specific details such as authentication, listing remote files, reading content, and writing changes. The goal is to present a consistent drive abstraction over multiple backends, including cloud providers and WebDAV-style services.

The design centers on a small set of provider implementations plus shared base classes and types. Authentication is handled alongside drive access so callers can work with a connected backend rather than juggling provider-specific protocol details.
