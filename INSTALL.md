# Install / Adoption Notes

Because the accessible sandbox did not contain your repo files, this kit is packaged as drop-in standards rather than an applied patch.

## Copy into repo

```bash
cp -R coding-standards-kit/* /path/to/repo/
```

## Wire TypeScript packages

1. Copy `configs/ts/tsconfig.base.json` into your TS package or reference it from package `tsconfig.json`:

```json
{
  "extends": "../../configs/ts/tsconfig.base.json",
  "include": ["src"]
}
```

2. Copy/adapt `configs/ts/eslint.config.mjs` and `configs/ts/prettier.config.mjs`.
3. Add scripts from `configs/ts/package.scripts.example.json`.

## Wire API contracts

1. Put OpenAPI files under `api/openapi/` or `contracts/openapi/`.
2. Use `configs/openapi/api-style-rules.yaml` with Spectral or your preferred OpenAPI linter.
3. Make contract validation blocking in CI.

## Wire MCP standards

1. Create a capability spec from `templates/mcp-capability-spec.md` for every tool/resource/prompt.
2. Implement a registry-based capability loader.
3. Add lifecycle/capability-negotiation tests before adding real tools.

## PR workflow

Use checklists from `checklists/` in PR descriptions until all relevant checks are automated.
