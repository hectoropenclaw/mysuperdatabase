# SupaNow Secrets Hardening

Last reviewed: 2026-06-17

Goal:

- Prevent leaked credentials from entering git.
- Keep deployment credentials scoped, rotatable, and project-specific.
- Make leaked token recovery repeatable.

## Default rules

- Never put provider tokens in repo URLs.
- Use deploy keys or GitHub App installation tokens for private repository access.
- Store runtime secrets in the project secret store, not in tracked `.env` files.
- Prefer short-lived tokens for automation when the provider supports them.
- Rotate any token that appeared in chat, terminal history, logs, or deployment URLs.

## Local audit

Run this before commits and before deploying control-plane changes:

```bash
infra/scripts/audit-secrets.sh
```

The script reports only the file and line where a risky pattern appears. It does not print the full secret value.

## If a GitHub token leaked

1. Revoke the token in GitHub immediately.
2. Remove token-bearing remotes from local git config.
3. Replace clone credentials with a deploy key or GitHub App integration.
4. Rotate any downstream token that may have been reachable with that GitHub token.
5. Re-run `infra/scripts/audit-secrets.sh`.
6. Re-deploy the affected app with the new secret source.

## Recommended private repo flow

For Launchpad/Coolify/SupaNow-managed apps:

- GitHub App or deploy key grants read access to one repo.
- The token/key is stored as an encrypted provider credential.
- Project deploy jobs receive a temporary checkout credential.
- Logs redact URL credentials before persisting output.
- Revocation happens per project, not globally.

## Rotation cadence

- Rotate manually after any suspected exposure.
- Rotate provider tokens at least every 90 days.
- Rotate project service-role credentials after team member offboarding.
- Keep old credentials valid only long enough for a controlled cutover.
