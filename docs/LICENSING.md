# Licensing Review

This document records the project's licensing state and a compatibility review. It is not legal advice.

## Current license

MailSentry is licensed under the **MIT License**. The full text is in [`LICENSE`](../LICENSE).

```text
Copyright (c) 2026 RETRAC
```

The `package.json` license field is `MIT`, and the in-app Settings page reports MIT. MIT is an OSI-approved, permissive open-source license.

## What MIT allows

You may:

- use the software for personal, internal, or commercial purposes;
- copy and redistribute it;
- modify it and distribute modified versions;
- sublicense it;
- combine it with other code, including proprietary code.

You must:

- include the copyright notice and permission notice in copies or substantial portions of the software.

The software is provided **without warranty**. The authors are not liable for damages arising from its use.

MIT does not require publishing source changes, and it has no network-use copyleft clause.

## License history

The repository was initially created with the GNU Affero General Public License v3. It was not developed or distributed under AGPL beyond this local repository/initial commit. The repository owner subsequently requested a permissive open-source license, and the project was relicensed to MIT before any public release or external contribution.

There were no third-party contributions in the repository history at the time of relicensing. The copyright holder is RETRAC. Any future relicensing should be handled in a dedicated change with owner approval.

## Runtime dependencies

**Headless/server runtime dependencies: none.** The desktop artifact additionally bundles Electron (MIT) and its Chromium/Node runtime components; Electron's own license notices are included in `release/win-unpacked` as `LICENSE.electron.txt` and `LICENSES.chromium.html`. MailSentry adds no runtime npm dependency.

## Development dependencies

| Package               | License    | Distributed to users?                            |
| --------------------- | ---------- | ------------------------------------------------ |
| `electron`            | MIT        | Bundled only inside the Windows desktop artifact |
| `electron-builder`    | MIT        | No (packaging tool)                              |
| `typescript`          | Apache-2.0 | No (build-time)                                  |
| `esbuild`             | MIT        | No (build-time; output contains project code)    |
| `tsx`                 | MIT        | No (development runner)                          |
| `vitest`              | MIT        | No                                               |
| `@vitest/coverage-v8` | MIT        | No                                               |
| `eslint`              | MIT        | No                                               |
| `typescript-eslint`   | MIT        | No                                               |
| `prettier`            | MIT        | No                                               |
| `@types/node`         | MIT        | No                                               |

All are permissive and compatible with distributing the project under MIT. Development tools are not shipped in `dist/`; Electron is bundled only in the desktop artifact with its notices.

Transitive development dependencies may have other permissive licenses. Before a formal release, run an inventory:

```bash
npx license-checker --summary --production   # runtime tree should be empty
npx license-checker --summary
```

or inspect `node_modules/*/package.json`. This document does not enumerate every transitive package.

## Content and assets

- `src/web/favicon.svg`, the interface styles, and the application code are original project work.
- No third-party fonts, icon sets, images, or vendored source are included. The UI uses system fonts.
- Product name, tagline, and RETRAC identity are used as provided for this project.

## Third-party services

MIT covers the MailSentry source code only. Google, Microsoft, DNS providers, and other services have their own terms and privacy policies, which apply independently of this license.

## Release checklist

1. Keep `LICENSE`, `package.json`, README, CONTRIBUTING, and the Settings page in sync with the license.
2. Include the MIT notice in source or binary distributions.
3. Run a dependency-license inventory before publishing a release.
4. Record any future license change in the repository history with explicit owner approval.
