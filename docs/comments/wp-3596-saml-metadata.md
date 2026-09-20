# WP 3596: recommended comment for `SamlAuthentication#metadata`

`backend/modules/authentication/saml/authentication.ts` — above `metadata()`:

```ts
/**
 * `node-saml` publishes a signing `KeyDescriptor` only when a `privateKey` is set and an encryption
 * one only when a `decryptionPvk` is, and throws when either is set without its certificate. A pair
 * missing its public half is dropped here instead, so a strategy that signs requests but has no
 * certificate pasted yet still serves valid metadata. The library reads the private keys for
 * presence alone; only the public certificates reach the output.
 */
```
