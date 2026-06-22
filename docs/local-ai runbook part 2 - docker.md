# Part 2: Docker Management and NVIDIA GPU Container Operations

Version: 1.0  
Date: 2026-06-21  
Scope: Docker management, Docker Compose usage, NVIDIA GPU assignment, Portainer, and home-network access for a local AI experimentation host

---

## 0. Purpose

This runbook is a hardware-agnostic companion to the base host setup guide.

Use this document after the host already has:

- A Linux OS installed
- A working NVIDIA driver
- Docker Engine installed from the official Docker repository
- Docker Compose v2 installed as the Docker CLI plugin
- NVIDIA Container Toolkit installed and configured for Docker
- A persistent AI workspace for experiments, models, outputs, and caches

This guide is intentionally NVIDIA-focused. It does not cover AMD ROCm, Intel GPUs, Kubernetes, Slurm, or cloud GPU platforms.

The goal is to manage a single-machine Docker AI host cleanly and repeatably, regardless of whether the host has one NVIDIA GPU or multiple NVIDIA GPUs.

---

## 1. Operating model

Use Docker Compose files as the source of truth.

Use Portainer as a convenience UI for:

- Viewing containers
- Checking logs
- Restarting services
- Inspecting images, volumes, networks, and resource use
- Managing simple local stacks when appropriate

Do not let Portainer become the only record of how an AI stack was configured. For repeatability, each important AI service should still have a project folder with a `compose.yaml`, `.env`, README, pinned image tags where practical, and documented model paths.

Recommended management model:

```text
Host Linux
  NVIDIA driver
  Docker Engine
  Docker Compose plugin
  NVIDIA Container Toolkit
  Portainer optional UI

AI projects
  one folder per service or experiment
  compose.yaml source of truth
  model weights outside images
  generated outputs outside images
  caches outside images
```

---

## 2. Reference facts

Use these references to verify the assumptions behind this runbook:

- Docker Engine Ubuntu install guide: https://docs.docker.com/engine/install/ubuntu/
- Docker Compose plugin install guide: https://docs.docker.com/compose/install/linux/
- Docker GPU access guide: https://docs.docker.com/engine/containers/gpu/
- Docker Compose GPU support guide: https://docs.docker.com/compose/how-tos/gpu-support/
- NVIDIA Container Toolkit install guide: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html
- NVIDIA Container Toolkit Docker specialized configuration guide: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/docker-specialized.html
- Portainer CE Docker install guide: https://docs.portainer.io/start/install-ce/server/docker/linux
- Portainer CE Docker Hub image page: https://hub.docker.com/r/portainer/portainer-ce

---

## 3. Ground rules

1. Use `docker compose`, with a space. Do not install the old standalone `docker-compose` v1 binary.
2. Do not manually download a Compose binary into `/usr/local/bin` unless you are deliberately maintaining a legacy system.
3. Use Compose device reservations for GPU services.
4. Do not set both `count` and `device_ids` in the same GPU reservation.
5. Prefer GPU UUIDs for stable multi-GPU assignment.
6. Bind AI web UIs to `127.0.0.1` by default.
7. Expose Portainer to the LAN only if you understand that it can control Docker on the host.
8. Never expose Portainer directly to the public internet.
9. Do not put API keys, Hugging Face tokens, SSH keys, or service passwords in Dockerfiles, image layers, committed `.env` files, or shell history.
10. Do not run destructive cleanup commands such as `docker system prune -a --volumes` without an explicit backup or human approval.

---

## 4. Verify the base installation

Run this before setting up management tools.

```bash
set -euo pipefail

echo "# OS"
lsb_release -a || cat /etc/os-release
uname -a

echo

echo "# Docker"
docker version
docker compose version
docker info | grep -Ei 'Server Version|Storage Driver|Logging Driver|Cgroup Driver|Runtimes|Default Runtime|Docker Root Dir' || true

echo

echo "# NVIDIA host visibility"
nvidia-smi
```

Expected result:

