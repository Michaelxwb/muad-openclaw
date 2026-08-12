# Test fixtures

- `insecure-fetch-test-cert.pem` / `insecure-fetch-test-key.pem` — throwaway self-signed
  certificate pair for `test/insecure-fetch.test.mjs`. Generated with a single `openssl
  req -x509` command, CN=localhost, valid 10 years. It is a **test-only** key used to
  exercise `createInsecureFetch()` against a local HTTPS server; it is not a credential
  and must never be used outside tests.
