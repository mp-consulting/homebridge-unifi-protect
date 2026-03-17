/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * scope.js: Scope resolution, cascade diagram, and selector builder.
 */
import { $ } from '../dom-helpers.js';
import { state } from '../state.js';

export const SCOPE_ORDER = [ 'global', 'controller', 'device' ];

// Map of modelKey plural labels for sidebar grouping.
const MODEL_KEY_LABELS = {

  cameras: 'Cameras',
  chimes: 'Chimes',
  lights: 'Lights',
  sensors: 'Sensors',
  viewers: 'Viewers',
};

export const buildScopeSelector = (ctrl) => {


  const select = $('scopeSelect');

  select.innerHTML = '';

  const addOpt = (value, text) => {


    const opt = document.createElement('option');

    opt.value = value;
    opt.textContent = text;
    select.appendChild(opt);
  };

  addOpt('global', 'Global Options');
  addOpt('controller:' + ctrl.address, 'Controller: ' + (ctrl.name || ctrl.address));

  // Group devices by their modelKey (cameras, chimes, lights, sensors, viewers).
  const groups = {};

  for(const device of state.devices) {

    if(device.modelKey === 'nvr') {
      continue;
    }

    const groupKey = device.modelKey + 's';

    groups[groupKey] ||= [];
    groups[groupKey].push(device);
  }

  for(const [ groupKey, items ] of Object.entries(groups)) {

    if(!items.length) {
      continue;
    }

    const group = document.createElement('optgroup');

    group.label = MODEL_KEY_LABELS[groupKey] || groupKey;

    items.forEach(d => {

      const opt = document.createElement('option');

      opt.value = 'device:' + d.mac;
      opt.textContent = d.name || d.marketName || d.type;
      group.appendChild(opt);
    });

    select.appendChild(group);
  }
};

export const getCurrentScope = () => {


  const val = $('scopeSelect').value;

  if(val === 'global') {
    return { device: null, id: null, type: 'global' };
  }

  const colonIdx = val.indexOf(':');
  const type = val.substring(0, colonIdx);
  const id = val.substring(colonIdx + 1);

  if(type === 'controller') {


    return { device: null, id, type: 'controller' };
  }

  const device = state.devices.find(d => d.mac === id);

  return { device, id, type: 'device' };
};

export const updateCascade = (scopeType) => {


  const activeIdx = SCOPE_ORDER.indexOf(scopeType);
  const cascade = $('scopeCascade');

  if(!cascade) {
    return;
  }

  // Update scope levels.
  cascade.querySelectorAll('.scope-level').forEach(levelEl => {


    const level = levelEl.dataset.scope;
    const levelIdx = SCOPE_ORDER.indexOf(level);

    levelEl.classList.remove('active', 'inherited');

    if(levelIdx === activeIdx) {


      levelEl.classList.add('active');
    } else if(levelIdx < activeIdx) {


      levelEl.classList.add('inherited');
    }
  });

  // Update connectors: active if they connect inherited/active levels.
  cascade.querySelectorAll('.scope-connector').forEach((conn, i) => {


    conn.classList.toggle('active', i < activeIdx);
  });

  // Update hints based on active scope.
  const hints = {


    controller: [ 'Base values', 'Editing this scope', 'Inherits controller' ],
    device: [ 'Base values', 'Intermediate', 'Editing this scope' ],
    global: [ 'Editing this scope', 'Inherits global', 'Inherits global' ],
  };

  cascade.querySelectorAll('.scope-level').forEach((levelEl, i) => {


    const hint = levelEl.querySelector('.scope-hint');

    if(hint) {
      hint.textContent = hints[scopeType][i];
    }
  });
};