- Docker Engine responds.
- `docker compose version` works.
- `nvidia-smi` works on the host.
- One or more NVIDIA GPUs appear in `nvidia-smi`.

Now verify GPU visibility from a container:

```bash
set -euo pipefail

docker run --rm --gpus all ubuntu nvidia-smi
```

If the Ubuntu image test fails but host `nvidia-smi` works, validate the NVIDIA Container Toolkit configuration:

```bash
set -euo pipefail

nvidia-ctk --version || true
docker info | grep -Ei 'Runtimes|Default Runtime' || true
cat /etc/docker/daemon.json | jq . || cat /etc/docker/daemon.json
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
docker run --rm --gpus all ubuntu nvidia-smi
```

Optional CUDA image test:

```bash
set -euo pipefail

CUDA_SMOKE_IMAGE="nvidia/cuda:13.3.0-base-ubuntu26.04"
docker run --rm --gpus all "$CUDA_SMOKE_IMAGE" nvidia-smi
```

If that CUDA image tag is unavailable or incompatible with your installed driver branch, choose a current pinned CUDA base image tag that matches your driver support window. The important management-layer test is that `nvidia-smi` works inside a GPU-enabled container.

---

## 5. Create or confirm a management workspace

This guide stores management configuration under the logged-in user's home directory.

```bash
set -euo pipefail

mkdir -p "$HOME/apps/docker-management"
mkdir -p "$HOME/apps/docker-management/portainer"
mkdir -p "$HOME/apps/docker-management/manifests"
chmod 700 "$HOME/apps/docker-management"
```

Recommended layout:

```text
~/apps/docker-management/
  portainer/      Portainer Compose file and .env
  manifests/      GPU inventory, Docker state snapshots, notes
```

This directory is for management tooling only. Keep AI experiment code, model weights, datasets, outputs, and caches wherever your Part 1 runbook defined them.

---

## 6. Record the NVIDIA GPU inventory

On a multi-GPU machine, do not rely only on GPU index numbers such as `0`, `1`, `2`, and `3`. Index order can change after hardware changes, driver changes, firmware changes, or slot/riser changes.

Record UUIDs, names, bus IDs, and memory sizes:

```bash
set -euo pipefail

mkdir -p "$HOME/apps/docker-management/manifests"
manifest="$HOME/apps/docker-management/manifests/gpu-inventory-$(date +%F-%H%M%S).csv"

nvidia-smi --query-gpu=index,uuid,name,pci.bus_id,memory.total,driver_version --format=csv | tee "$manifest"

echo "Wrote $manifest"
```

Also print a quick readable list:

```bash
nvidia-smi -L
```

Create a local mapping note:

```bash
nano "$HOME/apps/docker-management/manifests/gpu-map.md"
```

Example content:

```markdown
# GPU map

| Friendly name | GPU UUID | Physical card | Intended use |
|---|---|---|---|
| gpu-llm-main | GPU-REPLACE-ME | NVIDIA GPU name | LLM service |
| gpu-image-main | GPU-REPLACE-ME | NVIDIA GPU name | image generation |
| gpu-extra | GPU-REPLACE-ME | NVIDIA GPU name | experiments |
```

Use the full `GPU-...` UUID from `nvidia-smi` when possible.

---

## 7. Compose GPU assignment patterns

Docker Compose GPU access is configured under:

```yaml
services:
  service_name:
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
```

The `capabilities: [gpu]` field is required for Compose GPU reservations.

### Pattern A: service can use all GPUs

Use this only when the application is intended to see every GPU on the host.

```yaml
services:
  gpu-service:
    image: nvidia/cuda:13.3.0-base-ubuntu26.04
    command: nvidia-smi
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]
```

### Pattern B: service gets one arbitrary GPU

Docker chooses one available GPU.

```yaml
services:
  gpu-service:
    image: nvidia/cuda:13.3.0-base-ubuntu26.04
    command: nvidia-smi
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
```

This is simple, but it is not ideal for a multi-GPU AI workstation where each service should consistently land on a specific card.

