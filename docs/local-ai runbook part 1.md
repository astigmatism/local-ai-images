# Ubuntu 26.04 RTX 5080 AI Workstation Runbook

Version: 1.0  
Date: 2026-06-16  
Target host: Ubuntu 26.04 LTS on bare metal with an NVIDIA GeForce RTX 5080  
Primary goal: repeatable single-machine AI prototyping using Docker, Docker Compose, and the NVIDIA Container Toolkit

---

## 0. Operating model for a human or AI assistant

This document is written so that either a human administrator or an AI assistant can execute it step by step.

### Ground rules

1. Stop when a command fails. Read the error before continuing.
2. Do not install NVIDIA drivers from the `.run` installer unless explicitly troubleshooting a driver packaging issue.
3. Do not mix driver sources casually. Prefer Ubuntu packages first. Avoid combining Ubuntu driver packages, the graphics-drivers PPA, NVIDIA `.run` installers, and NVIDIA network repository driver packages on the same host without a deliberate migration plan.
4. Do not install a global CUDA toolkit, global Conda, or project-specific Python libraries on the host for normal prototyping. Keep those inside containers.
5. Reboot when instructed after kernel or NVIDIA driver changes. After reboot, resume at the next validation section.
6. Do not place API keys, Hugging Face tokens, SSH keys, or other secrets in Dockerfiles, Git repositories, image layers, or shell history.
7. Bind web UIs to `127.0.0.1` by default. Use SSH tunnels or a reverse proxy with authentication for remote access.
8. Do not run destructive cleanup commands such as `docker system prune -a --volumes` unless the human explicitly approves.

### Recommended architecture

Use the host only for:

- Ubuntu OS updates
- NVIDIA GPU driver
- Docker Engine and Docker Compose plugin
- NVIDIA Container Toolkit
- Basic monitoring and storage layout

Use containers for:

- Python versions
- CUDA user-space libraries
- PyTorch, TensorFlow, JAX, diffusers, ComfyUI, vLLM, llama.cpp, image generation stacks, video generation stacks, and other model-specific dependencies
- Per-project launch scripts and web UIs

Use persistent host folders for:

- Model weights
- Datasets
- Output artifacts
- Caches
- Experiment manifests

This keeps the machine easy to rebuild and prevents one model stack from contaminating another.

---

## 1. Reference facts used by this runbook

Use these references if another AI assistant needs to verify the assumptions behind the procedure.

- Docker Engine official Ubuntu install guide lists Ubuntu Resolute 26.04 LTS as a supported Ubuntu version: https://docs.docker.com/engine/install/ubuntu/
- Docker's post-install guide documents the `docker` group warning, optional non-root Docker usage, service enablement, and log driver guidance: https://docs.docker.com/engine/install/linux-postinstall/
- Ubuntu's NVIDIA driver guide recommends `ubuntu-drivers` and explains command-line driver installation: https://documentation.ubuntu.com/server/how-to/graphics/install-nvidia-drivers/
- NVIDIA Container Toolkit install guide documents installing the toolkit and configuring Docker with `nvidia-ctk runtime configure --runtime=docker`: https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html
- Docker Compose GPU support docs document GPU reservations using `deploy.resources.reservations.devices` and `capabilities: [gpu]`: https://docs.docker.com/compose/how-tos/gpu-support/
- NVIDIA's RTX 5080 page identifies the RTX 5080 as a Blackwell-generation GPU: https://www.nvidia.com/en-us/geforce/graphics-cards/50-series/rtx-5080/
- NVIDIA's CUDA GPU compute capability table lists the GeForce RTX 5080 with compute capability 12.0: https://developer.nvidia.com/cuda-gpus
- NVIDIA's open GPU kernel module guidance states that Blackwell GPUs must use the open-source GPU kernel modules: https://developer.nvidia.com/blog/nvidia-transitions-fully-towards-open-source-gpu-kernel-modules/
- PyTorch official install selector currently lists CUDA 12.8 and CUDA 13.0 wheels for recent PyTorch releases: https://pytorch.org/get-started/locally/
- PyTorch previous-version page lists exact CUDA 12.8 wheel commands for PyTorch 2.11.0: https://pytorch.org/get-started/previous-versions/

