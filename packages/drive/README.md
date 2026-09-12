# @usync/drive

[![NPM](https://img.shields.io/npm/v/@usync/drive.svg)](https://npmx.dev/package/@usync/drive)
![License](https://img.shields.io/npm/l/@usync/drive.svg)

Provider adapters and shared types for working with remote file storage.

This package isolates provider-specific details such as authentication, listing remote files, reading content, and writing changes. The goal is to present a consistent drive abstraction over multiple backends, including cloud providers and WebDAV-style services.

The design centers on a small set of provider implementations plus shared base classes and types. Authentication is handled alongside drive access so callers can work with a connected backend rather than juggling provider-specific protocol details.

## Exports

| Entry                                                                                                                                            | Contents                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| `@usync/drive`<br>[![BundleJS](https://deno.bundlejs.com/badge?q=@usync/drive&badge=detailed)](https://bundlejs.com/?q=@usync/drive)             | `connectDrive` and the built-in providers: Google Drive, Dropbox, OneDrive, S3, WebDAV, GitHub Contents |
| `@usync/drive/git`<br>[![BundleJS](https://deno.bundlejs.com/badge?q=@usync/drive/git&badge=detailed)](https://bundlejs.com/?q=@usync/drive/git) | The `Git` provider (smart-HTTP) and `MemoryFs`; separate entry because it pulls in isomorphic-git |

The `git` entry is not registered by default — pass it to `connectDrive`:

```ts
import { connectDrive } from "@usync/drive";
import { Git } from "@usync/drive/git";

const drive = await connectDrive(config, { providers: { git: Git } });
```
