'use strict';
// Hidden machines (config.hiddenNodes): infrastructure, not render nodes. The farm's own server
// (Farmly-Server) runs an updates agent only so Adobe's RemoteUpdateManager can report After Effects'
// newest version; Node-00 is a GPU-less box. They are kept off the lists, and the tracker must never act
// on them: no install, no uninstall, no restart, no shut-down, no wake. Every route that queues such an
// action for one machine asks refusal() first. Names compare by short hostname, any case.

const shortName = (h) => String(h || '').split('.')[0].toUpperCase();

function isHidden(hostname, hiddenList) {
  const k = shortName(hostname);
  return !!k && (hiddenList || []).some((h) => shortName(h) === k);
}

const VERB = {
  install: 'installs anything on', uninstall: 'uninstalls anything from', reboot: 'restarts', shutdown: 'shuts down',
  wake: 'wakes', retry: 'installs anything on',
};

// null when the action may go ahead; otherwise the words of the refusal (sent with a 403).
function refusal(node, action, hiddenList) {
  if (!node || !isHidden(node.hostname, hiddenList)) return null;
  return `${node.hostname} is a hidden infrastructure host (config.hiddenNodes), not a render node: the tracker never ${VERB[action] || 'acts on'} it.`;
}

module.exports = { isHidden, refusal, shortName };
