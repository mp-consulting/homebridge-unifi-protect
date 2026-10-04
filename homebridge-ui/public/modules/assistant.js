/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * assistant.js: Assistant (Homebridge AI Kit) integration for the webUI.
 *
 * Nothing renders unless the shared HomebridgeAiKit block is set up and enabled. What reaches the Assistant is limited on purpose: controller credentials,
 * addresses, camera (ONVIF) credentials, MAC addresses and IP addresses never leave the browser. Devices and controllers go through explicit whitelists
 * and error text is scrubbed.
 */

export const assistant = { available: false, enabled: false };

// IPv4 addresses and MAC addresses (colon or dash separated) inside free text.
const IPV4_IN_TEXT = /\b(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\b/g;
const MAC_IN_TEXT = /\b[0-9A-Fa-f]{2}(?:[:-][0-9A-Fa-f]{2}){5}\b/g;

// Replace the given addresses (the controller or camera address, which may be a hostname), IP addresses and MAC addresses in an error message before it
// goes to the Assistant.
export const scrubText = (text, addresses = []) => {

  let result = String(text ?? '');

  for(const address of addresses) {

    if((typeof address === 'string') && address.trim()) {

      result = result.split(address.trim()).join('[address]');
    }
  }

  return result.replace(MAC_IN_TEXT, '[MAC address]').replace(IPV4_IN_TEXT, '[IP address]');
};

// The device facts the Assistant may see. A whitelist: never the host/IP, MAC, ID or any third-party camera credentials.
export const assistantDevice = (device) => ({

  adopted: device?.isAdopted,
  connectionType: device?.connectionType,
  firmware: device?.firmwareVersion,
  marketName: device?.marketName,
  modelKey: device?.modelKey,
  name: device?.name,
  rebooting: device?.isRebooting,
  state: device?.state,
  thirdPartyCamera: device?.isThirdPartyCamera,
  type: device?.type,
  updating: device?.isUpdating,
});

// The controller settings the Assistant may see. A whitelist: never the address, username or password.
export const assistantController = (controller) => ({

  name: controller?.name,
  verifyTls: controller?.verifyTls === true,
});

// Why a device needs attention, or null when it looks fine. Devices without a connection state (the NVR, some sensors) are never flagged.
export const deviceProblem = (device) => {

  if(!device || (device.modelKey === 'nvr') || (typeof device.state !== 'string')) {

    return null;
  }

  if(device.isUpdating) {

    return 'UniFi Protect reports this ' + (device.modelKey || 'device') + ' as updating its firmware.';
  }

  if(device.state !== 'CONNECTED') {

    return 'UniFi Protect reports this ' + (device.modelKey || 'device') + ' as ' + device.state.toLowerCase() + ' (not connected).';
  }

  return null;
};

// Check whether the Assistant is set up. Never throws: without the AI Kit routes there is simply no Assistant.
export const initAssistant = async () => {

  try {

    if(globalThis.MpKit?.ai) {

      const status = await globalThis.MpKit.ai.status();

      assistant.available = true;
      assistant.enabled = !!status?.enabled;
    }
  } catch {

    // Routes missing or older Homebridge UI: no Assistant.
  }

  return assistant;
};

// Stream an explanation of `error` into `answerEl`.
export const explainWithAssistant = async (button, answerEl, { context, device, error, title }) => {

  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  answerEl.style.display = '';

  const answer = globalThis.MpKit.ai.renderAnswer(answerEl, { title });

  try {

    const res = await globalThis.MpKit.ai.explain({ context, device, error }, { onChunk: answer.append });

    answer.done(res);
  } catch(e) {

    answer.error(e);
  } finally {

    button.disabled = false;
    button.removeAttribute('aria-busy');
  }
};

// Hide and empty an Explain slot.
export const clearExplain = (container) => {

  container.replaceChildren();
  container.style.display = 'none';
};

// Render an "Explain" button and an answer panel into `container`. Renders nothing when the Assistant is off. `error` must already be scrubbed.
export const renderExplain = (container, { context, device, error, title }) => {

  container.replaceChildren();

  if(!assistant.enabled) {

    container.style.display = 'none';

    return;
  }

  container.style.display = '';
  // The markup comes from the vendored ui-kit and carries no user data.
  container.innerHTML = globalThis.MpKit.ai.renderButton({ className: 'js-explain', label: 'Explain', size: 'sm' }) +
    '<div class="assistant-answer mt-2" style="display: none;"></div>';

  const button = container.querySelector('.js-explain');
  const answerEl = container.querySelector('.assistant-answer');

  button.addEventListener('click', () => explainWithAssistant(button, answerEl, { context, device, error, title }));
};
