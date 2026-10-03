/* Copyright(C) 2017-2026, HJD (https://github.com/hjdhjd). All rights reserved.
 * Copyright(C) 2026, Mickael Palma / MP Consulting. All rights reserved.
 *
 * dom-helpers.js: DOM utility functions.
 */
import { SCREENS } from './constants.js';

export const $ = (id) => document.getElementById(id);

export const showScreen = (screenId) => {


  SCREENS.forEach((id) => {


    $(id).style.display = id === screenId ? 'block' : 'none';
  });
};

export const setButtonLoading = (btn, loading, loadingText = 'Loading...') => {


  if(loading) {


    btn.dataset.originalContent = btn.innerHTML;
    btn.disabled = true;

    btn.innerHTML = `<span class="spinner-border spinner-border-sm" aria-hidden="true"></span> ${loadingText}`;
  } else {


    btn.disabled = false;
    btn.innerHTML = btn.dataset.originalContent;
  }
};

export const escapeHtml = (str) => {


  const div = document.createElement('div');

  div.textContent = str;

  return div.innerHTML;
};

// Escape a value for safe interpolation into an HTML attribute (or text) context. Unlike escapeHtml(), this also escapes both quote characters so the value
// can't break out of a quoted attribute.
export const escapeAttr = (value) => String(value ?? '').replace(/[&<>"']/g, ch => ({ '"': '&quot;', '&': '&amp;', "'": '&#39;', '<': '&lt;', '>': '&gt;' })[ch]);

// Lightweight DOM element builder: el("div", { className: "foo" }, "text", childEl).
export const el = (tag, attrs, ...children) => {


  const element = document.createElement(tag);

  if(attrs) {

    for(const [ key, value ] of Object.entries(attrs)) {


      if(key === 'className') {

        element.className = value;
      } else if(key.startsWith('on')) {

        element.addEventListener(key.slice(2).toLowerCase(), value);
      } else {

        element.setAttribute(key, value);
      }
    }
  }

  for(const child of children) {


    if(typeof child === 'string') {

      element.appendChild(document.createTextNode(child));
    } else if(child) {

      element.appendChild(child);
    }
  }

  return element;
};