---

## 2. Approach decision

### Use Docker Engine, not Docker Desktop

For this bare-metal AI workstation, install Docker Engine from Docker's official apt repository. Docker Desktop is not necessary for this server/workstation pattern and adds extra layers that are not useful for repeatable GPU experimentation.

### Use Docker Compose as the main orchestrator

For one GPU workstation, Docker Compose is the best starting point. It is simple, repeatable, and supports GPU reservations. Kubernetes, Slurm, Nomad, or full MLOps platforms can be added later if you need multi-machine scheduling, shared clusters, or production deployments.

### Keep CUDA and Python inside containers

The host driver provides the kernel-level GPU interface. Containers provide CUDA user-space libraries and AI frameworks. This avoids host-level CUDA/Python dependency conflicts.

### Use one folder per experiment

Each experiment should include:

- `compose.yaml`
- `Dockerfile` or a pinned upstream image
- `.env`
- `README.md`
- `requirements.txt`, `pyproject.toml`, or model-specific dependency file if needed
- App code or a pinned Git commit reference

---

## 3. Initial host preflight

Run these commands on a fresh Ubuntu 26.04 install.

```bash
set -euo pipefail

lsb_release -a
uname -a
lspci | grep -Ei 'nvidia|vga|3d' || true
mokutil --sb-state || true
```

Expected result:

- Ubuntu reports version 26.04.
- The RTX 5080 appears in `lspci`.
- Secure Boot state is known. Secure Boot can work, but driver signing/MOK enrollment can affect NVIDIA driver loading.

Install basic packages and reboot after updates:

```bash
sudo apt update
sudo apt full-upgrade -y
sudo apt install -y \
  ubuntu-drivers-common \
  linux-headers-$(uname -r) \
  ca-certificates \
  curl \
  gnupg \
  lsb-release \
  git \
  git-lfs \
  jq \
  htop \
  nvtop \
  unzip

sudo reboot
```

After reboot, log back in and continue.

---

## 4. NVIDIA driver installation

### Important RTX 5080 note

The RTX 5080 is a Blackwell GPU. NVIDIA's guidance for Blackwell says to use the open-source GPU kernel modules. On Ubuntu, prefer an Ubuntu-packaged open NVIDIA driver variant such as `nvidia-driver-<branch>-open` when available.

### Inspect recommended drivers

```bash
set -euo pipefail

ubuntu-drivers devices
ubuntu-drivers list || true
ubuntu-drivers list --gpgpu || true
apt-cache search '^nvidia-driver-[0-9]+-open$' | sort || true
```

### Option A: Desktop/workstation install

Use this on a normal Ubuntu desktop/workstation install:

```bash
sudo ubuntu-drivers install
sudo reboot
```

After reboot, validate:

```bash
nvidia-smi
ubuntu-drivers devices
modinfo nvidia | grep -Ei 'filename|license|version' || true
dpkg-query -W 'nvidia-driver*' | sort || true
```

If the installed package is not an open variant, choose an available open driver package from Ubuntu apt. The exact package branch can change over time, so inspect first:

```bash
apt-cache search '^nvidia-driver-[0-9]+-open$' | sort
```

Example only, not a universal command:

```bash
# Replace 595 with the newest or recommended open branch shown by apt on this host.
# sudo apt install -y nvidia-driver-595-open
# sudo reboot
```

### Option B: Compute/headless install

Use this if the machine is a server or you do not need desktop graphics from the NVIDIA GPU:

```bash
sudo ubuntu-drivers install --gpgpu
sudo reboot
```

After reboot:

```bash
nvidia-smi
ubuntu-drivers list --gpgpu || true
modinfo nvidia | grep -Ei 'filename|license|version' || true
dpkg-query -W 'nvidia-driver*' | sort || true
```

### Driver success criteria

Proceed only when all are true:

1. `nvidia-smi` runs successfully.
2. The RTX 5080 appears in `nvidia-smi`.
3. No Nouveau driver is controlling the GPU.
4. The installed NVIDIA branch is recent enough for RTX 50-series/Blackwell support.
5. The driver package is an open kernel module variant or otherwise confirmed compatible with Blackwell.

