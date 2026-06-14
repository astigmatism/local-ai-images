# Ubuntu RTX 3080 image-generation VM build guide

This guide describes the target host for the ComfyUI-backed image-generation API added to this project. The reference app remains a small Node service with static assets and systemd deployment; raw ComfyUI should stay bound to localhost, while this app exposes the stable machine-to-machine API and thin control panel.

## Recommended VM shape for RTX 3080 passthrough

For a single RTX 3080 10 GB card, start with:

- Ubuntu Server 24.04 LTS guest.
- 8 or more vCPU cores.
- 32 GB RAM minimum; 64 GB is more comfortable for large workflows and model loading.
- 150 GB or larger fast SSD/NVMe virtual disk, plus separate storage for model files if available.
- RTX 3080 passed through as a full PCIe device, including HDMI audio and any USB-C/auxiliary functions in the same IOMMU group.
- UEFI/OVMF firmware and a modern Q35 or equivalent machine type.
- Virtio network and disk devices.

The RTX 3080 has limited VRAM compared with newer 16 GB/24 GB cards. Prefer SDXL at 1024x1024 with conservative batch size, or SD 1.5/SDXL Turbo/lightning workflows when throughput matters. Out-of-VRAM errors are expected if operators raise resolution, batch size, or ControlNet/LoRA counts too aggressively.

## GPU passthrough prerequisites on the hypervisor

Validate these items before installing the app:

1. Enable IOMMU in firmware and the hypervisor kernel: Intel VT-d or AMD-Vi.
2. Use OVMF/UEFI for the guest. Legacy BIOS guests are a common source of NVIDIA driver initialization issues.
3. Pass through all functions of the GPU, not only the VGA function. Typical RTX cards expose at least VGA/3D and audio functions.
4. Confirm the GPU functions are isolated in a safe IOMMU group. On Linux hypervisors:

```bash
for group in /sys/kernel/iommu_groups/*; do
  echo "IOMMU group ${group##*/}"
  for device in "$group"/devices/*; do
    lspci -nnks "${device##*/}"
  done
done
```

5. Bind the GPU to `vfio-pci` on the host before the host NVIDIA driver claims it.
6. Avoid sharing a GPU that is used by the hypervisor display server.
7. Assign enough hugepages or pinned memory if your hypervisor requires it for reliable passthrough.

## Ubuntu guest installation

Install Ubuntu Server, select OpenSSH during setup, and create an administrative user. After first boot:

```bash
sudo apt update
sudo apt full-upgrade -y
sudo reboot
```

Install baseline tools:

```bash
sudo apt install -y git curl ca-certificates build-essential python3-venv python3-pip unzip jq
```

## SSH setup

From your workstation:

```bash
ssh-copy-id your-user@IMAGE_VM_IP
ssh your-user@IMAGE_VM_IP
```

Harden SSH for a LAN appliance after key login works:

```bash
sudoedit /etc/ssh/sshd_config
sudo systemctl reload ssh
```

Recommended settings include `PasswordAuthentication no`, `PermitRootLogin no`, and firewall rules that allow SSH only from trusted admin networks.

## NVIDIA driver installation and validation

Inside the Ubuntu guest:

```bash
sudo apt update
ubuntu-drivers devices
sudo ubuntu-drivers autoinstall
sudo reboot
```

Validate the GPU is visible:

```bash
nvidia-smi
```

A healthy RTX 3080 passthrough guest should show the card name, driver version, CUDA version, temperature, power, memory, and utilization. If `nvidia-smi` is missing, returns `No devices were found`, or reports driver/library mismatches, fix that before deploying ComfyUI or this app.

## ComfyUI backend installation

The default deployment pattern keeps ComfyUI as a host service bound to `127.0.0.1:8188`.

```bash
sudo useradd --system --create-home --home-dir /opt/local-ai-llm --shell /usr/sbin/nologin local-ai-llm
sudo mkdir -p /opt/ComfyUI /srv/comfyui/models /var/lib/comfyui
sudo chown -R local-ai-llm:local-ai-llm /opt/ComfyUI /srv/comfyui /var/lib/comfyui
sudo -u local-ai-llm git clone https://github.com/comfyanonymous/ComfyUI.git /opt/ComfyUI
cd /opt/ComfyUI
sudo -u local-ai-llm python3 -m venv venv
sudo -u local-ai-llm ./venv/bin/pip install --upgrade pip
sudo -u local-ai-llm ./venv/bin/pip install -r requirements.txt
```

