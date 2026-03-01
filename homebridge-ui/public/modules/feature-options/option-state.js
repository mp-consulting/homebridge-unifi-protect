/* option-state.js: Pure option state resolution logic (no DOM access). */
import { getControllers, state } from '../state.js';

const escapeRegex = (str) => str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const isOptionModified = (optionKey, scopeId) => {


  const configuredOptions = state.pluginConfig[0].options || [];
  const regex = scopeId ?
    new RegExp('^(Enable|Disable)\\.' + escapeRegex(optionKey) + '\\.' + escapeRegex(scopeId) + '(\\..*)?$', 'i') :
    new RegExp('^(Enable|Disable)\\.' + escapeRegex(optionKey) + '(?:\\.\\d+)?$', 'i');

  return configuredOptions.some(o => regex.test(o));
};

export const getOptionState = (optionKey, opt, scope) => {


  const configuredOptions = state.pluginConfig[0].options || [];
  const scopeId = scope.id;

  // Check current scope first.
  if(scopeId) {


    const regex = new RegExp('^(Enable|Disable)\\.' + escapeRegex(optionKey) + '\\.' + escapeRegex(scopeId) + '(?:\\.(\\d+))?$', 'i');

    for(const entry of configuredOptions) {


      const match = regex.exec(entry);

      if(match) {
        return { enabled: match[1].toLowerCase() === 'enable', explicit: true, scope: scope.type, value: match[2] };
      }
    }
  }

  // Check controller scope when viewing a device.
  if(scope.type === 'device') {


    const ctrl = getControllers()[state.currentControllerIndex];

    if(ctrl) {


      const regex = new RegExp('^(Enable|Disable)\\.' + escapeRegex(optionKey) + '\\.' + escapeRegex(ctrl.address) + '(?:\\.(\\d+))?$', 'i');

      for(const entry of configuredOptions) {


        const match = regex.exec(entry);

        if(match) {
          return { enabled: match[1].toLowerCase() === 'enable', explicit: false, scope: 'controller', value: match[2] };
        }
      }
    }
  }

  // Check global.
  const globalRegex = new RegExp('^(Enable|Disable)\\.' + escapeRegex(optionKey) + '(?:\\.(\\d+))?$', 'i');

  for(const entry of configuredOptions) {


    const match = globalRegex.exec(entry);

    if(match) {
      return { enabled: match[1].toLowerCase() === 'enable', explicit: scope.type === 'global', scope: 'global', value: match[2] };
    }
  }

  return { enabled: opt.default, explicit: false, scope: 'default' };
};

export const countModified = (categoryName, options, scope) => {


  let count = 0;

  for(const opt of options) {


    const optionKey = categoryName + (opt.name ? '.' + opt.name : '');

    if(isOptionModified(optionKey, scope.id)) {
      count++;
    }
  }

  return count;
};

export const countEnabled = (categoryName, options, scope) => {


  let count = 0;

  for(const opt of options) {


    const optionKey = categoryName + (opt.name ? '.' + opt.name : '');
    const optState = getOptionState(optionKey, opt, scope);

    if(optState.enabled) {
      count++;
    }
  }

  return count;
};