### Pattern C: service gets one specific GPU by UUID

Use this for repeatable GPU assignment.

`.env`:

```dotenv
GPU_LLM_MAIN=GPU-REPLACE-WITH-FULL-UUID
```

`compose.yaml`:

```yaml
services:
  llm-service:
    image: nvidia/cuda:13.3.0-base-ubuntu26.04
    command: nvidia-smi --query-gpu=index,uuid,name,memory.total --format=csv
    env_file:
      - .env
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              device_ids:
                - "${GPU_LLM_MAIN}"
              capabilities: [gpu]
```

### Pattern D: service gets multiple specific GPUs

`.env`:

```dotenv
GPU_MODEL_A=GPU-REPLACE-WITH-FULL-UUID
GPU_MODEL_B=GPU-REPLACE-WITH-FULL-UUID
```

`compose.yaml`:

```yaml
services:
  multi-gpu-service:
    image: nvidia/cuda:13.3.0-base-ubuntu26.04
    command: nvidia-smi --query-gpu=index,uuid,name,memory.total --format=csv
    env_file:
      - .env
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              device_ids:
                - "${GPU_MODEL_A}"
                - "${GPU_MODEL_B}"
              capabilities: [gpu]
```

Important: exposing two GPUs to a container does not automatically make them behave like one larger GPU. The application inside the container must support multi-GPU execution.

### Pattern E: CPU-only service

Do not include a GPU reservation.

```yaml
services:
  cpu-service:
    image: ubuntu:24.04
    command: bash -lc "echo CPU-only service"
```

---

## 8. GPU assignment smoke-test project

Create a reusable GPU assignment test project.

```bash
set -euo pipefail

mkdir -p "$HOME/apps/docker-management/gpu-compose-test"
cd "$HOME/apps/docker-management/gpu-compose-test"

cat > .env <<'EOF_ENV'
# Replace this after running: nvidia-smi -L
GPU_TEST_DEVICE=GPU-REPLACE-WITH-FULL-UUID
CUDA_SMOKE_IMAGE=nvidia/cuda:13.3.0-base-ubuntu26.04
EOF_ENV
chmod 600 .env

cat > compose.yaml <<'EOF_COMPOSE'
name: gpu-compose-test

services:
  all-gpus:
    image: ${CUDA_SMOKE_IMAGE}
    command: nvidia-smi --query-gpu=index,uuid,name,memory.total --format=csv
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu]

  one-gpu-by-count:
    image: ${CUDA_SMOKE_IMAGE}
    command: nvidia-smi --query-gpu=index,uuid,name,memory.total --format=csv
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]

  one-gpu-by-id:
    image: ${CUDA_SMOKE_IMAGE}
    command: nvidia-smi --query-gpu=index,uuid,name,memory.total --format=csv
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              device_ids:
                - "${GPU_TEST_DEVICE}"
              capabilities: [gpu]
EOF_COMPOSE
```

Edit `.env` and replace `GPU_TEST_DEVICE` with a real UUID from `nvidia-smi -L`.

Run the tests:

```bash
set -euo pipefail

cd "$HOME/apps/docker-management/gpu-compose-test"

docker compose config

docker compose run --rm all-gpus
docker compose run --rm one-gpu-by-count
docker compose run --rm one-gpu-by-id

docker compose down
```

Success criteria:

- `all-gpus` shows every NVIDIA GPU assigned to Docker.
- `one-gpu-by-count` shows exactly one GPU.
- `one-gpu-by-id` shows the UUID selected in `.env`.

If `device_ids` with a UUID does not work on your Docker/Compose/NVIDIA runtime combination, use numeric IDs temporarily and record that limitation in `gpu-map.md`. Prefer fixing the stack so UUID-based assignment works before relying on the host for long-running services.

---

## 9. Standard Docker Compose lifecycle commands

From a project folder containing `compose.yaml`:

