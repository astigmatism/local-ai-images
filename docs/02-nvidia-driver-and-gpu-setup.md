# 02 - NVIDIA driver and GPU setup

## Goal

Install a supported NVIDIA driver on Ubuntu and verify that the RTX 3080 passed through to the VM is visible to the guest.

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

Install the matching `nvidia-utils` package if the selected path does not install `nvidia-smi` automatically. Use the exact branch that matches the installed driver.

## Secure Boot note

If Secure Boot is enabled, Ubuntu may require module signing or may only load signed driver modules. The `ubuntu-drivers` path is the safest first attempt. If `nvidia-smi` fails after installation, check Secure Boot state:

```bash
mokutil --sb-state
```

## Verify the GPU

```bash
nvidia-smi -L
```

Expected shape:

```text
GPU 0: NVIDIA GeForce RTX 3080 (UUID: GPU-...)
```

Record the UUID because numeric IDs can change after hardware, driver, or passthrough changes.

## Inspect driver version

```bash
cat /proc/driver/nvidia/version
nvidia-smi --query-gpu=index,uuid,name,driver_version --format=csv,noheader
```

## Inspect memory, utilization, temperature, and power

Local AI Images uses a fixed, non-user-controlled `nvidia-smi` query similar to this:

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

## RTX 3080 image-generation notes

- RTX 3080 cards commonly have 10 GiB or 12 GiB VRAM; tune workflow size, batch size, and model selection accordingly.
- Start with `IMAGE_QUEUE_CONCURRENCY=1` to avoid out-of-VRAM failures.
- Prefer SDXL/SD 1.5 checkpoints and workflows known to fit your exact VRAM size before adding ControlNet, high-resolution upscales, or large refiners.
- Check power supply capacity, passthrough reset behavior, and cooling. Xid errors under load often point to driver, passthrough, power, or thermal issues.

## Troubleshooting: GPU does not appear

Start at the PCI layer:

```bash
lspci | grep -Ei 'nvidia|vga|3d'
```

If the card appears in `lspci` but not in `nvidia-smi`:

```bash
dmesg -T | grep -Ei 'nvidia|nvrm|pcie|xid' | tail -n 100
journalctl -k -b | grep -Ei 'nvidia|nvrm|xid' | tail -n 100
```

Common causes:

- Driver module did not load.
- Secure Boot blocked the kernel module.
- The installed driver branch is too old.
- The hypervisor did not pass through every GPU function.
- The GPU is in a problematic IOMMU group.
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