---

## 5. Install Docker Engine from Docker's apt repository

Remove conflicting distribution packages first:

```bash
set -euo pipefail

for pkg in docker.io docker-doc docker-compose docker-compose-v2 podman-docker containerd runc; do
  sudo apt-get remove -y "$pkg" || true
done
```

Add Docker's official apt repository:

```bash
sudo apt-get update
sudo apt-get install -y ca-certificates curl
sudo install -m 0755 -d /etc/apt/keyrings
sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
sudo chmod a+r /etc/apt/keyrings/docker.asc

. /etc/os-release
DOCKER_CODENAME="${UBUNTU_CODENAME:-$VERSION_CODENAME}"

cat <<EOF_DOCKER | sudo tee /etc/apt/sources.list.d/docker.sources >/dev/null
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${DOCKER_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF_DOCKER

sudo apt-get update
```

Install Docker Engine, Buildx, and Compose plugin:

```bash
sudo apt-get install -y \
  docker-ce \
  docker-ce-cli \
  containerd.io \
  docker-buildx-plugin \
  docker-compose-plugin

sudo systemctl enable --now docker
sudo docker run --rm hello-world
```

Optional: allow the current user to run Docker commands without `sudo`.

Security note: membership in the `docker` group is effectively root-equivalent on the host. Only add trusted local users.

```bash
sudo groupadd docker || true
sudo usermod -aG docker "$USER"
newgrp docker

docker run --rm hello-world
```

If `newgrp docker` does not update the current shell as expected, log out and log back in.

---

## 6. Configure Docker daemon defaults

Set bounded local logging so containers cannot grow unlimited JSON logs. This command merges settings into an existing `/etc/docker/daemon.json` instead of overwriting it.

```bash
set -euo pipefail

sudo mkdir -p /etc/docker
if [ ! -f /etc/docker/daemon.json ]; then
  echo '{}' | sudo tee /etc/docker/daemon.json >/dev/null
fi

sudo cp /etc/docker/daemon.json /etc/docker/daemon.json.backup.$(date +%Y%m%d-%H%M%S)

tmp_json="$(mktemp)"
sudo jq '. + {"log-driver":"local","log-opts":{"max-size":"50m","max-file":"5"}}' /etc/docker/daemon.json > "$tmp_json"
sudo install -m 0644 "$tmp_json" /etc/docker/daemon.json
rm "$tmp_json"

sudo systemctl restart docker
```

Validate:

```bash
docker info | grep -Ei 'Logging Driver|Docker Root Dir|Cgroup Driver|Runtimes' || true
```

---

## 7. Install NVIDIA Container Toolkit

The NVIDIA Container Toolkit lets Docker containers access the host NVIDIA GPU.

```bash
set -euo pipefail

sudo apt-get update
sudo apt-get install -y --no-install-recommends ca-certificates curl gnupg2

curl -fsSL https://nvidia.github.io/libnvidia-container/gpgkey | \
  sudo gpg --dearmor -o /usr/share/keyrings/nvidia-container-toolkit-keyring.gpg

curl -s -L https://nvidia.github.io/libnvidia-container/stable/deb/nvidia-container-toolkit.list | \
  sed 's#deb https://#deb [signed-by=/usr/share/keyrings/nvidia-container-toolkit-keyring.gpg] https://#g' | \
  sudo tee /etc/apt/sources.list.d/nvidia-container-toolkit.list >/dev/null

sudo apt-get update
sudo apt-get install -y nvidia-container-toolkit

sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

Validate that Docker can see the GPU from a container:

```bash
nvidia-smi

docker run --rm --gpus all nvidia/cuda:13.3.0-base-ubuntu26.04 nvidia-smi
```

If the CUDA 13.3 image tag is not available or if your installed driver branch is older than required for that CUDA image, use a CUDA image tag compatible with your driver. The important test is that `nvidia-smi` inside the container reports the host GPU.

Known caution: NVIDIA documents a systemd/cgroup issue where running `systemctl daemon-reload` can cause running containers to temporarily lose GPU access on systems using systemd cgroups. Restart affected containers if this occurs.

---

## 8. Create the standard AI workspace layout

Create persistent directories under `/srv/ai`:

```bash
set -euo pipefail