```bash
# Validate and render the final Compose configuration.
docker compose config

# Start in the foreground.
docker compose up

# Start in the background.
docker compose up -d

# Rebuild local images and start.
docker compose up -d --build

# View service status.
docker compose ps

# Follow logs.
docker compose logs -f

# Follow logs for one service.
docker compose logs -f service_name

# Stop and remove containers and networks for this project.
docker compose down

# Pull newer upstream images referenced by the Compose file.
docker compose pull

# Recreate after pulling newer images.
docker compose up -d

# Build without cache for this project only.
docker compose build --no-cache
```

Useful global Docker commands:

```bash
# Running containers.
docker ps

# All containers.
docker ps -a

# Local images.
docker image ls

# Disk usage summary.
docker system df

# Live container resource usage.
docker stats

# Docker networks.
docker network ls

# Docker volumes.
docker volume ls
```

Avoid these unless you know exactly what will be removed:

```bash
# Removes stopped containers, unused networks, dangling images, and build cache.
docker system prune

# More destructive. Can remove unused images and volumes.
docker system prune -a --volumes
```

---

## 10. Install Portainer with Docker Compose

Portainer is optional. It is useful for home-lab visibility and simple management, but it should not replace project-owned Compose files.

Create the Portainer project:

```bash
set -euo pipefail

mkdir -p "$HOME/apps/docker-management/portainer"
cd "$HOME/apps/docker-management/portainer"
```

Create `.env`:

```bash
cat > .env <<'EOF_ENV'
# Local-only default. Use SSH tunneling to access from another machine.
PORTAINER_BIND_IP=127.0.0.1
PORTAINER_HTTPS_PORT=9443

# Use the LTS channel for a management tool unless you intentionally want STS.
PORTAINER_IMAGE=portainer/portainer-ce:lts
EOF_ENV
chmod 600 .env
```

Create `compose.yaml`:

```bash
cat > compose.yaml <<'EOF_COMPOSE'
name: portainer

services:
  portainer:
    container_name: portainer
    image: ${PORTAINER_IMAGE:-portainer/portainer-ce:lts}
    restart: unless-stopped
    security_opt:
      - no-new-privileges:true
    ports:
      - "${PORTAINER_BIND_IP:-127.0.0.1}:${PORTAINER_HTTPS_PORT:-9443}:9443"
      # Port 8000 is only needed for Portainer Edge Agent tunnel features.
      # - "${PORTAINER_BIND_IP:-127.0.0.1}:8000:8000"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - portainer_data:/data

volumes:
  portainer_data:
    name: portainer_data
EOF_COMPOSE
```

Deploy:

```bash
set -euo pipefail

cd "$HOME/apps/docker-management/portainer"
docker compose config
docker compose up -d
docker compose ps
```

Open Portainer from the host:

```text
https://127.0.0.1:9443
```

The browser may warn about a self-signed certificate. That is expected for a local prototype unless you provide your own certificate.

Initial setup:

1. Create the first admin account.
2. Use a strong password.
3. Choose the local Docker environment.
4. Confirm that containers, images, volumes, and networks are visible.

---

## 11. Access Portainer from another computer

### Option A: SSH tunnel, recommended default

Keep Portainer bound to localhost and tunnel from another computer:

```bash
ssh -L 9443:127.0.0.1:9443 user@docker-hostname-or-ip
```

Then open this on the client computer:

```text
https://127.0.0.1:9443
```

This keeps Portainer off the LAN while still allowing remote browser access.

### Option B: Bind Portainer to a trusted LAN IP

Use this only on a trusted home or lab network.

First find the host's LAN IP:

```bash
ip -4 -br addr show scope global
```

Reserve that address in your router or configure a stable static IP.

Then edit the Portainer `.env` file:

```bash
cd "$HOME/apps/docker-management/portainer"
nano .env
```

Change:

```dotenv
PORTAINER_BIND_IP=127.0.0.1
```

to something like:

```dotenv
PORTAINER_BIND_IP=192.168.1.50
```

Recreate the container:

```bash
set -euo pipefail

cd "$HOME/apps/docker-management/portainer"
docker compose up -d

docker ps --filter "name=portainer" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
curl -k -I "https://192.168.1.50:9443" | head -n 1
```