Install the PyTorch build appropriate for your driver/CUDA stack. Use the command recommended by the PyTorch install selector for Linux, pip, Python, and CUDA. Then validate from the ComfyUI virtual environment:

```bash
sudo -u local-ai-llm /opt/ComfyUI/venv/bin/python - <<'PY'
import torch
print(torch.__version__)
print(torch.cuda.is_available())
print(torch.cuda.get_device_name(0) if torch.cuda.is_available() else 'no cuda')
PY
```

Install the supplied systemd example:

```bash
sudo cp deploy/comfyui.service.example /etc/systemd/system/comfyui.service
sudo systemctl daemon-reload
sudo systemctl enable --now comfyui.service
curl http://127.0.0.1:8188/system_stats | jq .
```

## Model directory setup

Do not store model files in git. Use operator-managed directories such as:

```bash
sudo mkdir -p /srv/comfyui/models/checkpoints /srv/comfyui/models/loras /srv/comfyui/models/vae /srv/comfyui/models/controlnet
sudo chown -R local-ai-llm:local-ai-llm /srv/comfyui/models
```

ComfyUI expects models under its own `models` tree. Either place files directly there or use symlinks:

```bash
sudo -u local-ai-llm ln -sfn /srv/comfyui/models/checkpoints /opt/ComfyUI/models/checkpoints
sudo -u local-ai-llm ln -sfn /srv/comfyui/models/loras /opt/ComfyUI/models/loras
sudo -u local-ai-llm ln -sfn /srv/comfyui/models/vae /opt/ComfyUI/models/vae
sudo -u local-ai-llm ln -sfn /srv/comfyui/models/controlnet /opt/ComfyUI/models/controlnet
```

Point this app at the same root with `IMAGE_MODEL_PATHS=/srv/comfyui/models`.

## First UI test

After the app service is deployed, open:

```text
http://IMAGE_VM_IP:8000/
```

The dashboard should show service state, ComfyUI/mock engine state, queue state, GPU telemetry, model inventory, workflow presets, and recent jobs. If `IMAGE_API_KEYS` is set, the browser dashboard can still load static assets, but direct `/api/v1` calls require an API key. The legacy LLM monitor cards remain visible for compatibility with the original app.

## First API test

```bash
export IMAGE_API_KEY='replace-with-a-long-random-secret'
export IMAGE_API_URL='http://IMAGE_VM_IP:8000'

curl -sS -H "Authorization: Bearer $IMAGE_API_KEY" \
  "$IMAGE_API_URL/api/v1/health" | jq .

curl -sS -H "Authorization: Bearer $IMAGE_API_KEY" \
  "$IMAGE_API_URL/api/v1/models" | jq '.models[] | {type,name,relativePath,sizeBytes}'
```

Submit a synchronous smoke request in mock mode or with a real model name that exists in ComfyUI:

```bash
curl -sS -H "Authorization: Bearer $IMAGE_API_KEY" \
  -H 'content-type: application/json' \
  -d '{"prompt":"a small robot painting a mountain","model":"sd_xl_base_1.0.safetensors","sync_timeout_ms":60000,"output":"url"}' \
  "$IMAGE_API_URL/api/v1/generate" | jq .
```

## Artifact retrieval

The generated result contains artifact IDs and URLs. Retrieve bytes:

```bash
curl -L -H "Authorization: Bearer $IMAGE_API_KEY" \
  "$IMAGE_API_URL/api/v1/artifacts/ARTIFACT_ID" \
  --output output.png
```

Retrieve sidecar metadata JSON:

```bash
curl -sS -H "Authorization: Bearer $IMAGE_API_KEY" \
  "$IMAGE_API_URL/api/v1/artifacts/ARTIFACT_ID?metadata=1" | jq .
```

## Operational safeguards and local-control policy

The app does not hardcode vendor prompt filters, remote moderation calls, or model allowlists. Operators control which local models and workflows are installed. Production operators should still use API authentication, LAN firewalling, audit-friendly request metadata, filesystem permissions, backups for metadata, and clear internal rules for legal and acceptable use.