sudo mkdir -p /srv/ai/{experiments,models,datasets,outputs,cache,logs,secrets,manifests,images}
sudo chown -R "$USER":"$USER" /srv/ai
chmod 700 /srv/ai/secrets
```

Recommended usage:

```text
/srv/ai/
  experiments/   One subfolder per Docker Compose project
  models/        Shared model weights, checkpoints, LoRAs, embeddings
  datasets/      Shared datasets, preferably read-only inside containers
  outputs/       Generated images, videos, logs, eval results
  cache/         Hugging Face, Torch, pip, uv, npm, model caches
  logs/          Host-level logs or exported container logs
  secrets/       Local-only secrets; do not commit
  manifests/     Host and experiment manifests for reproducibility
  images/        Optional exported Docker images or build artifacts
```

Do not clone application repositories into `/srv/ai/models`. Keep code in `/srv/ai/experiments/<project>` and model weights in `/srv/ai/models/<org-or-type>/<model>`.

---

## 9. Docker Compose GPU smoke test

Create a Compose-based GPU test:

```bash
set -euo pipefail

mkdir -p /srv/ai/experiments/gpu-smoke-test
cd /srv/ai/experiments/gpu-smoke-test

cat > compose.yaml <<'EOF_COMPOSE'
services:
  test:
    image: nvidia/cuda:13.3.0-base-ubuntu26.04
    command: nvidia-smi
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
EOF_COMPOSE

docker compose up --remove-orphans
docker compose down
```

Success criteria:

- Compose pulls the CUDA image.
- The container runs `nvidia-smi`.
- The RTX 5080 appears in the output.

---

## 10. Standard experiment template: PyTorch GPU container

This template verifies that Python, PyTorch, CUDA, and the RTX 5080 work together inside a container.

```bash
set -euo pipefail

mkdir -p /srv/ai/experiments/template-pytorch
cd /srv/ai/experiments/template-pytorch

cat > .env <<'EOF_ENV'
AI_ROOT=/srv/ai
PROJECT_SLUG=template-pytorch
WEB_PORT=7860
EOF_ENV
chmod 600 .env

cat > .dockerignore <<'EOF_DOCKERIGNORE'
.git
.env
__pycache__
*.pyc
models
datasets
outputs
.cache
EOF_DOCKERIGNORE

cat > Dockerfile <<'EOF_DOCKERFILE'
FROM python:3.12-slim-bookworm

ARG DEBIAN_FRONTEND=noninteractive
ENV PYTHONUNBUFFERED=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/cache/huggingface \
    TORCH_HOME=/cache/torch

RUN apt-get update && apt-get install -y --no-install-recommends \
    ca-certificates curl git git-lfs ffmpeg libgl1 libglib2.0-0 \
    build-essential \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

RUN python -m pip install --upgrade pip setuptools wheel \
 && pip install torch==2.11.0 torchvision==0.26.0 torchaudio==2.11.0 --index-url https://download.pytorch.org/whl/cu128

COPY app.py /workspace/app.py
CMD ["python", "/workspace/app.py"]
EOF_DOCKERFILE

cat > app.py <<'EOF_APP'
import torch

print("torch:", torch.__version__)
print("torch cuda build:", torch.version.cuda)
print("cuda available:", torch.cuda.is_available())
if torch.cuda.is_available():
    print("gpu:", torch.cuda.get_device_name(0))
    x = torch.randn((4096, 4096), device="cuda")
    y = x @ x
    print("matmul checksum:", float(y[0, 0]))
else:
    raise SystemExit("CUDA is not available inside the container")
EOF_APP

cat > compose.yaml <<'EOF_COMPOSE'
name: ${PROJECT_SLUG:-template-pytorch}