Expected result:

```text
HTTP/1.1 200 OK
```

Open this from another computer on the same LAN:

```text
https://192.168.1.50:9443
```

Security notes:

- Do not forward port `9443` from your router to the internet.
- Do not bind to `0.0.0.0` unless you intentionally want every network interface to accept connections.
- Anyone who can authenticate to Portainer can control Docker through the mounted Docker socket.
- Docker-published ports can interact with host firewall rules in surprising ways; if you use `ufw` or another firewall, verify the actual exposure from another device.

---

## 12. Portainer operating guidelines

Use Portainer for:

- Container status
- Logs
- Restarting a stuck service
- Checking image age
- Checking volume and network names
- Basic one-off inspection

Prefer Compose files for:

- Defining AI services
- Defining GPU assignment
- Defining volume mounts
- Defining network exposure
- Rebuilding services
- Moving a project to another host
- Keeping a reproducible record of configuration

Avoid using the Portainer UI to manually mutate containers that are supposed to be managed by Compose. Those edits are easy to forget and hard to reproduce.

If you use Portainer Stacks, prefer Git-backed or file-backed stacks so the configuration remains recoverable.

---

## 13. Home-network access for AI web UIs

Most AI web UIs should not be exposed directly to the LAN by default.

Default Compose port pattern:

```yaml
ports:
  - "127.0.0.1:7860:7860"
```

Access remotely with an SSH tunnel:

```bash
ssh -L 7860:127.0.0.1:7860 user@docker-hostname-or-ip
```

Then open:

```text
http://127.0.0.1:7860
```

If you intentionally expose an AI web UI to the LAN, bind it to the specific LAN IP instead of all interfaces:

```yaml
ports:
  - "192.168.1.50:7860:7860"
```

Only do this for tools you trust on a network you trust. Many local AI web UIs were designed for local use and may not provide strong authentication, authorization, request isolation, or safe file-system boundaries.

---

## 14. Example: hardware-agnostic NVIDIA AI service template

This template demonstrates repeatable GPU assignment without naming any specific GPU model.

```bash
set -euo pipefail

mkdir -p "$HOME/apps/docker-management/example-nvidia-service"
cd "$HOME/apps/docker-management/example-nvidia-service"

cat > .env <<'EOF_ENV'
PROJECT_SLUG=example-nvidia-service
WEB_BIND_IP=127.0.0.1
WEB_PORT=7860
GPU_PRIMARY=GPU-REPLACE-WITH-FULL-UUID
CUDA_SMOKE_IMAGE=nvidia/cuda:13.3.0-base-ubuntu26.04
EOF_ENV
chmod 600 .env

cat > compose.yaml <<'EOF_COMPOSE'
name: ${PROJECT_SLUG:-example-nvidia-service}

services:
  gpu-check:
    image: ${CUDA_SMOKE_IMAGE:-nvidia/cuda:13.3.0-base-ubuntu26.04}
    command: nvidia-smi --query-gpu=index,uuid,name,memory.total --format=csv
    env_file:
      - .env
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              device_ids:
                - "${GPU_PRIMARY}"
              capabilities: [gpu]
EOF_COMPOSE

docker compose config
docker compose run --rm gpu-check
docker compose down
```

Replace `GPU_PRIMARY` with a real UUID from `nvidia-smi -L` before running.

For an actual AI service, keep the same GPU reservation block and replace the image, command, ports, and volumes with the service-specific requirements.

---

## 15. Example: one service per GPU pattern

This is useful when you want predictable isolation between multiple AI services.

`.env`:

```dotenv
GPU_LLM=GPU-REPLACE-WITH-FULL-UUID
GPU_IMAGE=GPU-REPLACE-WITH-FULL-UUID
GPU_EXPERIMENT=GPU-REPLACE-WITH-FULL-UUID
AI_ROOT=/home/YOUR_USER/ai
```

`compose.yaml` fragment:

