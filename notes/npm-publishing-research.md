# npm publishing research

Checked 2026-09-19 against the live npm registry and official npm documentation. No existing research-notes directory was present, so this note uses `notes/`.

## Current package status

`schema-xml@0.2.0` was published and verified on npm on 2026-09-19.
The next release completes the Schema XML rebrand. The canonical repository is
[Asguho/schema-xml](https://github.com/Asguho/schema-xml).

Dixous's XML extension imports `parseXml` from `schema-xml`. The npm dependency
installation is `npm install schema-xml zod`.

An absent registry entry does not guarantee npm will accept a name; similarity
rules are also enforced at publication.

## Suggested release process

1. Complete the README, license, repository metadata, supported runtimes, and release notes. Run the project tests, then use `npm pack --dry-run` to review the distributable. Install a real generated tarball into a fresh consumer project and verify the documented imports and TypeScript inference. This consumer check is a recommendation; npm documents package-content inspection and testing before publication. ([Publishing guide](https://docs.npmjs.com/creating-and-publishing-unscoped-public-packages/), [publish reference](https://docs.npmjs.com/cli/v11/commands/npm-publish/))
2. For an initial manual release, use an authenticated npm account with 2FA, select a new version, and publish. Use explicit `npm publish --access public` for a public scoped package. Official guide and newer CLI reference disagree on the default scoped visibility, so make the intended visibility explicit. Published name/version pairs cannot be reused, even after unpublishing. ([Scoped publishing](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/), [publish reference](https://docs.npmjs.com/cli/v11/commands/npm-publish/))
3. For subsequent releases, prefer GitHub Actions trusted publishing with OIDC over stored write tokens. Configure the authorized repository/workflow in npm and grant the workflow `id-token: write`. The documented minimum is npm 11.5.1 and Node 22.14.0. Public packages released from public GitHub repositories receive automatic provenance. Set `repository.url` correctly. New trusted-publisher configurations can be stage-only; explicitly permit `npm publish` if choosing direct releases. ([Trusted publishing](https://docs.npmjs.com/trusted-publishers/))

The initial research was read-only; publication was completed in the subsequent release work.