services:
  app:
    build:
      context: .
      dockerfile: Dockerfile
    image: local/${PROJECT_SLUG:-template-pytorch}:0.1.0
    env_file:
      - .env
    environment:
      NVIDIA_VISIBLE_DEVICES: all
      NVIDIA_DRIVER_CAPABILITIES: compute,utility
      HF_HOME: /cache/huggingface
      TORCH_HOME: /cache/torch
      PYTHONUNBUFFERED: "1"
    volumes:
      - ${AI_ROOT:-/srv/ai}/models:/models
      - ${AI_ROOT:-/srv/ai}/datasets:/datasets:ro
      - ${AI_ROOT:-/srv/ai}/outputs/${PROJECT_SLUG:-template-pytorch}:/outputs
      - ${AI_ROOT:-/srv/ai}/cache/huggingface:/cache/huggingface
      - ${AI_ROOT:-/srv/ai}/cache/torch:/cache/torch
    ports:
      - "127.0.0.1:${WEB_PORT:-7860}:7860"
    ipc: host
    shm_size: "16gb"
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
    restart: "no"
EOF_COMPOSE

docker compose build
docker compose run --rm app
```

Expected output includes:

- A PyTorch version string
- CUDA available: `True`
- The RTX 5080 device name
- A successful matrix multiply checksum

---

## 11. Standard lifecycle commands for any experiment

From inside `/srv/ai/experiments/<project>`:

```bash
# Build or rebuild images.
docker compose build

# Start in foreground for debugging.
docker compose up --build

# Start detached.
docker compose up -d --build

# View logs.
docker compose logs -f

# Stop and remove containers, but keep images, caches, models, and outputs.
docker compose down

# Pull newer upstream images if compose.yaml uses external images.
docker compose pull

# Force a clean image rebuild for this project only.
docker compose build --no-cache
```

Dangerous cleanup commands:

```bash
# Removes stopped containers, unused networks, dangling images, and build cache.
# Do not run without human approval.
docker system prune

# More destructive. Can delete unused images and volumes.
# Do not run without human approval.
docker system prune -a --volumes
```

---

## 12. Template for each new AI model experiment

For every new model or model family, create a project directory:

```bash
mkdir -p /srv/ai/experiments/my-new-model
cd /srv/ai/experiments/my-new-model
```

Each project should have this structure:

```text
my-new-model/
  README.md
  compose.yaml
  Dockerfile
  .env
  .dockerignore
  requirements.txt or pyproject.toml
  app/ or src/
```

Minimum `README.md` contents for each project:

```markdown
# Project name

Purpose: one sentence describing the experiment.

## Source

- Upstream repo:
- Upstream commit or release:
- Base image:
- Model weights location:

## Launch

docker compose up --build

## Stop

docker compose down

## Ports

- Local web UI: http://127.0.0.1:7860

## Persistent data

- Models: /srv/ai/models
- Datasets: /srv/ai/datasets
- Outputs: /srv/ai/outputs/<project>
- Caches: /srv/ai/cache

## Reproducibility notes

- Python version:
- CUDA/PyTorch/TensorFlow/JAX version:
- Model version/checkpoint:
- Special flags:
```

Important project rules:

1. Pin the base image tag. Avoid `latest` for long-lived experiments.
2. Pin Python dependencies where practical.
3. Put model weights under `/srv/ai/models`, not inside the Docker image.
4. Put generated outputs under `/srv/ai/outputs/<project>`.
5. Keep datasets read-only inside containers unless the experiment must write them.
6. Use `127.0.0.1:host_port:container_port` for web UIs by default.
7. Use one unique `PROJECT_SLUG` and one unique web port per concurrently running experiment.

---

## 13. Notes for RTX 5080, CUDA, and AI frameworks

The RTX 5080 has CUDA compute capability 12.0. Use framework builds that support Blackwell / `sm_120`.

Practical guidance:

1. Prefer current NVIDIA CUDA images, NVIDIA NGC framework images, or official PyTorch/JAX/TensorFlow images that explicitly support the needed CUDA version.
2. For PyTorch, use recent CUDA 12.8 or CUDA 13.x builds. The template above uses PyTorch 2.11.0 with the official CUDA 12.8 wheel index.
3. Avoid older CUDA 11.x, CUDA 12.1, or CPU-only framework wheels unless a specific project requires them and you have verified RTX 5080 support.
4. If you see an error like `no kernel image is available for execution on the device` or a warning that the GPU architecture is unsupported, upgrade the framework container or rebuild from source with Blackwell architecture support.
5. If a model repository hardcodes an older PyTorch or CUDA version, treat it as a porting task. Do not downgrade the host driver just to satisfy one model stack.

---

## 14. Example Compose fragments for common AI workloads

### Local web UI with GPU

```yaml
services:
  webui:
    build: .
    ports:
      - "127.0.0.1:7860:7860"
    volumes:
      - /srv/ai/models:/models
      - /srv/ai/outputs/my-webui:/outputs
      - /srv/ai/cache/huggingface:/cache/huggingface
    environment:
      HF_HOME: /cache/huggingface
      NVIDIA_VISIBLE_DEVICES: all
      NVIDIA_DRIVER_CAPABILITIES: compute,utility
    ipc: host
    shm_size: "16gb"
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: 1
              capabilities: [gpu]
