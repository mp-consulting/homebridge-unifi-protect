import { $, el, escapeHtml, setButtonLoading, showScreen } from './dom-helpers.js';
import { getControllers, saveConfig, state } from './state.js';
import { openFeatureOptions } from './feature-options.js';

export const renderControllers = () => {


  const controllers = getControllers();
  const list = $('controllersList');
  const noMsg = $('noControllersMessage');

  if(!controllers.length) {


    noMsg.style.display = 'block';
    list.style.display = 'none';

    return;
  }

  noMsg.style.display = 'none';
  list.style.display = 'block';
  list.innerHTML = '';

  controllers.forEach((ctrl, index) => {


    const li = document.createElement('li');

    li.className = 'list-group-item';

    li.innerHTML = `
      <div class="d-flex w-100 justify-content-between align-items-center">
        <div>
          <h6 class="mb-1">
            <i class="fas fa-server mr-2"></i> ${escapeHtml(ctrl.name || ctrl.address)}
            <span class="status-badge badge rounded-pill bg-secondary ms-2" style="font-size: 0.65rem;"><i class="fas fa-circle-notch fa-spin"></i></span>
          </h6>
          <small class="text-muted"><i class="fas fa-network-wired mr-1"></i> ${escapeHtml(ctrl.address)}</small>
        </div>
        <div class="d-flex gap-1">
          <button class="btn btn-sm btn-primary feature-options-btn"><i class="fas fa-sliders-h"></i> Options</button>
          <button class="btn btn-sm btn-secondary edit-ctrl-btn"><i class="fas fa-edit"></i> Edit</button>
          <button class="btn btn-sm btn-danger delete-ctrl-btn"><i class="fas fa-trash"></i></button>
        </div>
      </div>
    `;


    li.querySelector('.feature-options-btn').addEventListener('click', () => openFeatureOptions(index));
    li.querySelector('.edit-ctrl-btn').addEventListener('click', () => openEditController(index));
    li.querySelector('.delete-ctrl-btn').addEventListener('click', async function() {


      setButtonLoading(this, true, '...');
      controllers.splice(index, 1);
      await saveConfig();
      homebridge.toast.success('Controller removed');
      renderControllers();
    });

    list.appendChild(li);

    // Check controller status asynchronously.
    const badge = li.querySelector('.status-badge');

    const updateBadge = (colorClass, icon, label) => {


      badge.className = 'status-badge badge rounded-pill bg-' + colorClass + ' ms-2';
      badge.style.fontSize = '0.65rem';
      badge.textContent = '';
      badge.appendChild(el('i', { className: 'fas fa-' + icon }));
      badge.appendChild(document.createTextNode(' ' + label));
    };

    homebridge.request('/checkStatus', { address: ctrl.address }).then((result) => {

      updateBadge(result?.online ? 'success' : 'danger', result?.online ? 'check-circle' : 'times-circle', result?.online ? 'Online' : 'Offline');
    }).catch(() => {

      updateBadge('warning', 'question-circle', 'Unknown');
    });
  });
};

export const openAddController = (prefillAddress) => {


  state.editingIndex = null;
  $('setupTitle').textContent = 'Add UniFi Protect Controller';
  $('setupSubtitle').textContent = 'Enter your UniFi Protect controller details and login credentials.';
  $('inputAddress').value = prefillAddress || '';
  $('inputUsername').value = '';
  $('inputPassword').value = '';
  $('setupError').style.display = 'none';
  $('cancelSetupBtn').style.display = getControllers().length ? 'inline-block' : 'none';
  showScreen('setupScreen');

  if(prefillAddress) {


    $('inputUsername').focus();
  }
};

export const openEditController = (index) => {


  state.editingIndex = index;
  const ctrl = getControllers()[index];

  $('setupTitle').textContent = 'Edit Controller';
  $('setupSubtitle').textContent = 'Editing ' + (ctrl.name || ctrl.address);
  $('inputAddress').value = ctrl.address || '';
  $('inputUsername').value = ctrl.username || '';
  $('inputPassword').value = ctrl.password || '';
  $('setupError').style.display = 'none';
  $('cancelSetupBtn').style.display = 'inline-block';
  showScreen('setupScreen');
};

export const handleSetupSubmit = async (event) => {


  event.preventDefault();
  event.stopPropagation();

  const address = $('inputAddress').value.trim();
  const username = $('inputUsername').value.trim();
  const password = $('inputPassword').value.trim();

  if(!address || !username || !password) {


    $('setupErrorText').textContent = 'Please fill in all fields.';
    $('setupError').style.display = 'block';

    return;
  }

  const btn = $('saveControllerBtn');

  setButtonLoading(btn, true, 'Validating...');
  $('setupError').style.display = 'none';

  try {


    const devices = await homebridge.request('/getDevices', { address, password, username });

    if(!devices?.length) {


      const errorDetail = await homebridge.request('/getErrorMessage');

      $('setupErrorText').textContent = 'Unable to connect. ' + (errorDetail || 'Check your address and credentials.');
      $('setupError').style.display = 'block';
      setButtonLoading(btn, false);

      return;
    }

    state.pluginConfig[0].controllers ||= [];

    const controllerData = { address, password, username };

    // The first device in the response is the NVR — use its name.
    if(devices[0]?.name) {

      controllerData.name = devices[0].name;
    }

    if(state.editingIndex !== null) {


      const existing = state.pluginConfig[0].controllers[state.editingIndex];

      state.pluginConfig[0].controllers[state.editingIndex] = { ...existing, ...controllerData };
    } else {


      state.pluginConfig[0].controllers.push(controllerData);
    }

    await saveConfig();
    homebridge.toast.success(state.editingIndex !== null ? 'Controller updated' : 'Controller added successfully!');
    showScreen('controllersScreen');
    renderControllers();
  } catch(e) {


    $('setupErrorText').textContent = 'Error: ' + e.message;
    $('setupError').style.display = 'block';
  } finally {


    setButtonLoading(btn, false);
  }
};
