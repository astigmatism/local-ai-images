# 01 - Ubuntu 24 Server baseline

## Baseline assumptions

- The machine is a fresh Ubuntu 24 Server installation.
- SSH access already works.
- The host is headless.
- The host has two NVIDIA GPUs installed: RTX 3090 and RTX 4080.
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
sudo hostnamectl set-hostname local-ai-llm
```

Use your router/DHCP server to reserve an IP address for the host when possible. That is usually safer than hand-editing netplan on a remote-only server. If you must configure a static IP on the host, inspect the active netplan file first:

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

The final expected ports are:

- SSH: `22/tcp`
- Ollama: `11434/tcp`
- Monitor/portal: `8000/tcp`

For LAN-only use, allow from your LAN CIDR instead of the whole internet. Example for `192.168.1.0/24`:

```bash
sudo ufw default deny incoming
sudo ufw default allow outgoing
sudo ufw allow from 192.168.1.0/24 to any port 22 proto tcp
sudo ufw allow from 192.168.1.0/24 to any port 11434 proto tcp
sudo ufw allow from 192.168.1.0/24 to any port 8000 proto tcp
sudo ufw enable
sudo ufw status verbose
```

Do not enable UFW remotely without confirming SSH is allowed.

## Confirm PCI devices before driver work

```bash
lspci | grep -Ei 'nvidia|vga|3d'
```

You should see both NVIDIA cards at the PCI layer before installing drivers. If only one card appears here, solve hardware/BIOS/slot/power issues before proceeding.