```

### Read-only dataset mount

```yaml
volumes:
  - /srv/ai/datasets/my-dataset:/datasets/my-dataset:ro
```

### Restrict to one GPU by device ID

For a future multi-GPU host, replace `count: 1` with `device_ids`. Do not set both `count` and `device_ids` in the same reservation.

```yaml
deploy:
  resources:
    reservations:
      devices:
        - driver: nvidia
          device_ids: ["0"]
          capabilities: [gpu]
```

---

## 15. Security and network defaults

### Web UIs

Most AI web UIs are not safe to expose directly to a LAN or the public internet. Bind to localhost:

```yaml
ports:
  - "127.0.0.1:7860:7860"
```

Access remotely with SSH tunneling:

```bash
ssh -L 7860:127.0.0.1:7860 user@workstation-hostname
```

Then open `http://127.0.0.1:7860` on the client machine.

### Secrets

Use one of these approaches:

- Local `.env` files with permissions `0600`
- Docker Compose `env_file`
- Files in `/srv/ai/secrets` mounted read-only
- A proper secret manager for production-like workflows

Never put tokens in:

- Dockerfiles
- Git commits
- Image labels
- Shell scripts that will be committed
- Container command-line arguments visible in process lists

### Docker group warning

Only trusted users should be in the `docker` group. Docker group access is effectively root-level host access.

---

## 16. Reproducibility manifest

After setup, capture the host state:

```bash
set -euo pipefail

mkdir -p /srv/ai/manifests
manifest="/srv/ai/manifests/host-baseline-$(date +%F-%H%M%S).txt"

{
  echo "# Date"
  date --iso-8601=seconds
  echo

  echo "# OS"
  lsb_release -a || true
  uname -a
  echo

  echo "# GPU"
  nvidia-smi || true
  echo

  echo "# Docker"
  docker version || true
  docker compose version || true
  docker info | grep -Ei 'Server Version|Storage Driver|Logging Driver|Cgroup Driver|Runtimes|Default Runtime|Docker Root Dir' || true
  echo

  echo "# Relevant packages"
  dpkg-query -W \
    'docker-ce' \
    'docker-ce-cli' \
    'containerd.io' \
    'docker-buildx-plugin' \
    'docker-compose-plugin' \
    'nvidia-container-toolkit' \
    'nvidia-driver*' 2>/dev/null | sort || true
} | tee "$manifest"

echo "Wrote $manifest"
```

For each experiment, also record:

```bash
cd /srv/ai/experiments/<project>

docker compose config > resolved-compose.yaml
docker image ls --digests > docker-images.txt
git rev-parse HEAD > git-commit.txt 2>/dev/null || true
```

---

## 17. Backup and migration pattern

Back up the persistent data and experiment definitions, not just Docker images.

Recommended backup targets:

- `/srv/ai/experiments`
- `/srv/ai/models`
- `/srv/ai/datasets` if the datasets are not easily reproducible
- `/srv/ai/outputs`
- `/srv/ai/manifests`
- Any local secrets, handled separately and securely

Example backup command:

```bash
sudo rsync -aH --info=progress2 /srv/ai/ /backup/ai/
```

For migration to a new Ubuntu host:

1. Install Ubuntu.
2. Run this host setup runbook.
3. Restore `/srv/ai`.
4. Enter each experiment folder and run `docker compose build` or `docker compose pull`.
5. Run the experiment's smoke test.

