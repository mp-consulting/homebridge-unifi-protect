export const state = {


  categories: [],
  currentControllerIndex: null,
  devices: [],
  editingIndex: null,
  openCategories: new Set(),
  options: {},
  pluginConfig: [],
};

export const getControllers = () => state.pluginConfig[0]?.controllers || [];

export const saveConfig = async () => {


  await homebridge.updatePluginConfig(state.pluginConfig);
  await homebridge.savePluginConfig();
};

export const saveConfigSilent = async () => {


  await homebridge.updatePluginConfig(state.pluginConfig);
};
