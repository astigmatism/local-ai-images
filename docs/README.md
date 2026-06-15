# Documentation index

Local AI Images is now an image-generation appliance by default. The main docs describe an Ubuntu RTX 3080 VM running ComfyUI behind the Local AI Images control panel and `/api/v1` machine-to-machine API.

## Primary image-generation docs

- [Ubuntu RTX 3080 image-generation VM build guide](image-generation-vm.md)
- [Image-generation API](api.md)
- [Deployment guide](deployment.md)
- [Testing guide](testing.md)
- [Ubuntu 24 Server baseline](01-ubuntu-24-server-baseline.md)
- [NVIDIA driver and GPU setup](02-nvidia-driver-and-gpu-setup.md)
- [Application installation](04-application-installation.md)
- [Image model and workflow management](05-model-management-and-default-models.md)
- [Security and networking](06-security-and-networking.md)
- [Operations and troubleshooting](07-operations-and-troubleshooting.md)

## Optional legacy appendix

- [Optional legacy Ollama compatibility](03-ollama-installation-and-configuration.md)

Legacy Ollama compatibility is disabled unless `LEGACY_OLLAMA_ENABLED=true`. It is not required for normal ComfyUI image-generation deployment.