```yaml
services:
  llm:
    image: your-llm-image:your-pinned-tag
    volumes:
      - ${AI_ROOT}/models:/models
      - ${AI_ROOT}/outputs/llm:/outputs
      - ${AI_ROOT}/cache:/cache
    ports:
      - "127.0.0.1:11434:11434"
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              device_ids:
                - "${GPU_LLM}"
              capabilities: [gpu]

  image-generator:
    image: your-image-generator:your-pinned-tag
    volumes:
      - ${AI_ROOT}/models:/models
      - ${AI_ROOT}/outputs/image-generator:/outputs
      - ${AI_ROOT}/cache:/cache
    ports:
      - "127.0.0.1:7860:7860"
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              device_ids:
                - "${GPU_IMAGE}"
              capabilities: [gpu]

  experiment:
    image: your-experiment-image:your-pinned-tag
    volumes:
      - ${AI_ROOT}/models:/models
      - ${AI_ROOT}/datasets:/datasets:ro
      - ${AI_ROOT}/outputs/experiment:/outputs
      - ${AI_ROOT}/cache:/cache
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              device_ids:
                - "${GPU_EXPERIMENT}"
              capabilities: [gpu]
```

This pattern keeps each service pinned to a known GPU.

---

## 16. Monitoring commands

Host GPU monitoring:

```bash
# Full snapshot.
nvidia-smi

# Refresh every two seconds.
watch -n 2 nvidia-smi

# Process monitor.
nvidia-smi pmon -c 1 || true

# Device monitor.
nvidia-smi dmon -s pucvmet -c 5 || true
```

If installed in Part 1, `nvtop` is useful for an interactive view:

```bash
nvtop
```

Docker monitoring:

```bash
docker ps
docker stats
docker system df
docker compose ps
docker compose logs -f
```

Find which containers are using GPUs:

```bash
nvidia-smi
```

Then correlate process IDs with containers if needed:

```bash
docker ps --format 'table {{.ID}}\t{{.Names}}\t{{.Image}}'
```

---

## 17. Backup Portainer

Portainer stores its local database in the `portainer_data` Docker volume.

Create a backup:

```bash
set -euo pipefail

cd "$HOME/apps/docker-management/portainer"
mkdir -p backups

docker compose down

docker run --rm \
  -v portainer_data:/data:ro \
  -v "$PWD/backups:/backup" \
  ubuntu \
  tar czf "/backup/portainer_data-$(date +%F-%H%M%S).tgz" -C /data .

docker compose up -d
ls -lh backups
```

Treat Portainer backups as sensitive. They may contain endpoint configuration, registry settings, stack definitions, and operational metadata.

Restore pattern:

```bash
set -euo pipefail

cd "$HOME/apps/docker-management/portainer"
docker compose down

docker volume create portainer_data || true

docker run --rm \
  -v portainer_data:/data \
  -v "$PWD/backups:/backup:ro" \
  ubuntu \
  bash -lc 'cd /data && tar xzf /backup/REPLACE-WITH-BACKUP-FILENAME.tgz'

docker compose up -d
```

---

## 18. Updating Portainer

Manual update pattern:

```bash
set -euo pipefail

cd "$HOME/apps/docker-management/portainer"

docker compose pull
docker compose up -d
docker compose ps
```

Optional cleanup after confirming the new container works:

```bash
docker image prune
```

Do not blindly auto-update every AI container. Model-serving images, CUDA images, Python dependencies, and inference backends can change behavior across versions. Prefer intentional updates with a smoke test.

---

## 19. Docker and firewall caution

Docker-published ports are implemented through Docker networking rules. On some Linux hosts, Docker-published ports can bypass assumptions you may have made with `ufw` or other host firewall tools.

Practical checks:

```bash
# List published container ports.
docker ps --format 'table {{.Names}}\t{{.Ports}}'

# Check listening sockets on the host.
ss -tulpn | grep -Ei 'docker|9443|7860|11434' || true
```

From another machine on the LAN, test only the ports you intentionally exposed.

