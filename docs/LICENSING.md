# Licensing Review

This document records the licensing state and a compatibility review. It is not legal advice.

## Current license

The repository was initialized with the full text of the **GNU Affero General Public License, version 3** (`LICENSE`). That pre-existing license has been **preserved**, not replaced.

The implementation adds no separate license headers and does not relicense existing content. `package.json` declares `AGPL-3.0-only` to match the version-3-only text; the repository owner may prefer `AGPL-3.0-or-later` if an “or later” grant is intended. This is a decision for the copyright holder.

### Discrepancy with the implementation brief

The brief proposed **MIT**, “subject to a compatibility review.” The repository already contained AGPL-3.0 before implementation. Project instructions also said not to overwrite a pre-existing license without review. Therefore:

- AGPL-3.0 remains in place.
- The README and SECURITY policy state the mismatch openly.
- No attempt was made to silently relicense or remove the existing terms.

### What a relicensing decision involves

AGPL-3.0 is a strong copyleft license with a network-use clause. MIT is permissive. Moving from AGPL to MIT would require:

1. Confirmation that the copyright holder(s) own or control all contributed code.
2. Replacement of the `LICENSE` file and package metadata.
3. Review of any future contributions made under AGPL; those contributors would need to agree to relicensing (or their contributions removed).
4. A note in release history explaining the change.

There is only an initial commit plus this implementation in the current history; no external contributions were present at audit time. A relicensing decision is nonetheless an owner decision and is not made here.

## Runtime dependencies

**None.** The server, CLI, diagnostics, cleanup core, and browser bundle use Node.js built-ins and hand-written TypeScript/CSS. Nothing is vendored from third parties.

This means MailSentry itself introduces no runtime third-party license obligations beyond Node.js and the project license.

## Development dependencies

Top-level development dependencies at implementation time:

| Package               | License    | Distributed to users?                         |
| --------------------- | ---------- | --------------------------------------------- |
| `typescript`          | Apache-2.0 | No (build-time)                               |
| `esbuild`             | MIT        | No (build-time; bundle contains project code) |
| `tsx`                 | MIT        | No (development runner)                       |
| `vitest`              | MIT        | No                                            |
| `@vitest/coverage-v8` | MIT        | No                                            |
| `eslint`              | MIT        | No                                            |
| `typescript-eslint`   | MIT        | No                                            |
| `prettier`            | MIT        | No                                            |
| `@types/node`         | MIT        | No                                            |

All are permissive licenses compatible with distributing the project under AGPL-3.0. They are development-only and are not shipped in the application bundle or runtime image produced by `npm run build` (the `dist/` output contains compiled project code plus the bundled browser client).

Transitive development dependencies may carry other permissive licenses. Run a license inventory before a formal release, for example:

```bash
npx license-checker --summary --production   # runtime tree should be empty
npx license-checker --summary                # includes development tree
```

or inspect `node_modules/*/package.json` licenses. This review did not enumerate every transitive package.

## Content and assets

- `src/web/favicon.svg` and the interface styles are original project assets.
- No third-party fonts, icon sets, images, or copied code are included. The UI uses system fonts.
- DNS parsing, OAuth flows, provider adapters, and UI code were written for this project; no provider SDK code was copied.
- Product name, tagline, and RETRAC identity are used as provided in the brief.

## Distribution implications

- AGPL-3.0 requires source availability to users interacting with the software over a network if a modified version is offered as a service. MailSentry is local-first, but operators who expose modified versions should review AGPL obligations.
- MIT would permit broader reuse and proprietary integration. Choosing it is a business/community decision, not a technical blocker for this codebase.
- Provider API terms (Google, Microsoft) are separate from the software license and must be followed regardless of the repository license.

## Recommendation

1. Have the copyright holder confirm the intended license (retain AGPL-3.0 or relicense to MIT).
2. If relicensing, do it in a dedicated commit with a clear rationale and updated README/package metadata.
3. Before any public release, run a full dependency-license inventory and record it in release notes.
4. Keep this document updated if the decision changes.

No legal conclusions beyond license compatibility of the listed dev dependencies are asserted.
