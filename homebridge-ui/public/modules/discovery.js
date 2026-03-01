import { $, escapeHtml } from './dom-helpers.js';
import { getControllers } from './state.js';
import { openAddController } from './controllers.js';

export const handleDiscover = async () => {


  const btn = $('discoverBtn');
  const btnText = $('discoverBtnText');
  const spinner = $('discoverSpinner');
  const container = $('deviceListContainer');
  const listDiv = $('deviceList');

  btn.disabled = true;
  btnText.textContent = ' Searching...';
  spinner.style.display = 'inline-block';
  container.innerHTML = '';
  listDiv.style.display = 'none';

  try {


    const devices = await homebridge.request('/discover');
    const configuredIps = getControllers().map(c => c.address);
    const available = devices.filter(d => !configuredIps.includes(d.ip));

    if(!available.length) {


      const msg = devices.length ?
        'All discovered devices are already configured.' :
        'No devices found. Make sure your UniFi console is on and connected.';


      container.innerHTML = `<div class="alert alert-${devices.length ? 'success' : 'warning'}">${msg}</div>`;
      listDiv.style.display = 'block';
    } else {


      container.innerHTML = '<h6>Found Devices:</h6><ul class="list-group mb-3" id="discoveredDevices"></ul>';
      const ul = $('discoveredDevices');

      available.forEach(d => ul.appendChild(createDiscoveredDeviceItem(d)));
      listDiv.style.display = 'block';
    }
  } catch(e) {


    container.innerHTML = `<div class="alert alert-danger">Discovery error: ${escapeHtml(e.message)}</div>`;
    listDiv.style.display = 'block';
  } finally {


    btn.disabled = false;
    btnText.innerHTML = '<i class="fas fa-search"></i> Discover Controllers';
    spinner.style.display = 'none';
  }
};

const createDiscoveredDeviceItem = (device) => {


  const li = document.createElement('li');

  li.className = 'list-group-item list-group-item-action';
  li.style.cursor = 'pointer';

  li.innerHTML = `
    <div class="d-flex w-100 justify-content-between align-items-center">
      <div>
        <h6 class="mb-1"><i class="fas fa-server mr-2"></i> ${escapeHtml(device.name)}</h6>
        <small class="text-muted"><i class="fas fa-network-wired mr-1"></i> ${escapeHtml(device.ip)}</small>
        ${device.model ? `<span class="badge bg-secondary ms-2">${escapeHtml(device.model)}</span>` : ''}
        ${device.mac ? `<small class="text-muted ms-2"><i class="fas fa-barcode mr-1"></i> ${escapeHtml(device.mac)}</small>` : ''}
      </div>
      <span class="badge bg-primary rounded-pill">Select</span>
    </div>
  `;


  li.addEventListener('click', () => {


    openAddController(device.ip);
  });

  return li;
};