Default posture:

- Bind AI web UIs to `127.0.0.1`.
- Use SSH tunnels for remote access.
- Bind Portainer to `127.0.0.1` unless LAN management is intentional.
- Never forward Portainer or unauthenticated AI UIs through the router to the internet.

---

## 20. Troubleshooting

### `docker compose version` fails

Likely cause: Docker Compose v2 plugin is not installed.

Fix:

```bash
sudo apt-get update
sudo apt-get install -y docker-compose-plugin
docker compose version
```

Do not install the old Compose v1 binary unless a legacy project explicitly requires it.

### Host `nvidia-smi` works but container GPU access fails

Likely causes:

- NVIDIA Container Toolkit is missing.
- Docker runtime was not configured with `nvidia-ctk`.
- Docker was not restarted after configuration.
- A daemon reload or service change disrupted GPU containers.

Commands:

```bash
nvidia-ctk --version || true
docker info | grep -Ei 'Runtimes|Default Runtime' || true
cat /etc/docker/daemon.json | jq . || cat /etc/docker/daemon.json
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
docker run --rm --gpus all ubuntu nvidia-smi
```

Restart affected GPU containers after Docker or NVIDIA runtime changes.

### Compose says GPU capabilities are missing

Make sure the GPU reservation includes:

```yaml
capabilities: [gpu]
```

### Compose rejects the GPU reservation

Check for these mistakes:

- `count` and `device_ids` both set in the same reservation
- Wrong indentation
- UUID copied incorrectly
- GPU UUID exists on a different host
- `.env` not in the project directory
- Compose file not run from the directory you expected

Validate with:

```bash
docker compose config
nvidia-smi -L
```

### Portainer is not reachable

Check container status and port binding:

```bash
cd "$HOME/apps/docker-management/portainer"
docker compose ps
docker compose logs --tail=100 portainer
docker ps --filter "name=portainer" --format "table {{.Names}}\t{{.Status}}\t{{.Ports}}"
```

If bound to `127.0.0.1`, Portainer is reachable only from the host itself or through an SSH tunnel.

If bound to a LAN IP, confirm the host still has that IP:

```bash
ip -4 -br addr show scope global
```

### Browser certificate warning for Portainer

Expected for the default self-signed certificate. For a local lab this is acceptable if you verify you are connecting to the correct host. For a more permanent setup, provide your own certificate or put Portainer behind a properly secured reverse proxy.

### Permission denied when running Docker without sudo

If Part 1 added your user to the `docker` group, log out and back in.

Validate:

```bash
id
docker run --rm hello-world
```

Security reminder: membership in the `docker` group is effectively root-equivalent on the host.

---

## 21. Rebuild checklist for Part 2

Use this when rebuilding the management layer on a new NVIDIA Docker host.

1. Verify Docker Engine works.
2. Verify `docker compose version` works.
3. Verify host `nvidia-smi` works.
4. Verify `docker run --rm --gpus all ubuntu nvidia-smi` works.
5. Create `~/apps/docker-management`.
6. Capture GPU inventory with UUIDs.
7. Create or update `gpu-map.md`.
8. Run the GPU Compose assignment smoke test.
9. Install Portainer with Compose.
10. Keep Portainer bound to localhost unless LAN access is intentional.
11. Configure SSH tunnel or explicit LAN binding.
12. Back up `portainer_data` after initial setup.
13. Keep AI services defined in their own Compose project folders.
14. Record changes in each project's README.

---

## 22. Final standard

The Docker management layer is ready when all of the following are true:

1. `docker compose version` works.
2. Host `nvidia-smi` works.
3. Container `nvidia-smi` works through Docker.
4. GPU UUID inventory has been saved.
5. A friendly GPU map exists.
6. A Compose smoke test can target all GPUs, one arbitrary GPU, and one specific GPU.
7. Portainer is running or deliberately skipped.
8. Portainer is bound only to the intended address.
9. No important AI service exists only as an undocumented manual UI change.
10. Project Compose files remain the source of truth.
