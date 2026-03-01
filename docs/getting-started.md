<SPAN ALIGN="CENTER" STYLE="text-align:center">
<DIV ALIGN="CENTER" STYLE="text-align:center">

[![homebridge-unifi-protect: Native HomeKit support for UniFi Protect](https://raw.githubusercontent.com/mp-consulting/homebridge-unifi-protect/main/docs/media/homebridge-unifi-protect.svg)](https://github.com/mp-consulting/homebridge-unifi-protect)

# Homebridge UniFi Protect

[![Downloads](https://img.shields.io/npm/dt/@mp-consulting/homebridge-unifi-protect?color=%230559C9&logo=icloud&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/@mp-consulting/homebridge-unifi-protect)
[![Version](https://img.shields.io/npm/v/@mp-consulting/homebridge-unifi-protect?color=%230559C9&label=Homebridge%20UniFi%20Protect&logo=ubiquiti&logoColor=%23FFFFFF&style=for-the-badge)](https://www.npmjs.com/package/@mp-consulting/homebridge-unifi-protect)
[![UniFi Protect@Homebridge Discord](https://img.shields.io/discord/432663330281226270?color=0559C9&label=Discord&logo=discord&logoColor=%23FFFFFF&style=for-the-badge)](https://discord.gg/QXqfHEW)
[![verified-by-homebridge](https://img.shields.io/badge/homebridge-verified-blueviolet?color=%23491F59&style=for-the-badge&logoColor=%23FFFFFF&logo=homebridge)](https://github.com/homebridge/homebridge/wiki/Verified-Plugins)

## Complete HomeKit support for the UniFi Protect ecosystem using [Homebridge](https://homebridge.io).
</DIV>
</SPAN>

# Getting Started

This tutorial walks you through installing and configuring `homebridge-unifi-protect` from scratch, ending with all your UniFi Protect devices available in HomeKit.

## Prerequisites

Before you begin, make sure you have the following:

### Hardware Requirements

You need a machine capable of handling the CPU and GPU demands of video streaming. The more cameras you have, the higher the requirements — especially if you plan to use HomeKit Secure Video.

- **Recommended**: any Apple Silicon-based macOS environment for the best performance.
- **Supported with hardware acceleration**: Intel Macs, Intel Quick Sync Video-enabled CPUs, Raspberry Pi 4.
- **Raspberry Pi 4 note**: a great piece of hardware, but it cannot keep up with more than a few cameras, particularly higher-end models in the Protect ecosystem.

### Software Requirements

- **[Homebridge](https://homebridge.io)** installed and running. If you are new to Homebridge, read the [Homebridge documentation](https://github.com/homebridge/homebridge/wiki) and follow the installation instructions first.
- **[Homebridge Config UI](https://github.com/homebridge/homebridge-config-ui-x)** installed (the web-based management interface for Homebridge).
- **UniFi Protect v6 or later**. Earlier versions are no longer supported.

### Create a Local User Account on Your UniFi Console

`homebridge-unifi-protect` requires a **local user account** on your UniFi console. Ubiquiti.com/UI.com cloud accounts are not supported.

1. Open the Protect controller web interface.
2. Go to the **OS Settings** tab (typically near the top left).
3. Click **Add Admin** (near the top right of the OS Settings page).
4. Click **Restrict to local access only**.
5. Enter a username and password for the new local user.
6. Optionally customize the role. HBUP requires the **Full Management** role for all capabilities to work, although it will function in a more limited form without administrative privileges.

## Step 1: Install the Plugin

1. Open the **Homebridge Config UI** in your browser.
2. Go to the **Plugins** tab.
3. Search for `homebridge-unifi-protect`.
4. Click **Install**.

## Step 2: Configure the Plugin

1. After installation, click the **Set Up** icon (located in the top right corner of the Homebridge UniFi Protect tile).
2. Enter the hostname or IP address of your Protect controller (e.g., `unvr.local` or `10.0.0.1`).
3. Enter the username and password of the local user account you created above.
4. Log in to the Protect controller.
5. For now, don't make any other configuration changes — the defaults work well for the vast majority of users.
6. Click **Save**, then click **Restart Homebridge**.

## Step 3: Enable Child Bridge Mode

Running the plugin as a child bridge is strongly recommended for performance and stability.

1. After Homebridge restarts, click the **Set Up Child Bridge** icon (top right corner of the Homebridge UniFi Protect tile).
2. Toggle the child bridge setting for UniFi Protect to **on**.
3. Click **Save**, then **Restart Homebridge**.

## Step 4: Connect to HomeKit

1. After Homebridge restarts, click the **Connect to HomeKit** icon (top right corner of the Homebridge UniFi Protect tile).
2. Open the **Home** app on your iPhone or iPad.
3. Scan the QR code displayed in the Homebridge UI.
4. The Home app may ask where to locate your cameras and whether to enable HomeKit Secure Video — answer according to your preferences.

## Step 5: Verify Your Setup

You should now see all your UniFi Protect devices in HomeKit. If you add or remove devices from your Protect controller in the future, the plugin will automatically detect those changes and update HomeKit in realtime — no restart needed.

## FFmpeg

HBUP includes everything required to get up and running on many of the [more popular platforms and operating systems](https://github.com/homebridge/ffmpeg-for-homebridge#supported-platforms). If you're running on an unsupported platform, you will need to install a working version of FFmpeg separately. Your FFmpeg build must support the *fdk-aac* codec for audio support. Setting up and configuring FFmpeg is beyond the scope of this documentation.

## Supported Firmware and Hardware

- Only official releases of UniFi Protect and UniFi OS firmwares are supported. No beta, early access, or release candidate versions are supported.
- Only official hardware releases for UniFi Protect are supported. Early access or beta hardware is unsupported.
- No support is provided for beta versions of Apple operating systems (iOS, iPadOS, macOS, tvOS, etc.).

## Next Steps

Now that your plugin is up and running, explore these resources to get the most out of your setup:

- **[Best Practices](https://github.com/mp-consulting/homebridge-unifi-protect/blob/main/docs/best-practices.md)**: recommendations for the best HomeKit experience with UniFi Protect.
- **[Feature Options](https://github.com/mp-consulting/homebridge-unifi-protect/blob/main/docs/feature-options.md)**: granular options to customize camera quality, show or hide devices, and more.
- **[HomeKit Secure Video](https://github.com/mp-consulting/homebridge-unifi-protect/blob/main/docs/homekit-secure-video.md)**: set up and optimize HKSV for your Protect cameras.
- **[Troubleshooting](https://github.com/mp-consulting/homebridge-unifi-protect/blob/main/docs/troubleshooting.md)**: running into issues? Start here.
