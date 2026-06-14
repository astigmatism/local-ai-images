# 02 - NVIDIA driver and GPU setup

## Goal

Install a supported NVIDIA driver on Ubuntu 24 Server and verify that both installed GPUs are visible:

- NVIDIA RTX 3090
- NVIDIA RTX 4080

The two cards have different VRAM sizes and capabilities. Do not assume identical memory, power limits, or scheduling behavior.

## Install recommended driver packages

Ubuntu Server documents `ubuntu-drivers` as the recommended command-line driver tool. On a server or compute host, start with the GPGPU driver list.

```bash
sudo apt update
sudo apt install -y ubuntu-drivers-common linux-headers-$(uname -r)
sudo ubuntu-drivers list --gpgpu
```

Install the automatically recommended GPGPU driver:

```bash
sudo ubuntu-drivers install --gpgpu
sudo reboot
```

If you intentionally choose a specific server driver branch from the list, use the branch name shown by `ubuntu-drivers`. Example only:

```bash
sudo ubuntu-drivers install --gpgpu nvidia:550-server
sudo reboot
```

Install the matching `nvidia-utils` package if the selected path does not install `nvidia-smi` automatically. For example, if you intentionally selected branch `550-server`:

```bash
sudo apt install -y nvidia-utils-550-server
```

Use the exact branch that matches the installed driver.

## Secure Boot note

If Secure Boot is enabled, Ubuntu may require module signing or may only load signed driver modules. The `ubuntu-drivers` path is the safest first attempt. If `nvidia-smi` fails after installation, check Secure Boot state:

```bash
mokutil --sb-state
```

## Verify both GPUs

```bash
nvidia-smi -L
```

Expected shape:

```text
GPU 0: NVIDIA GeForce RTX 3090 (UUID: GPU-...)
GPU 1: NVIDIA GeForce RTX 4080 (UUID: GPU-...)
```

The order may not match the physical slot order. Record the UUIDs because GPU numeric IDs can change after hardware or driver changes.

## Inspect driver version

```bash
cat /proc/driver/nvidia/version
nvidia-smi --query-gpu=index,uuid,name,driver_version --format=csv,noheader
```

## Inspect memory, utilization, temperature, and power

The monitor app uses a fixed, non-user-controlled `nvidia-smi` query similar to this:

```bash
nvidia-smi \
  --query-gpu=index,uuid,name,driver_version,memory.total,memory.used,memory.free,utilization.gpu,temperature.gpu,power.draw,power.limit \
  --format=csv,noheader,nounits
```

For interactive live monitoring:

```bash
watch -n 1 nvidia-smi
```

Or query only the fields relevant to this project:

```bash
watch -n 1 "nvidia-smi --query-gpu=index,name,memory.used,memory.total,utilization.gpu,temperature.gpu,power.draw,power.limit --format=csv,noheader,nounits"
```

## Enable persistence mode, optional

Persistence mode can reduce driver initialization overhead for repeated GPU queries and workloads:

```bash
sudo nvidia-smi -pm 1
```

This is optional. It may reset after driver changes or reboot depending on system configuration.

## Mixed RTX 3090 and RTX 4080 notes

- RTX 3090 cards commonly have 24 GiB VRAM; RTX 4080 cards commonly have 16 GiB VRAM.
- Large models may fit on the 3090 but not fully on the 4080.
- Multi-GPU layer splitting behavior depends on Ollama, model size, quantization, context length, and available VRAM.
- Numeric GPU indices are convenient for short tests, but UUIDs are more reliable for persistent `CUDA_VISIBLE_DEVICES` settings.
- Check power supply capacity, individual PCIe power cables, slot spacing, and cooling. Mixed high-power cards can throttle or disappear under load if power or thermals are marginal.

## Troubleshooting: only one GPU appears

Start at the PCI layer:

```bash
lspci | grep -Ei 'nvidia|vga|3d'
```

If both cards appear in `lspci` but only one appears in `nvidia-smi`:

```bash
dmesg -T | grep -Ei 'nvidia|nvrm|pcie|xid' | tail -n 100
journalctl -k -b | grep -Ei 'nvidia|nvrm|xid' | tail -n 100
```

Common causes:

- Driver module did not load.
- Secure Boot blocked the kernel module.
- The installed driver branch is too old for one card.
- BIOS settings or PCIe lane allocation disabled a slot.
- Power cabling is inadequate.
- A riser, slot, or card is faulty.

## Troubleshooting: `nvidia-smi` is missing

```bash
command -v nvidia-smi || echo 'nvidia-smi missing'
dpkg -l | grep -E 'nvidia-driver|nvidia-utils'
```

Install the `nvidia-utils` package matching your driver branch.

## Troubleshooting: driver unavailable

If `nvidia-smi` prints `Failed to initialize NVML` or driver/library mismatch messages:

```bash
sudo apt update
sudo apt full-upgrade -y
sudo reboot
```

Then verify:

```bash
nvidia-smi
lsmod | grep nvidia
```

If the problem remains, inspect packages:

```bash
dpkg -l | grep -E 'nvidia|cuda' | sort
```

Avoid mixing Ubuntu-packaged drivers with manual `.run` installer drivers unless you have a specific reason and rollback plan.
