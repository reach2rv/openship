# Release runbook — shipping `deploy/main` to your servers

`deploy/main` = upstream v0.8.0 + Azure DevOps support + prebuilt zip artifact
upload + file manager + fork-infra (GHCR/300m edge). Everything the panel needs
ships from this one branch.

## 1. Publish images + CLI (from your machine, once per release)

A tag push `v*.*.*` on `deploy/main` triggers both workflows:
`docker-images.yml` → `ghcr.io/reach2rv/openship-{api,dashboard,edge,mail,webmail}:<ver>` + `:latest`
`release.yml` → GitHub release with the CLI payload (what `scripts/install.sh` resolves)

```sh
git fetch fork deploy/main
git tag v0.8.0-fork.1 fork/deploy/main
git push fork v0.8.0-fork.1
# watch: https://github.com/reach2rv/openship/actions
```

Test build without moving `:latest` (no release):

```sh
gh workflow run docker-images.yml --ref deploy/main -f tag=0.8.0-fork.1-rc.1
```

## 2. Make the images pullable

GHCR packages from a personal repo are **private** by default. Either:

- GitHub → your profile → Packages → `openship-api` → Package settings →
  Change visibility → Public (repeat per package), **or**
- keep them private and on each server run `docker login ghcr.io` with a PAT
  that has `read:packages`.

## 3. Bootstrap the EC2 panel host

Fresh Ubuntu 22.04/24.04 instance, security group open on 22/80/443, DNS
A record → the instance's public IP. **Do not co-install with aaPanel** —
both want ports 80/443; the deploy script aborts if it detects a conflict.

```sh
ssh ubuntu@<instance-ip>
sudo -i
PANEL_DOMAIN=panel.example.com \
  sh -c "$(curl -fsSL https://raw.githubusercontent.com/reach2rv/openship/deploy/main/scripts/deploy-panel.sh)"
```

(or clone the repo and run `PANEL_DOMAIN=… sh scripts/deploy-panel.sh`).

The `openship up` wizard finishes the install: admin user, domain, boot
service. Then open `https://panel.example.com`, log in as the admin, and:

1. Settings → Git → Azure DevOps: connect each customer org with its PAT
   (Code Read + Service Hooks R/W).
2. Servers → add the EC2 app hosts (SSH) — the file manager + terminal ride
   the pooled SSH connection.
3. Per customer app: Library → Azure tab (git) or upload tab (prebuilt
   publish zip), or point a release source at your registry image and let
   Azure Pipelines trigger deploys via the incoming webhook.

## 4. Upgrades

```sh
openship update          # CLI + images to the latest fork release
```

Fork maintenance: merge `oblien/openship:main` into `deploy/main` when you
want upstream fixes; PR #636 and the artifact/file-manager work stay as
feature branches that only merge INTO `deploy/main`.
