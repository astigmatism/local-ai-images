# 01 - Ubuntu 24 Server baseline

## Baseline assumptions

- The machine is a fresh Ubuntu 24 Server installation.
- SSH access already works.
- The host is headless or managed primarily over SSH.
- The target GPU is an NVIDIA RTX 3080 passed through to the Ubuntu VM or installed directly in the host.
- The target deployment is LAN/local-lab use, not public internet exposure.
- You have a sudo-capable administrative account.

## Update packages

```bash
sudo apt update
sudo apt full-upgrade -y
sudo reboot
```

After reconnecting over SSH:

```bash
lsb_release -a
uname -a
```

## Install baseline tools

```bash
sudo apt install -y \
  ca-certificates \
  curl \
  git \
  gnupg \
  jq \
  lsb-release \
  nano \
  openssh-server \
  pciutils \
  python3-venv \
  software-properties-common \
  unzip \
  zip
```

## Confirm SSH service

```bash
systemctl status ssh --no-pager
ss -tulpn | grep ':22'
```

## Hostname and static IP recommendation

Set a stable hostname so logs and orchestrator configuration are predictable:

```bash
sudo hostnamectl set-hostname local-ai-images
```

Use your router/DHCP server to reserve an IP address for the VM when possible. That is usually safer than hand-editing netplan on a remote-only server. If you must configure a static IP on the guest, inspect the active netplan file first:

```bash
ls -l /etc/netplan
ip addr
ip route
```

Then edit the relevant `/etc/netplan/*.yaml` carefully and apply:

```bash
sudo netplan try
sudo netplan apply
```

## Time synchronization

Large model downloads, TLS, package repositories, and logs all behave better with correct time.

```bash
timedatectl status
sudo timedatectl set-ntp true
```

## Firewall baseline

The normal image-generation deployment only needs these inbound ports:

- SSH: `22/tcp`
- Local AI Images portal/API: `8000/tcp`

Raw ComfyUI should remain bound to `127.0.0.1:8188` and should not be exposed to the LAN directly.

For LAN-only use, allow from your LAN CIDR instead of the whole internet. Example for `192.168.1.0/24`:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from 192.168.1.0/24 to any port 22 proto tcp
sudo ufw allow from 192.168.1.0/24 to any port 8000 proto tcp
sudo ufw enable
sudo ufw status verbose
```

Do not enable UFW remotely without confirming SSH is allowed.

## Confirm PCI devices before driver work

```bash
lspci | grep -Ei 'nvidia|vga|3d'
```

You should see the RTX 3080 at the PCI layer before installing drivers. If it does not appear here, solve hypervisor passthrough, BIOS, power, or IOMMU-group issues before proceeding.
