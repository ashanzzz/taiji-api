# Operations

## Local service
Use Node.js 24. Start with npm start from the project root.
The foreground process stops when its terminal closes.
For a persistent service, use Docker restart policies or an OS service manager.
Do not stop every node process on a shared computer. Identify this service by its command and listening port.

## Secrets
Set ADMIN_KEY and PROXY_API_KEY separately in the deployment environment.
If ADMIN_KEY is absent, read the generated key in data/auth.json locally.
Never commit this file. Do not put either key in a screenshot, issue, or log.
Use the admin form for the upstream password. Blank password input preserves the saved password.
A saved account takes precedence over bootstrap environment credentials.

## Backup
Stop the service or take a consistent volume snapshot.
Back up the complete data directory, including master.key, settings.json, schedule.json, tests.json, and logs.json.
Keep backups encrypted. Restore the key and ciphertext together.
Do not share the data directory across replicas or copy it into a container image.

## Update and rollback
1. Back up the data volume.
2. Check the new commit's test results and release notes.
3. Pull the sha-<commit> image tag from the private registry.
4. Recreate the container without deleting the volume.
5. Check /healthz, admin login, and a small model request.
6. To roll back, recreate the container with the prior commit tag and compatible data backup.

## Troubleshooting
- 401 admin: use ADMIN_KEY, not the NewAPI key or upstream password.
- 400 reasoning or max_tokens: the feature is not verified for this channel. Remove the unsupported option.
- 409 new origin: inspect the hostname, then add it to trustedHosts if you trust it.
- 429 busy: wait for the current test or cancel it from the console.
- 502 upstream: inspect sanitized logs. Do not automatically replay paid requests.
- No daily sign-in: check enabled, time window, service uptime, login, and lastResult.
- Windows EPERM: put DATA_DIR outside a synced folder if file locks persist. The store retries short transient locks.
- Browser cannot connect from another device: check bind address and a subnet-scoped firewall rule.

## Network exposure
Keep the admin page behind HTTPS for non-local use. Set SECURE_COOKIES=true.
Do not disable the Windows firewall. Scope any rule to the intended port and trusted subnet.
Same-origin protection is not encryption. Plain HTTP exposes credentials to network observers.

## CI and registry
The default-branch workflow runs local tests and a container smoke test before publishing.
It publishes linux/amd64 and linux/arm64 images to GHCR using GITHUB_TOKEN.
No Taiji credentials are required by CI.
Keep repository and package visibility private. Verify package visibility after the first publication.
Action versions are pinned to commits. Dependabot tracks action and base-image updates.
