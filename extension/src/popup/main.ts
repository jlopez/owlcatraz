import { renderPopup } from './Popup';

// Stamp the build version into the header badge. `version_name` carries the
// richer identity for preview builds (e.g. v1.4.0-3-gabc1234); fall back to the
// plain dotted `version`. The manifest is only available inside an extension
// runtime, so guard defensively — outside one the empty badge stays hidden.
const manifest = chrome?.runtime?.getManifest?.();
const label = manifest?.version_name ?? manifest?.version;
const versionEl = document.getElementById('version');
if (versionEl && label) {
  // build-identity already carries the `v` tag prefix; the plain version does
  // not — normalize so the pill always reads `v<…>`.
  versionEl.textContent = /^v/.test(label) ? label : `v${label}`;
}

renderPopup(document.getElementById('root'));
