# Releasing Dixous

npm publishes `dixous`; JSR publishes `@asguho/dixous`. Keep the version in
`package.json`, `package-lock.json`, and `deno.json` identical. Both registries
must receive the same release source. Published versions cannot be replaced.

## Verify locally

Use Node 24.18.1, npm 11.16.0, and Deno 2.9.6 (the CI versions).

```sh
npm ci
npm run check:release
npm test
npm run test:package
deno publish --dry-run
```

During local edits, use `deno publish --dry-run --allow-dirty`.
The package test builds `dist/dixous-VERSION.tgz`, installs it into a temporary
consumer, runs the type assertion suite against its declarations, and exercises
its public API. Source imports use `.ts`; TypeScript rewrites them to `.js` for
npm. JSR publishes the TypeScript source directly.

## First publication

Authenticate with `npm login`, then publish the verified tarball:

```sh
npm publish ./dist/dixous-0.1.0.tgz --access public
```

Complete npm's authentication/2FA prompt if requested. Create the JSR package
`@asguho/dixous` at <https://jsr.io/new>, then run `deno publish` from the same
release commit and complete browser authentication.

## Trusted publishing

Push `.github/workflows/release.yml` to `Asguho/Dixous`. Create a GitHub
`package-publish` environment restricted to `main`. In npm's package settings,
configure a GitHub Actions trusted publisher with:

- Organization/user: `Asguho`
- Repository: `Dixous`
- Workflow: `release.yml`
- Environment: `package-publish`
- Allow direct `npm publish`

Link `Asguho/Dixous` in the JSR package settings to enable GitHub OIDC publishing.
The workflow grants `id-token: write`; it needs no stored registry tokens.

## Subsequent releases

1. Update both manifests and run `npm install --package-lock-only`.
2. Commit and push to `main`; wait for CI.
3. Run **Publish package (manual)** on `main`, choose `both`, and enter the exact
   version. You can also select a single registry.
4. Verify both registry entries before tagging the release commit.

The workflow repeats verification and publishes the tested npm tarball and JSR
source. If one registry fails after the other succeeds, retry only the missing
registry from the same commit and version.

References: [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/),
[JSR publishing](https://jsr.io/docs/publishing-packages).
