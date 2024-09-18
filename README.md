# usync

`usync` is a set of packages for connecting to remote storage, handling OAuth2-based authorization, and computing deterministic sync actions between normalized snapshots.

The project is split into small layers:

- authentication and token handling
- drive access and provider adapters
- pure sync decision logic

The design keeps IO and provider-specific behavior separate from the core sync engine so each layer can evolve independently.
