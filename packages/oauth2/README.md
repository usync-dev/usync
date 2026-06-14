# @usync/oauth2

[![NPM](https://img.shields.io/npm/v/@usync/oauth2.svg)](https://npmx.dev/package/@usync/oauth2)
![License](https://img.shields.io/npm/l/@usync/oauth2.svg)

OAuth2 support for provider-based authorization flows and token management.

This package focuses on the moving parts around OAuth2: turning provider configuration into authorizers, refreshing access tokens when needed, and completing interactive login flows when a user has not yet authorized access.

The design keeps authorization state and token handling separate from drive or sync logic, so storage adapters can reuse the same auth machinery without duplicating protocol code.
