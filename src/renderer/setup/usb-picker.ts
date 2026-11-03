/**
 * USB device picker page. Plain TypeScript, keyboard driven:
 * Up/Down (or Home/End) move, Enter selects, Esc cancels.
 */
import type { OpenTacUsbApi, UsbDevicePublic } from '../../shared/ipc.js';
import { moveSelection, usbDeviceDetail, usbDeviceTitle } from './view.js';

declare global {
  interface Window {
    openTacUsb: OpenTacUsbApi;
  }
}

const api: OpenTacUsbApi = window.openTacUsb;

function byId<T extends HTMLElement = HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (node === null) throw new Error(`Missing element #${id}`);
  return node as T;
}

const list = byId('usb-list');
const emptyNote = byId('usb-empty');
const selectBtn = byId<HTMLButtonElement>('usb-select');
const cancelBtn = byId<HTMLButtonElement>('usb-cancel');

let devices: UsbDevicePublic[] = [];
let selected = -1;
let selectedId: string | null = null;
let done = false;

function finish(deviceId: string | null): void {
  if (done) return;
  done = true;
  selectBtn.disabled = true;
  cancelBtn.disabled = true;
  api.choose(deviceId).catch(() => {
    done = false;
    cancelBtn.disabled = false;
    selectBtn.disabled = selected < 0;
  });
}

function paint(): void {
  const children = Array.from(list.children) as HTMLElement[];
  children.forEach((li, i) => {
    li.setAttribute('aria-selected', String(i === selected));
    li.id = `usb-item-${i}`;
  });
  const active = children[selected];
  if (active !== undefined) {
    list.setAttribute('aria-activedescendant', active.id);
    active.scrollIntoView({ block: 'nearest' });
  } else {
    list.removeAttribute('aria-activedescendant');
  }
  selectBtn.disabled = selected < 0 || done;
}

function setSelected(i: number): void {
  selected = i;
  selectedId = devices[i]?.deviceId ?? null;
  paint();
}

function renderDevices(next: UsbDevicePublic[]): void {
  devices = next;
  list.replaceChildren();
  next.forEach((d, i) => {
    const li = document.createElement('li');
    li.className = 'usb-item';
    li.setAttribute('role', 'option');
    const title = document.createElement('span');
    title.className = 'usb-item-title';
    title.textContent = usbDeviceTitle(d);
    const detail = document.createElement('span');
    detail.className = 'usb-item-detail';
    detail.textContent = usbDeviceDetail(d);
    li.append(title, detail);
    li.addEventListener('click', () => {
      setSelected(i);
    });
    li.addEventListener('dblclick', () => {
      setSelected(i);
      finish(d.deviceId);
    });
    list.append(li);
  });
  emptyNote.hidden = next.length > 0;
  list.hidden = next.length === 0;
  // Keep the same device selected across refreshes; otherwise select the first one.
  const keep = selectedId === null ? -1 : next.findIndex((d) => d.deviceId === selectedId);
  selected = keep >= 0 ? keep : next.length > 0 ? 0 : -1;
  selectedId = next[selected]?.deviceId ?? null;
  paint();
}

list.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'ArrowDown') setSelected(moveSelection(selected, 1, devices.length));
  else if (e.key === 'ArrowUp') setSelected(moveSelection(selected, -1, devices.length));
  else if (e.key === 'Home') setSelected(devices.length > 0 ? 0 : -1);
  else if (e.key === 'End') setSelected(devices.length - 1);
  else if (e.key === 'Enter') {
    if (selectedId !== null) finish(selectedId);
  } else return;
  e.preventDefault();
});

document.addEventListener('keydown', (e: KeyboardEvent) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    finish(null);
  }
});

selectBtn.addEventListener('click', () => {
  if (selectedId !== null) finish(selectedId);
});
cancelBtn.addEventListener('click', () => {
  finish(null);
});

renderDevices([]);
api.onDevices(renderDevices);
api
  .list()
  .then(renderDevices)
  .catch(() => {
    renderDevices([]);
  });
list.focus();