---

## 18. Troubleshooting

### `nvidia-smi` fails on the host

Likely causes:

- NVIDIA driver did not install correctly.
- Secure Boot blocked the kernel module.
- Nouveau is still active.
- Kernel headers were missing during driver installation.
- The installed driver branch is too old for RTX 5080.

Useful commands:

```bash
mokutil --sb-state || true
lsmod | grep -Ei 'nvidia|nouveau' || true
dmesg | grep -Ei 'nvidia|nouveau|secure|mok' | tail -200 || true
ubuntu-drivers devices
apt-cache policy 'nvidia-driver-*' | sed -n '1,120p'
```

### `docker run --gpus all ... nvidia-smi` fails but host `nvidia-smi` works

Likely causes:

- NVIDIA Container Toolkit is not installed.
- Docker runtime was not configured with `nvidia-ctk`.
- Docker was not restarted after toolkit configuration.
- A systemd/cgroup daemon reload affected running GPU containers.

Useful commands:

```bash
nvidia-ctk --version || true
docker info | grep -Ei 'Runtimes|Default Runtime' || true
cat /etc/docker/daemon.json | jq . || cat /etc/docker/daemon.json
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
docker run --rm --gpus all nvidia/cuda:13.3.0-base-ubuntu26.04 nvidia-smi
```

### PyTorch says CUDA is not available

Likely causes:

- Installed a CPU-only PyTorch wheel.
- Installed an older CUDA wheel that does not support Blackwell.
- Compose file does not request a GPU.
- The container does not include compatible NVIDIA/CUDA user-space libraries.

Useful commands inside the project:

```bash
docker compose run --rm app python - <<'PY'
import torch
print(torch.__version__)
print(torch.version.cuda)
print(torch.cuda.is_available())
print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'no cuda')
PY
```

### Web UI is not reachable from another computer

By design, this runbook binds web UIs to localhost only. Use an SSH tunnel:

```bash
ssh -L 7860:127.0.0.1:7860 user@workstation-hostname
```

Or deliberately configure a reverse proxy with TLS and authentication.

### Disk fills up

Inspect usage:

```bash
df -h
sudo du -h -d 1 /srv/ai | sort -h
docker system df
```

Safe-ish cleanup with review:

```bash
docker builder prune
```

Do not run volume-pruning commands unless the human confirms that unused Docker volumes contain no needed data.

---

## 19. Rebuild-from-scratch checklist

Use this when rebuilding this machine or setting up a future Ubuntu machine.

1. Install Ubuntu 26.04.
2. Update OS and install preflight packages.
3. Install NVIDIA open driver appropriate for RTX 5080.
4. Reboot.
5. Verify host `nvidia-smi`.
6. Install Docker Engine from Docker's apt repository.
7. Optionally add the trusted user to the `docker` group.
8. Configure Docker log rotation.
9. Install NVIDIA Container Toolkit.
10. Configure Docker runtime with `nvidia-ctk`.
11. Restart Docker.
12. Verify `docker run --gpus all ... nvidia-smi`.
13. Create `/srv/ai` layout.
14. Run Compose GPU smoke test.
15. Run PyTorch template test.
16. Capture host manifest.
17. Restore or create experiment folders under `/srv/ai/experiments`.

---

## 20. Final standard for future experiments

A new AI experiment is considered repeatable when it has:

1. A project folder under `/srv/ai/experiments/<project>`.
2. A `compose.yaml` that requests the GPU explicitly.
3. Pinned base images or pinned package versions.
4. Model weights outside the image under `/srv/ai/models`.
5. Outputs outside the image under `/srv/ai/outputs/<project>`.
6. Caches outside the image under `/srv/ai/cache`.
7. A `README.md` with launch, stop, ports, upstream source, and model version.
8. A smoke test command that proves GPU access.
9. No secrets in Git or Docker image layers.
10. A manifest capturing image tags, package versions, and Git commits.

If these conditions are met, the stack can be stopped, replaced by another model stack, rebuilt, moved to another Ubuntu host, or re-created after a clean OS install with minimal ambiguity.
